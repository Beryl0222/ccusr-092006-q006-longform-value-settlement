// 应用服务：唯一的写入口。所有业务约束在这里收口，事件日志是唯一事实来源。
import {
  VALUE_SIGNAL_TYPES, REJECT_REASONS, ROLES,
  ADJUSTMENT_TYPES, ADJUSTMENT_STATUS, ACCOUNTS, EXCLUSION_REASONS,
} from "../domain/constants.js";
import { DomainError, isFuturePeriod, assertValidPeriod } from "../domain/time.js";
import { newId, stableHash, pseudonymizeViewer } from "../domain/hash.js";
import { sanitizeSignal } from "../domain/validation.js";
import { replay, ruleForPeriod, periodSlice } from "../domain/projection.js";
import { evaluatePeriod, canonicalJson } from "../domain/settlement.js";
import { Ledger } from "../domain/ledger.js";

// 简单的串行锁：同进程内所有写操作排队，避免并发下读到旧投影。
function mutex() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
}

export class SettlementService {
  constructor({ store, pepper, now = () => new Date() }) {
    if (!pepper || pepper.length < 16) throw new DomainError("去标识化盐值缺失或过短", "BAD_CONFIG");
    this.store = store;
    this.pepper = pepper;
    this.now = now;
    this._lock = mutex();
  }

  // ---------- 查询侧：随时重放 ----------
  state(upToSeq = Infinity) {
    return replay(this.store.events(), { upToSeq });
  }

  // ---------- 作品发布即冻结 ----------
  registerWork(input, { actor = ROLES.SYSTEM } = {}) {
    return this._lock(async () => {
      const state = this.state();
      const { work_id, title, creator_id, version, duration_sec } = input;
      for (const [k, v] of Object.entries({ work_id, title, creator_id, version })) {
        if (typeof v !== "string" || !v) throw new DomainError(`作品字段 ${k} 非法`, "INVALID_PAYLOAD");
      }
      if (!Number.isInteger(duration_sec) || duration_sec <= 0) {
        throw new DomainError("duration_sec 必须为正整数秒（冻结时长）", "INVALID_PAYLOAD");
      }
      if (state.works.has(work_id)) throw new DomainError(`作品已冻结发布: ${work_id}`, "WORK_EXISTS");
      const eligible = input.eligible_signals ?? [...VALUE_SIGNAL_TYPES];
      if (!Array.isArray(eligible) || eligible.length === 0) {
        throw new DomainError("适用信号清单不能为空", "INVALID_PAYLOAD");
      }
      for (const t of eligible) {
        if (!VALUE_SIGNAL_TYPES.includes(t)) throw new DomainError(`适用信号非法: ${t}`, "INVALID_PAYLOAD");
      }
      // 收藏后打开必然需要收藏事实，隐式纳入。
      const eligible_signals = [...new Set(eligible)].sort();
      const frozen_at = this.now().toISOString();
      const freeze_body = { work_id, title, creator_id, version, duration_sec, eligible_signals, frozen_at };
      const freeze_hash = stableHash(canonicalJson(freeze_body));
      const event = await this.store.append("WORK_REGISTERED", { ...freeze_body, freeze_hash }, {
        actor, idemKey: `work:${work_id}`, occurredAt: frozen_at,
      });
      return { event_id: event.event_id, work_id, freeze_hash, frozen_at };
    });
  }

  // ---------- 规则版本：只对新周期生效 ----------
  publishRule({ rule, effective_period }, { actor = ROLES.OPERATOR } = {}) {
    return this._lock(async () => {
      assertValidPeriod(effective_period);
      if (!isFuturePeriod(effective_period, this.now())) {
        throw new DomainError(`规则只能对尚未开始的周期生效: ${effective_period}`, "RULE_PERIOD_NOT_FUTURE");
      }
      validateRule(rule);
      const state = this.state();
      if (state.rulesByEffectivePeriod.has(effective_period)) {
        throw new DomainError(`周期 ${effective_period} 已有生效规则版本`, "RULE_EXISTS");
      }
      const published_at = this.now().toISOString();
      const event = await this.store.append("RULE_VERSION_PUBLISHED", {
        rule, effective_period, published_at,
      }, { actor, idemKey: `rule:${rule.rule_version}:${effective_period}`, occurredAt: published_at });
      return { event_id: event.event_id, rule_version: rule.rule_version, effective_period };
    });
  }

  // ---------- 周期开窗（含扶持资金池） ----------
  openPeriod({ period, fund_cents }, { actor = ROLES.FINANCE_ADMIN } = {}) {
    return this._lock(async () => {
      assertValidPeriod(period);
      if (!Number.isInteger(fund_cents) || fund_cents < 0) {
        throw new DomainError("fund_cents 必须为非负整数分", REJECT_REASONS.BAD_AMOUNT);
      }
      const state = this.state();
      if (state.periods.has(period)) throw new DomainError(`窗口已开启: ${period}`, "PERIOD_EXISTS");
      const opened_at = this.now().toISOString();
      const event = await this.store.append("PERIOD_OPENED", { period, fund_cents, opened_at }, {
        actor, idemKey: `period-open:${period}`, occurredAt: opened_at,
      });
      return { event_id: event.event_id, period, fund_cents };
    });
  }

  // ---------- 信号摄入：校验 → 归窗 → 去重 → 去标识化落盘 ----------
  ingestSignal(report, { idemKey = null } = {}) {
    return this._lock(async () => {
      const clean = sanitizeSignal(report, { pepper: this.pepper, now: this.now() });
      const state = this.state();

      const work = state.works.get(clean.work_id);
      if (!work) throw new DomainError(`作品不存在或未冻结: ${clean.work_id}`, REJECT_REASONS.UNKNOWN_WORK);

      const win = state.periods.get(clean.period);
      if (!win) throw new DomainError(`信号所属窗口尚未开启: ${clean.period}`, REJECT_REASONS.WINDOW_NOT_OPENED);
      if (win.status === "CLOSED") {
        throw new DomainError(`迟到数据：窗口 ${clean.period} 已封账，无法归入`, REJECT_REASONS.LATE_FOR_CLOSED_PERIOD, {
          closed_at: win.closed_at, signal_occurred_at: clean.occurred_at,
        });
      }

      // 收藏是收藏后打开的前置事实（允许在更早周期收藏）。
      if (clean.signal_type === "FAVORITE_OPEN") {
        const favKey = `${clean.work_id}|${clean.payload.viewer_h}`;
        if (!state.favoriteKeys.has(favKey)) {
          throw new DomainError("收藏后打开缺少收藏前置事实", REJECT_REASONS.PREREQUISITE_MISSING);
        }
        clean.payload.has_prerequisite_favorite = true;
      }

      // 业务去重键：同一业务事实只产生一个信号事件。
      const business_key = businessKeyOf(clean);
      for (const s of state.signals.values()) {
        if (s.business_key !== business_key) continue;
        // 携带同一幂等键的客户端重试：原样回放，不报错、不二次计值。
        if (idemKey && s.idem_key === idemKey) {
          return {
            event_id: s.event_id, signal_id: s.signal_id, period: s.period,
            work_id: s.work_id, signal_type: s.signal_type,
            viewer_h: s.viewer_h, business_key, replayed: true,
          };
        }
        throw new DomainError("重复上报：该业务事实已计入，不第二次贡献价值", REJECT_REASONS.DUPLICATE_REPORT, {
          existing_signal_id: s.signal_id, existing_event_id: s.event_id,
        });
      }

      const signal_id = newId("sig");
      const event = await this.store.append("VALUE_SIGNAL_INGESTED", {
        signal_id,
        work_id: clean.work_id,
        signal_type: clean.signal_type,
        occurred_at: clean.occurred_at,
        period: clean.period,
        payload: clean.payload,
        business_key,
      }, { idemKey: idemKey ?? `signal:${business_key}` });

      return {
        event_id: event.event_id, signal_id, period: clean.period,
        work_id: clean.work_id, signal_type: clean.signal_type,
        viewer_h: clean.payload.viewer_h, business_key,
      };
    });
  }

  // ---------- 同一控制关系申报 ----------
  declareControl({ group_id, creator_ids, viewer_tokens = [], viewer_hs = [], reason }, { actor = ROLES.OPERATOR } = {}) {
    return this._lock(async () => {
      const state = this.state();
      if (state.groups.has(group_id)) throw new DomainError(`控制关系已申报: ${group_id}`, "GROUP_EXISTS");
      if (!Array.isArray(creator_ids) || creator_ids.length === 0) {
        throw new DomainError("控制关系至少包含一个创作主体", "INVALID_PAYLOAD");
      }
      const vhs = new Set(viewer_hs);
      for (const tok of viewer_tokens) vhs.add(pseudonymizeViewer(tok, this.pepper));
      if (vhs.size === 0) throw new DomainError("控制关系至少包含一个受控观众标识", "INVALID_PAYLOAD");
      const payload = {
        group_id,
        creator_ids: [...new Set(creator_ids)].sort(),
        viewer_hs: [...vhs].sort(),
        reason: reason ?? null,
      };
      const event = await this.store.append("CONTROL_RELATION_DECLARED", payload, {
        actor, idemKey: `group:${group_id}`,
      });
      return { event_id: event.event_id, ...payload };
    });
  }

  // ---------- 风控/离线模型异常判定（证据随判定固化） ----------
  markAnomaly({ signal_id, reason = EXCLUSION_REASONS.ANOMALY_VERDICT, reason_label, evidence }, { actor = ROLES.SYSTEM } = {}) {
    return this._lock(async () => {
      const state = this.state();
      const sig = state.signals.get(signal_id);
      if (!sig) throw new DomainError(`信号不存在: ${signal_id}`, "UNKNOWN_SIGNAL");
      if (state.anomalies.has(signal_id)) throw new DomainError("该信号已有异常判定", "ANOMALY_EXISTS");
      const win = state.periods.get(sig.period);
      if (win?.status === "CLOSED") {
        throw new DomainError("窗口已封账，异常判定不能溯及既往（可发起申诉/人工修正）", "PERIOD_CLOSED");
      }
      if (!Object.values(EXCLUSION_REASONS).includes(reason)) {
        throw new DomainError(`排除原因码非法: ${reason}`, "INVALID_PAYLOAD");
      }
      const payload = {
        signal_id, work_id: sig.work_id, period: sig.period, reason,
        reason_label: reason_label ?? "风控/离线模型判定",
        evidence: evidence ?? {}, decided_at: this.now().toISOString(),
      };
      const event = await this.store.append("ANOMALY_EXCLUDED", payload, {
        actor, idemKey: `anomaly:${signal_id}`,
      });
      return { event_id: event.event_id, ...payload };
    });
  }

  // ---------- 封账 ----------
  closePeriod(period, { actor = ROLES.FINANCE_ADMIN } = {}) {
    return this._lock(async () => {
      assertValidPeriod(period);
      const state = this.state();
      const win = state.periods.get(period);
      if (!win) throw new DomainError(`窗口未开启: ${period}`, "PERIOD_NOT_OPEN");
      if (win.status === "CLOSED") return { skipped: true, closed_at: win.closed_at };
      const closed_at = this.now().toISOString();
      const event = await this.store.append("PERIOD_CLOSED", { period, closed_at }, {
        actor, idemKey: `period-close:${period}`, occurredAt: closed_at,
      });
      return { event_id: event.event_id, period, closed_at };
    });
  }

  // ---------- 封账后定稿结算单（可复算） ----------
  finalizeSettlement(period, { actor = ROLES.SYSTEM } = {}) {
    return this._lock(async () => {
      assertValidPeriod(period);
      let state = this.state();
      const existing = state.settlements.get(period);
      if (existing) return { skipped: true, calculation_hash: existing.calculation_hash };

      const win = state.periods.get(period);
      if (!win) throw new DomainError(`窗口未开启: ${period}`, "PERIOD_NOT_OPEN");
      if (win.status !== "CLOSED") throw new DomainError(`窗口尚未封账: ${period}`, "PERIOD_NOT_CLOSED");

      // 只取封账序号之前可见的事实——迟到事件永远进不来。
      const closeSeq = state.closeSeqByPeriod.get(period);
      state = this.state(closeSeq);
      const { signals, anomalies, groups } = periodSlice(state, period, { asOfSeq: closeSeq });
      const rule = ruleForPeriod(state, period);
      const freezeHashes = [...new Set(signals.map((s) => state.works.get(s.work_id)?.freeze_hash).filter(Boolean))];

      const result = evaluatePeriod({
        period,
        works: state.works,
        signals,
        anomalyExclusions: anomalies,
        groups,
        rule,
        fund_cents: win.fund_cents,
        freezeHashes,
      });

      // 复式记账：借 扶持支出 / 贷 创作者应付，每作品一张平衡凭证。
      const ledger = new Ledger();
      const ledger_transactions = [];
      for (const sheet of result.sheets) {
        const cents = sheet.allocation.final_cents;
        if (cents === 0) continue;
        const txn = ledger.post({
          date: win.closed_at,
          memo: `${period} 长内容扶持结算`,
          ref_event_id: null,
          idempotency_key: `settle:${period}:${sheet.work_id}`,
          legs: [
            { account: ACCOUNTS.PERIOD_EXPENSE(period), cents },
            { account: ACCOUNTS.PAYABLE(sheet.creator_id), cents: -cents },
          ],
        });
        ledger_transactions.push(txn);
      }
      if (!ledger.invariant()) throw new DomainError("结算凭证未通过守恒校验", "LEDGER_NOT_BALANCED");

      const settlement = {
        period,
        rule_version: rule.rule_version,
        fund_cents: win.fund_cents,
        totals: result.totals,
        sheets: result.sheets,
        calculation_hash: result.calculation_hash,
        verification: result.verification,
        finalized_at: this.now().toISOString(),
        as_of_close_seq: closeSeq,
      };

      // 每条排除单独留痕，便于按 signal_id 审计。
      for (const sheet of result.sheets) {
        for (const ex of sheet.exclusions) {
          await this.store.append("SIGNAL_EXCLUDED", {
            period, work_id: sheet.work_id, signal_id: ex.signal_id,
            reason: ex.reason, reason_label: ex.reason_label, evidence: ex.evidence,
            calculation_hash: result.calculation_hash,
          }, { actor, idemKey: `excluded:${period}:${ex.signal_id}` });
        }
      }

      const event = await this.store.append("SETTLEMENT_FINALIZED", {
        period, settlement, ledger_transactions,
      }, { actor, idemKey: `settlement:${period}` });
      return {
        event_id: event.event_id,
        period,
        calculation_hash: result.calculation_hash,
        totals: result.totals,
        ledger_transaction_count: ledger_transactions.length,
      };
    });
  }

  // ---------- 复算：按封账序号重放，比对定稿哈希 ----------
  reverify(period) {
    const state = this.state();
    const settled = state.settlements.get(period);
    if (!settled) throw new DomainError(`周期未定稿: ${period}`, "NOT_FINALIZED");
    const closeSeq = settled.as_of_close_seq;
    const replayed = this.state(closeSeq);
    const win = replayed.periods.get(period);
    const { signals, anomalies, groups } = periodSlice(replayed, period, { asOfSeq: closeSeq });
    const rule = ruleForPeriod(replayed, period);
    const freezeHashes = [...new Set(signals.map((s) => replayed.works.get(s.work_id)?.freeze_hash).filter(Boolean))];
    const result = evaluatePeriod({
      period, works: replayed.works, signals, anomalyExclusions: anomalies,
      groups, rule, fund_cents: win.fund_cents, freezeHashes,
    });
    return {
      period,
      stored_hash: settled.calculation_hash,
      recomputed_hash: result.calculation_hash,
      matches: settled.calculation_hash === result.calculation_hash,
    };
  }

  // ---------- 创作者结算单 ----------
  getStatement({ period, work_id }) {
    const state = this.state();
    const settled = state.settlements.get(period);
    if (!settled) throw new DomainError(`周期 ${period} 尚未出具结算单`, "NOT_FINALIZED");
    const sheet = settled.sheets.find((s) => s.work_id === work_id);
    if (!sheet) throw new DomainError(`结算单中无此作品: ${work_id}`, "UNKNOWN_WORK");
    const adjustments = [...state.adjustments.values()].filter(
      (a) => a.period === period && a.work_id === work_id && a.status === ADJUSTMENT_STATUS.APPROVED);
    const supplement = adjustments.filter((a) => a.type === ADJUSTMENT_TYPES.SUPPLEMENT).reduce((a, x) => a + x.cents, 0);
    const reversal = adjustments.filter((a) => a.type === ADJUSTMENT_TYPES.REVERSAL).reduce((a, x) => a + x.cents, 0);
    return {
      ...sheet,
      settlement_event_id: state.periods.get(period).settlement_event_id,
      calculation_hash: settled.calculation_hash,
      adjustments: adjustments.map((a) => ({
        adjustment_id: a.adjustment_id, type: a.type, cents: a.cents,
        reason: a.reason, appeal_id: a.appeal_id ?? null,
        requested_by: a.requested_by, reviewed_by: a.reviewed_by,
      })),
      net_payable_cents: sheet.allocation.final_cents + supplement - reversal,
      recompute: {
        rule_version: settled.rule_version,
        as_of_close_seq: settled.as_of_close_seq,
        input_event_ids: settled.verification.input_event_ids,
        calculation_hash: settled.calculation_hash,
      },
    };
  }

  // ---------- 申诉：原单保留，只追加 ----------
  fileAppeal({ period, work_id, creator_id, reasons, evidence_refs = [] }) {
    return this._lock(async () => {
      const state = this.state();
      if (!state.settlements.has(period)) throw new DomainError(`周期未定稿: ${period}`, "NOT_FINALIZED");
      const sheet = state.settlements.get(period).sheets.find((s) => s.work_id === work_id);
      if (!sheet) throw new DomainError("结算单中无此作品", "UNKNOWN_WORK");
      if (sheet.creator_id !== creator_id) throw new DomainError("仅作品作者可对该结算单申诉", "FORBIDDEN");
      if (!Array.isArray(reasons) || reasons.length === 0) {
        throw new DomainError("申诉需说明理由", "INVALID_PAYLOAD");
      }
      const appeal_id = newId("appeal");
      const event = await this.store.append("APPEAL_FILED", {
        appeal_id, period, work_id, creator_id, reasons, evidence_refs,
        // 原计算与反作弊证据的定位信息随申诉冻结；原结算单事件永不删除。
        original_settlement_event_id: state.periods.get(period).settlement_event_id,
        original_calculation_hash: state.settlements.get(period).calculation_hash,
        filed_at: this.now().toISOString(),
      }, { actor: creator_id, idemKey: `appeal:${period}:${work_id}:${stableHash(JSON.stringify(reasons)).slice(0, 12)}` });
      return { event_id: event.event_id, appeal_id };
    });
  }

  reviewAppeal({ appeal_id, decision, reviewer, reviewer_role, review_notes, adjustment }) {
    return this._lock(async () => {
      if (![ROLES.ARBITRATOR, ROLES.FINANCE_ADMIN].includes(reviewer_role)) {
        throw new DomainError("申诉复核须由仲裁或财务角色执行", "FORBIDDEN_ROLE");
      }
      if (!["UPHELD", "REJECTED"].includes(decision)) throw new DomainError("决定非法", "INVALID_PAYLOAD");
      const state = this.state();
      const appeal = state.appeals.get(appeal_id);
      if (!appeal) throw new DomainError(`申诉不存在: ${appeal_id}`, "UNKNOWN_APPEAL");
      if (appeal.status !== "OPEN") throw new DomainError("申诉已复核", "APPEAL_DECIDED");

      let adjustment_id = null;
      if (decision === "UPHELD") {
        if (!adjustment || ![ADJUSTMENT_TYPES.SUPPLEMENT, ADJUSTMENT_TYPES.REVERSAL].includes(adjustment.type)
          || !Number.isInteger(adjustment.cents) || adjustment.cents <= 0) {
          throw new DomainError("申诉成立须给出补结/撤销类型与正整数金额（分）", "INVALID_PAYLOAD");
        }
        // 仲裁人不能自己批钱：只转成一条待财务复核的修正请求。
        adjustment_id = await this._requestAdjustment({
          period: appeal.period, work_id: appeal.work_id,
          type: adjustment.type, cents: adjustment.cents,
          reason: `申诉 ${appeal_id} 成立：${review_notes ?? ""}`,
          requested_by: reviewer, requested_role: reviewer_role,
          appeal_id, state,
        });
      }
      const event = await this.store.append("APPEAL_REVIEWED", {
        appeal_id, decision, reviewer, reviewer_role,
        review_notes: review_notes ?? null, adjustment_id, reviewed_at: this.now().toISOString(),
      }, { actor: reviewer, idemKey: `appeal-review:${appeal_id}` });
      return { event_id: event.event_id, appeal_id, decision, adjustment_id };
    });
  }

  // ---------- 人工修正：职责分离，双人复核 ----------
  requestAdjustment(input, { actor, actor_role = ROLES.OPERATOR }) {
    return this._lock(async () => {
      if (actor_role !== ROLES.OPERATOR) throw new DomainError("仅运营可发起人工修正", "FORBIDDEN_ROLE");
      const adjustment_id = await this._requestAdjustment({
        ...input, requested_by: actor, requested_role: actor_role,
        appeal_id: input.appeal_id ?? null, state: this.state(),
      });
      return { adjustment_id };
    });
  }

  async _requestAdjustment({ period, work_id, type, cents, reason, requested_by, requested_role, appeal_id, state }) {
    assertValidPeriod(period);
    if (![ADJUSTMENT_TYPES.SUPPLEMENT, ADJUSTMENT_TYPES.REVERSAL].includes(type)) {
      throw new DomainError("修正类型非法", "INVALID_PAYLOAD");
    }
    if (!Number.isInteger(cents) || cents <= 0) throw new DomainError("修正金额须为正整数分", "INVALID_PAYLOAD");
    if (typeof reason !== "string" || !reason) throw new DomainError("修正须写明原因", "INVALID_PAYLOAD");
    if (!state.settlements.has(period)) throw new DomainError("只能对已定稿周期发起修正", "NOT_FINALIZED");
    const sheet = state.settlements.get(period).sheets.find((s) => s.work_id === work_id);
    if (!sheet) throw new DomainError("结算单中无此作品", "UNKNOWN_WORK");
    if (type === ADJUSTMENT_TYPES.REVERSAL) {
      const approvedSoFar = [...state.adjustments.values()]
        .filter((a) => a.work_id === work_id && a.period === period && a.type === ADJUSTMENT_TYPES.REVERSAL && a.status === "APPROVED")
        .reduce((a, x) => a + x.cents, 0);
      const pending = [...state.adjustments.values()]
        .filter((a) => a.work_id === work_id && a.period === period && a.type === ADJUSTMENT_TYPES.REVERSAL && a.status === ADJUSTMENT_STATUS.PENDING)
        .reduce((a, x) => a + x.cents, 0);
      if (approvedSoFar + pending + cents > sheet.allocation.final_cents) {
        throw new DomainError("撤销累计不得超过原结算金额（总账守恒约束）", "OVER_REVERSAL");
      }
    }
    const adjustment_id = newId("adj");
    const request = {
      adjustment_id, period, work_id, creator_id: sheet.creator_id,
      type, cents, reason, appeal_id: appeal_id ?? null,
      status: ADJUSTMENT_STATUS.PENDING,
      requested_by, requested_role,
      original_settlement_event_id: state.periods.get(period).settlement_event_id,
      original_calculation_hash: state.settlements.get(period).calculation_hash,
      requested_at: this.now().toISOString(),
    };
    const event = await this.store.append("ADJUSTMENT_REQUESTED", { adjustment_id, adjustment: request }, {
      actor: requested_by, idemKey: `adj-req:${adjustment_id}`,
    });
    return adjustment_id;
  }

  approveAdjustment({ adjustment_id, approved, reviewer, reviewer_role, review_notes }, { actor = reviewer } = {}) {
    return this._lock(async () => {
      if (reviewer_role !== ROLES.FINANCE_ADMIN) {
        throw new DomainError("人工修正须由财务角色复核（与发起人不同角色）", "FORBIDDEN_ROLE");
      }
      const state = this.state();
      // 待复核请求记录在 ADJUSTMENT_REQUESTED 事件里，投影到 pendingAdjustments。
      const pending = state.pendingAdjustments.get(adjustment_id);
      if (!pending) throw new DomainError(`待复核修正不存在: ${adjustment_id}`, "UNKNOWN_ADJUSTMENT");
      if (pending.requested_by === reviewer) {
        throw new DomainError("发起人与复核人不得为同一人", "SEGREGATION_OF_DUTIES");
      }

      if (!approved) {
        const rejected = { ...pending, status: ADJUSTMENT_STATUS.REJECTED, reviewed_by: reviewer, review_notes: review_notes ?? null, reviewed_at: this.now().toISOString() };
        await this.store.append("ADJUSTMENT_APPROVED", { adjustment_id, adjustment: rejected, approved: false }, {
          actor, idemKey: `adj-decide:${adjustment_id}`,
        });
        return { adjustment_id, status: ADJUSTMENT_STATUS.REJECTED };
      }

      // 批准即入账：平衡凭证，撤销/补结都保持总账守恒。
      const ledger = new Ledger();
      const legs = pending.type === ADJUSTMENT_TYPES.SUPPLEMENT
        ? [
            { account: ACCOUNTS.PERIOD_EXPENSE(pending.period), cents: pending.cents },
            { account: ACCOUNTS.PAYABLE(pending.creator_id), cents: -pending.cents },
          ]
        : [
            { account: ACCOUNTS.PAYABLE(pending.creator_id), cents: pending.cents },
            { account: ACCOUNTS.PERIOD_EXPENSE(pending.period), cents: -pending.cents },
          ];
      const ledger_transaction = ledger.post({
        date: this.now().toISOString(),
        memo: `${pending.period} ${pending.type === ADJUSTMENT_TYPES.SUPPLEMENT ? "补结" : "撤销"}：${pending.reason}`,
        idempotency_key: `adj-post:${adjustment_id}`,
        legs,
      });
      if (!ledger.invariant()) throw new DomainError("修正凭证未通过守恒校验", "LEDGER_NOT_BALANCED");

      const approved1 = {
        ...pending, status: ADJUSTMENT_STATUS.APPROVED,
        reviewed_by: reviewer, review_notes: review_notes ?? null, reviewed_at: this.now().toISOString(),
        ledger_transaction,
      };
      await this.store.append("ADJUSTMENT_APPROVED", { adjustment_id, adjustment: approved1, approved: true }, {
        actor, idemKey: `adj-decide:${adjustment_id}`,
      });
      const posted = await this.store.append("ADJUSTMENT_POSTED", {
        adjustment_id, adjustment: approved1,
      }, { actor, idemKey: `adj-post-event:${adjustment_id}` });

      return { adjustment_id, status: ADJUSTMENT_STATUS.APPROVED, ledger_transaction };
    });
  }

  // ---------- 总账视图 ----------
  ledgerReport() {
    const state = this.state();
    const ledger = new Ledger();
    for (const txn of state.ledgerTxns) {
      ledger.post({ date: txn.date, memo: txn.memo, legs: txn.legs, idempotency_key: txn.idempotency_key });
    }
    return {
      balanced: ledger.invariant(),
      accounts: [...ledger.balances.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      transaction_count: ledger.transactions.length,
    };
  }
}

// ---------- 辅助 ----------
function businessKeyOf(clean) {
  const p = clean.payload;
  const w = clean.work_id;
  const v = p.viewer_h;
  switch (clean.signal_type) {
    case "PLAY_PROGRESS": return `${w}|${v}|PLAY|${p.play_id}`;
    case "FAVORITED": return `${w}|${v}|FAV`;
    case "FAVORITE_OPEN": return `${w}|${v}|OPEN|${p.open_id}`;
    case "VALID_DISCUSSION": return `${w}|DISC|${p.discussion_id}`;
    case "REFUND": return `${w}|REFUND|${p.order_id}`;
    case "CROSS_DAY_REVISIT": return `${w}|${v}|REVISIT|${clean.period}`;
    default: throw new DomainError("未知信号类型", "BAD_SIGNAL_TYPE");
  }
}

function validateRule(rule) {
  const need = ["rule_version", "weights", "completion_threshold"];
  for (const k of need) if (rule[k] === undefined) throw new DomainError(`规则缺少 ${k}`, "INVALID_PAYLOAD");
  const w = rule.weights;
  for (const k of ["completed_view_cents", "favorite_open_cents", "discussion_cents", "refund_penalty_cents", "cross_day_revisit_cents"]) {
    if (!Number.isInteger(w[k]) || w[k] < 0) throw new DomainError(`权重 ${k} 须为非负整数`, "INVALID_PAYLOAD");
  }
  const t = Number(rule.completion_threshold);
  if (!(t > 0 && t <= 1)) throw new DomainError("completion_threshold 须在 (0,1]", "INVALID_PAYLOAD");
}

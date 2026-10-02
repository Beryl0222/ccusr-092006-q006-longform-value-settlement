// 应用服务：唯一允许写入事件日志的编排层。
//
// 职责对应业务约束：
// - 作品发布冻结版本/时长/作者关系/适用信号（不可覆盖）；
// - 规则只从新周期起生效（发布时校验）；
// - 信号事件始终如实落账，采信或排除由台账投影决定（可复算、可审计）；
// - 结算对 (周期,作品) 幂等，重复结算不产生第二份价值；
// - 申诉冻结“当时的结算单 + 反作弊证据 + 日志头哈希”，后续翻案不改写历史；
// - 人工修正：运营(OPERATOR)提议、财务(FINANCE)复核，且两人不能相同；
// - 撤销/补结都以 ADJUSTMENT_APPROVED 过账，复式分录天然守恒。
import { computeStatement } from "./engine.js";
import { RuleBook } from "./rules.js";
import { PeriodCalendar } from "./periods.js";
import { validateWorkRegistration } from "./work_registry.js";
import { shortHash } from "./hash.js";

export const ROLES = Object.freeze({
  OPERATOR: "OPERATOR", // 运营：可提议修正，不能自批
  FINANCE: "FINANCE", // 财务：封账、复核修正
  CREATOR: "CREATOR", // 创作者：查看结算单、发起申诉
});

export class ServiceError extends Error {}

let seq = 0;
function newId(prefix) {
  seq += 1;
  return `${prefix}_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${seq.toString(36)}${shortHash(`${prefix}${seq}${Date.now()}`, 4)}`;
}

export class SettlementService {
  /** @param {import('./event_log.js').EventLog} log */
  constructor(log) {
    this.log = log;
  }

  // ---------- 作品发布（冻结） ----------
  registerWork(payload, { now = new Date().toISOString() } = {}) {
    const problems = validateWorkRegistration(payload);
    if (problems.length) throw new ServiceError(problems.join("；"));
    if (this.log.events.some((e) => e.kind === "WORK_REGISTERED" && e.payload.work_id === payload.work_id)) {
      throw new ServiceError(`作品 ${payload.work_id} 已冻结登记，发布信息不可覆盖`);
    }
    return this.log.append(
      {
        event_id: newId("evt-work"),
        kind: "WORK_REGISTERED",
        occurred_at: payload.published_at ?? now,
        subject_id: payload.work_id,
        payload: { ...payload, frozen_at: now },
      },
      { now },
    );
  }

  // ---------- 规则版本 ----------
  publishRule(rule, { now = new Date().toISOString() } = {}) {
    const calendar = new PeriodCalendar(this.log.events);
    const problems = RuleBook.validateEffective(rule, calendar, now);
    if (problems.length) throw new ServiceError(problems.join("；"));
    if (this.log.events.some((e) => e.kind === "RULE_PUBLISHED" && e.payload.rule_id === rule.rule_id)) {
      throw new ServiceError(`规则 ${rule.rule_id} 已发布`);
    }
    return this.log.append(
      { event_id: newId("evt-rule"), kind: "RULE_PUBLISHED", occurred_at: now, subject_id: rule.rule_id, payload: rule },
      { now },
    );
  }

  // ---------- 周期窗口 ----------
  openPeriod(period, { now = new Date().toISOString() } = {}) {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new ServiceError("周期格式应为 YYYY-MM");
    if (this.log.events.some((e) => e.kind === "PERIOD_OPENED" && e.payload.period === period)) {
      throw new ServiceError(`周期 ${period} 窗口已打开`);
    }
    return this.log.append(
      { event_id: newId("evt-open"), kind: "PERIOD_OPENED", occurred_at: now, subject_id: `period:${period}`, payload: { period, opened_at: now } },
      { now },
    );
  }

  closePeriod(period, actor, { now = new Date().toISOString() } = {}) {
    assertRole(actor, ROLES.FINANCE);
    const calendar = new PeriodCalendar(this.log.events);
    if (calendar.status(period) !== "OPEN") throw new ServiceError(`周期 ${period} 未开窗或已封账`);
    return this.log.append(
      { event_id: newId("evt-close"), kind: "PERIOD_CLOSED", occurred_at: now, subject_id: `period:${period}`, payload: { period, closed_at: now, closed_by: actor.actor_id } },
      { now },
    );
  }

  // ---------- 信号与反作弊输入 ----------
  /** 上报去标识化信号。事件永远落账；是否采信由台账投影可复算地给出。 */
  ingestSignal(payload, { now = new Date().toISOString() } = {}) {
    for (const f of ["work_id", "signal_type", "occurred_at"]) {
      if (payload[f] === undefined) throw new ServiceError(`信号缺少字段: ${f}`);
    }
    if (!payload.viewer_key && payload.signal_type !== "MEANINGFUL_DISCUSSION") {
      throw new ServiceError("信号必须携带去标识化 viewer_key");
    }
    if (payload.signal_type === "MEANINGFUL_DISCUSSION" && !payload.discussion_id) {
      throw new ServiceError("有效讨论信号必须携带 discussion_id（自然键去重）");
    }
    if (payload.signal_type === "FAVORITE_THEN_OPEN" && !payload.favorite_id) {
      throw new ServiceError("收藏后打开信号必须携带 favorite_id（自然键去重）");
    }
    return this.log.append(
      { event_id: newId("evt-sig"), kind: "VALUE_SIGNAL", occurred_at: now, subject_id: payload.work_id, payload },
      { now },
    );
  }

  declareControlLink(payload, { now = new Date().toISOString() } = {}) {
    if (!Array.isArray(payload.entities) || payload.entities.length < 2) {
      throw new ServiceError("控制关系声明至少需要两个伪标识实体");
    }
    return this.log.append(
      { event_id: newId("evt-ctrl"), kind: "CONTROL_LINK_DECLARED", occurred_at: now, subject_id: `control:${shortHash(payload.entities.join("|"), 8)}`, payload },
      { now },
    );
  }

  recordRefund(payload, { now = new Date().toISOString() } = {}) {
    for (const f of ["work_id", "refund_id", "occurred_at"]) {
      if (payload[f] === undefined) throw new ServiceError(`退款缺少字段: ${f}`);
    }
    return this.log.append(
      { event_id: newId("evt-ref"), kind: "REFUND_RECORDED", occurred_at: now, subject_id: payload.work_id, payload },
      { now },
    );
  }

  // ---------- 结算（幂等） ----------
  settleWork(period, workId, actor, { now = new Date().toISOString() } = {}) {
    assertRole(actor, ROLES.FINANCE);
    const existing = this.log.events.find(
      (e) => e.kind === "SETTLEMENT_RECORDED" && e.payload.target_period === period && e.payload.work_id === workId,
    );
    if (existing) {
      return { event: existing, duplicated: true, note: "该周期作品已结算，重复请求不产生第二份价值；如需修正请走人工撤销/补结" };
    }
    // 必须先封账再结算：封账冻结全部信号输入，结算才可过账；
    // 封账后的任何变化只能以人工撤销/补结体现，保证已过账金额与结算单永远一致。
    const calendar = new PeriodCalendar(this.log.events);
    if (calendar.status(period) !== "CLOSED") {
      throw new ServiceError(`周期 ${period} 尚未封账：请先由财务封账冻结输入，再出具结算`);
    }
    const stmt = computeStatement(this.log.events, { period, workId });
    const event = this.log.append(
      {
        event_id: newId("evt-settle"),
        kind: "SETTLEMENT_RECORDED",
        occurred_at: now,
        subject_id: workId,
        payload: {
          settlement_id: stmt.statement_id,
          target_period: period,
          work_id: workId,
          author_id: stmt.work.author_id,
          gross_points: stmt.summary.gross_points,
          refund_points: stmt.summary.refund_points,
          adjustment_points: stmt.summary.adjustment_points,
          net_points: stmt.summary.net_points,
          rule_id: stmt.rule.rule_id,
          input_hash: stmt.input_hash,
        },
      },
      { now },
    );
    return { event, duplicated: false, statement: stmt };
  }

  // ---------- 申诉（冻结原计算与证据） ----------
  fileAppeal({ period, workId, by, reason }, { now = new Date().toISOString() } = {}) {
    assertRole(by, ROLES.CREATOR);
    const stmt = computeStatement(this.log.events, { period, workId });
    if (stmt.work.author_id !== by.actor_id) {
      throw new ServiceError("只能对自己名下作品发起申诉");
    }
    const appealId = newId("appeal");
    // 冻结：结算单全文、逐条采信/排除证据、日志头哈希——日后日志变化也能对出“当时算的是什么”
    const snapshot = {
      statement: stmt,
      log_head_hash: this.log.headHash(),
      frozen_at: now,
    };
    const event = this.log.append(
      {
        event_id: newId("evt-appeal"),
        kind: "APPEAL_FILED",
        occurred_at: now,
        subject_id: workId,
        payload: { appeal_id: appealId, target_period: period, work_id: workId, reason, appellant: by.actor_id, snapshot },
      },
      { now },
    );
    return { event, appeal_id: appealId, snapshot };
  }

  getAppealSnapshot(appealId) {
    const e = this.log.events.find((x) => x.kind === "APPEAL_FILED" && x.payload.appeal_id === appealId);
    return e ? e.payload.snapshot : null;
  }

  // ---------- 人工修正（maker/checker） ----------
  proposeAdjustment({ period, workId, kind, delta_points, reason, by, appeal_id = null }, { now = new Date().toISOString() } = {}) {
    assertRole(by, ROLES.OPERATOR);
    if (!["REVERSAL", "TOPUP"].includes(kind)) throw new ServiceError("修正类型必须是 REVERSAL（撤销）或 TOPUP（补结）");
    if (typeof delta_points !== "number" || delta_points <= 0) throw new ServiceError("delta_points 必须为正数；撤销/补结方向由 kind 决定");
    const work = this.log.events.find((e) => e.kind === "WORK_REGISTERED" && e.payload.work_id === workId);
    if (!work) throw new ServiceError(`作品 ${workId} 不存在`);
    // 撤销/补结只能落在已封账窗口之后（针对历史账），或对已结算记录做修正
    const adjustmentId = newId("adj");
    const signed = kind === "REVERSAL" ? -delta_points : delta_points;
    const event = this.log.append(
      {
        event_id: newId("evt-adjprop"),
        kind: "ADJUSTMENT_PROPOSED",
        occurred_at: now,
        subject_id: workId,
        payload: {
          adjustment_id: adjustmentId,
          target_period: period,
          work_id: workId,
          author_id: work.payload.author_id,
          kind,
          delta_points: signed,
          reason,
          appeal_id,
          proposed_by: by.actor_id,
          proposed_at: now,
          status: "PENDING",
        },
      },
      { now },
    );
    return { event, adjustment_id: adjustmentId };
  }

  _findPendingAdjustment(adjustmentId) {
    const proposed = this.log.events.find(
      (e) => e.kind === "ADJUSTMENT_PROPOSED" && e.payload.adjustment_id === adjustmentId,
    );
    if (!proposed) throw new ServiceError(`修正单 ${adjustmentId} 不存在`);
    const decided = this.log.events.some(
      (e) => ["ADJUSTMENT_APPROVED", "ADJUSTMENT_REJECTED"].includes(e.kind) && e.payload.adjustment_id === adjustmentId,
    );
    if (decided) throw new ServiceError(`修正单 ${adjustmentId} 已复核，不可重复决定`);
    return proposed;
  }

  approveAdjustment(adjustmentId, by, { now = new Date().toISOString() } = {}) {
    assertRole(by, ROLES.FINANCE); // 财务复核
    const proposed = this._findPendingAdjustment(adjustmentId);
    if (proposed.payload.proposed_by === by.actor_id) {
      throw new ServiceError("maker/checker 分离：复核人不能与提议人为同一人");
    }
    const p = proposed.payload;
    return this.log.append(
      {
        event_id: newId("evt-adjapp"),
        kind: "ADJUSTMENT_APPROVED",
        occurred_at: now,
        subject_id: p.work_id,
        payload: {
          adjustment_id: adjustmentId,
          target_period: p.target_period,
          work_id: p.work_id,
          author_id: p.author_id,
          kind: p.kind,
          delta_points: p.delta_points, // 带符号：撤销为负、补结为正
          reason: p.reason,
          appeal_id: p.appeal_id,
          proposed_by: p.proposed_by,
          approved_by: by.actor_id,
          approved_at: now,
        },
      },
      { now },
    );
  }

  rejectAdjustment(adjustmentId, by, { reason = "", now = new Date().toISOString() } = {}) {
    assertRole(by, ROLES.FINANCE);
    const proposed = this._findPendingAdjustment(adjustmentId);
    if (proposed.payload.proposed_by === by.actor_id) throw new ServiceError("maker/checker 分离：复核人不能与提议人为同一人");
    return this.log.append(
      {
        event_id: newId("evt-adjrej"),
        kind: "ADJUSTMENT_REJECTED",
        occurred_at: now,
        subject_id: proposed.payload.work_id,
        payload: { adjustment_id: adjustmentId, rejected_by: by.actor_id, rejected_at: now, reason },
      },
      { now },
    );
  }
}

function assertRole(actor, role) {
  if (!actor || actor.role !== role) {
    throw new ServiceError(`该操作要求角色 ${role}，当前为 ${actor?.role ?? "未认证"}`);
  }
}

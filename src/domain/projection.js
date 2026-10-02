// 事件投影：把只追加事件日志折叠成当前读模型。
// upToSeq 用于“按封账时刻重算”——只折叠封账序号之前的事件，
// 保证申诉/审计时拿到的输入与定稿时逐字节一致。
import { RULE_V1 } from "./settlement.js";

export function replay(events, { upToSeq = Infinity } = {}) {
  const state = {
    works: new Map(), // work_id -> 冻结作品
    ruleVersions: new Map(), // rule_version -> 规则
    rulesByEffectivePeriod: new Map(), // effective_period -> rule
    periods: new Map(), // period -> {period, fund_cents, status, opened_at, closed_at, final_seq, settlement}
    signals: new Map(), // signal_id -> 信号（含 event_id、seq、dedup_key、business_key）
    favoriteKeys: new Set(), // `${work_id}|${viewer_h}` 已收藏
    groups: new Map(), // group_id -> {group_id, creator_ids:Set, viewer_hs:Set, event_id}
    anomalies: new Map(), // signal_id -> 排除决定（只保留封账序号前的）
    settlements: new Map(), // period -> 定稿结算单
    appeals: new Map(), // appeal_id
    adjustments: new Map(), // adjustment_id（含 APPROVED/REJECTED 终态）
    pendingAdjustments: new Map(), // adjustment_id -> 待财务复核的请求
    ledgerTxns: [], // 定稿/调整产生的平衡分录
    closeSeqByPeriod: new Map(),
  };

  for (const e of events) {
    if (e.seq > upToSeq) break;
    const p = e.payload ?? {};
    switch (e.kind) {
      case "WORK_REGISTERED":
        state.works.set(p.work_id, { ...p, event_id: e.event_id });
        break;
      case "RULE_VERSION_PUBLISHED":
        state.ruleVersions.set(p.rule.rule_version, p.rule);
        state.rulesByEffectivePeriod.set(p.effective_period, p.rule);
        break;
      case "PERIOD_OPENED":
        state.periods.set(p.period, {
          period: p.period, fund_cents: p.fund_cents, status: "OPEN",
          opened_at: e.occurred_at, opened_by: e.actor,
        });
        break;
      case "VALUE_SIGNAL_INGESTED": {
        const sig = {
          signal_id: p.signal_id,
          event_id: e.event_id,
          seq: e.seq,
          work_id: p.work_id,
          signal_type: p.signal_type,
          occurred_at: p.occurred_at,
          period: p.period,
          viewer_h: p.payload.viewer_h,
          payload: p.payload,
          dedup_key: p.dedup_key ?? null,
          business_key: p.business_key ?? null,
          idem_key: e.idem_key ?? null,
        };
        state.signals.set(p.signal_id, sig);
        if (p.signal_type === "FAVORITED") state.favoriteKeys.add(`${p.work_id}|${p.payload.viewer_h}`);
        break;
      }
      case "CONTROL_RELATION_DECLARED":
        state.groups.set(p.group_id, {
          group_id: p.group_id,
          creator_ids: new Set(p.creator_ids),
          viewer_hs: new Set(p.viewer_hs),
          event_id: e.event_id, declared_at: e.occurred_at, declared_seq: e.seq,
        });
        break;
      case "ANOMALY_EXCLUDED":
        state.anomalies.set(p.signal_id, {
          reason: p.reason,
          reason_label: p.reason_label,
          evidence: p.evidence ?? {},
          decided_by: e.actor,
          event_id: e.event_id,
          decided_seq: e.seq,
        });
        break;
      case "PERIOD_CLOSED":
        if (state.periods.has(p.period)) {
          Object.assign(state.periods.get(p.period), {
            status: "CLOSED", closed_at: e.occurred_at,
            closed_by: e.actor, final_seq: e.seq,
          });
          state.closeSeqByPeriod.set(p.period, e.seq);
        }
        break;
      case "SETTLEMENT_FINALIZED":
        state.settlements.set(p.period, p.settlement);
        if (state.periods.has(p.period)) {
          state.periods.get(p.period).settlement = p.settlement;
          state.periods.get(p.period).settlement_event_id = e.event_id;
        }
        state.ledgerTxns.push(...(p.ledger_transactions ?? []));
        break;
      case "APPEAL_FILED":
        state.appeals.set(p.appeal_id, { ...p, status: "OPEN", filed_event_id: e.event_id });
        break;
      case "APPEAL_REVIEWED":
        if (state.appeals.has(p.appeal_id)) {
          Object.assign(state.appeals.get(p.appeal_id), {
            status: "DECIDED", decision: p.decision, reviewer: p.reviewer,
            review_notes: p.review_notes, reviewed_at: e.occurred_at,
            adjustment_id: p.adjustment_id ?? null,
          });
        }
        break;
      case "ADJUSTMENT_REQUESTED":
        state.pendingAdjustments.set(p.adjustment_id, p.adjustment);
        break;
      case "ADJUSTMENT_APPROVED":
        state.pendingAdjustments.delete(p.adjustment_id);
        state.adjustments.set(p.adjustment_id, p.adjustment);
        break;
      case "ADJUSTMENT_POSTED":
        state.adjustments.set(p.adjustment.adjustment_id, p.adjustment);
        state.ledgerTxns.push(p.adjustment.ledger_transaction);
        break;
      default:
        break;
    }
  }
  return state;
}

// 取某周期适用的规则：effective_period <= period 的最新版本；没有则用内置 V1。
export function ruleForPeriod(state, period) {
  const keys = [...state.rulesByEffectivePeriod.keys()].filter((k) => k <= period).sort();
  return keys.length ? state.rulesByEffectivePeriod.get(keys[keys.length - 1]) : RULE_V1;
}

// 某周期封账时刻（seq 截止）可见的信号与排除。
export function periodSlice(state, period, { asOfSeq = Infinity } = {}) {
  const signals = [...state.signals.values()]
    .filter((s) => s.period === period && s.seq <= asOfSeq);
  const anomalies = new Map();
  for (const s of signals) {
    const a = state.anomalies.get(s.signal_id);
    if (a && a.decided_seq <= asOfSeq) anomalies.set(s.signal_id, a);
  }
  // 封账时刻已申报的控制关系才作为输入；之后申报的不溯及既往。
  const groups = new Map([...state.groups].filter(([, g]) => g.declared_seq <= asOfSeq));
  return { signals, anomalies, groups };
}

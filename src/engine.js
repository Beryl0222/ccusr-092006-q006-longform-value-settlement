// 结算引擎：把事件日志 + 台账投影成某周期的可复算结算单。
//
// 关键性质：
// 1. 纯确定性：同样的事件日志永远算出同样的分数与同样的 input_hash；
// 2. 幂等：结算不依赖上一次结算结果，重复执行不产生第二份价值；
// 3. 可解释：每一分价值对应具体信号，每一笔排除对应中文原因与证据；
// 4. 去标识化：结算单上的观众只出现掩码伪标识。
import { sha256, shortHash, stableStringify } from "./hash.js";
import { buildLedger, naturalKey as naturalKeyOf } from "./ledger.js";
import { RuleBook } from "./rules.js";
import { SIGNAL_TYPES } from "./longform_value_settlement.js";

export const SIGNAL_LABELS = Object.freeze({
  CROSS_DAY_COMPLETION: "跨日看完",
  FAVORITE_THEN_OPEN: "收藏后回访打开",
  MEANINGFUL_DISCUSSION: "有效讨论",
  CROSS_DAY_REVISIT: "跨日回访",
  COMPLETION: "完播（对照项）",
});

/** 去标识化展示：只留伪标识前 4 位，结算单不暴露完整伪标识。 */
export function maskViewer(key) {
  if (!key) return "匿名";
  return `${String(key).slice(0, 4)}**`;
}

/**
 * 计算一个周期内某作品的结算单（纯函数）。
 * @param {Array<object>} events 完整事件日志
 * @param {{period:string, workId:string}} ctx
 */
export function computeStatement(events, ctx) {
  const { period, workId } = ctx;
  const rules = new RuleBook(events);
  const rule = rules.forPeriod(period);
  const ledger = buildLedger(events, { ruleForPeriod: (p) => rules.forPeriod(p) });

  const work = ledger.works.get(workId);
  if (!work) throw new Error(`作品 ${workId} 未冻结登记，无法结算`);

  const signals = ledger.accepted
    .filter((s) => s.period === period && s.work_id === workId)
    .sort((a, b) => (a.event_id < b.event_id ? -1 : 1));
  const exclusions = ledger.excluded
    .filter((x) => x.period === period && x.event.payload?.work_id === workId)
    .sort((a, b) => (a.event.event_id < b.event.event_id ? -1 : 1));
  const refunds = ledger.refunds.filter((r) => r.period === period && r.work_id === workId);

  // 已批准的人工调整（撤销/补结），按目标周期与作品归集
  const adjustments = events
    .filter((e) => e.kind === "ADJUSTMENT_APPROVED")
    .filter((e) => e.payload.target_period === period && e.payload.work_id === workId)
    .map((e) => e.payload);

  // 逐信号计分
  const byType = new Map();
  const contributions = [];
  let grossPoints = 0;
  for (const s of signals) {
    const weight = rule.weights[s.signal_type] ?? 0;
    const points = weight * signalQuantity(s);
    grossPoints += points;
    if (!byType.has(s.signal_type)) {
      byType.set(s.signal_type, { signal_type: s.signal_type, label: SIGNAL_LABELS[s.signal_type] ?? s.signal_type, weight, count: 0, points: 0 });
    }
    const bucket = byType.get(s.signal_type);
    bucket.count += 1;
    bucket.points += points;
    contributions.push({
      event_id: s.event_id,
      signal_type: s.signal_type,
      label: SIGNAL_LABELS[s.signal_type] ?? s.signal_type,
      weight,
      points,
      viewer: maskViewer(s.viewer_key),
      occurred_at: s.occurred_at,
    });
  }

  // 退款冲减
  const refundPoints = refunds.reduce((acc, r) => acc + (rule.refundPenaltyPerUnit ?? 0) * r.units, 0);

  // 人工调整点数（撤销为负、补结为正）
  const adjustmentPoints = adjustments.reduce((acc, a) => acc + (a.delta_points ?? 0), 0);

  const netPoints = round2(grossPoints - refundPoints + adjustmentPoints);

  // 排除明细（含证据，供创作者核对“流量因何被排除”）
  const excludedItems = exclusions.map((x) => ({
    event_id: x.event.event_id,
    signal_type: x.event.payload?.signal_type,
    label: SIGNAL_LABELS[x.event.payload?.signal_type] ?? x.event.payload?.signal_type,
    code: x.code,
    reason: x.reason,
    viewer: maskViewer(x.event.payload?.viewer_key),
    occurred_at: x.event.payload?.occurred_at,
    evidence: exclusionEvidence(x, ledger),
  }));

  const refundItems = refunds.map((r) => ({
    event_id: r.event.event_id,
    refund_id: r.refund_id,
    units: r.units,
    penalty_per_unit: rule.refundPenaltyPerUnit ?? 0,
    points: round2((rule.refundPenaltyPerUnit ?? 0) * r.units),
    occurred_at: r.occurred_at,
  }));

  const workSnapshot = {
    work_id: work.work_id,
    version: work.version,
    content_hash: work.content_hash,
    duration_seconds: work.duration_seconds,
    author_id: work.author_id,
    title: work.title ?? null,
    published_at: work.published_at,
    applicable_signals: work.applicable_signals,
  };
  const ruleSnapshot = {
    rule_id: rule.rule_id,
    version: rule.version,
    effective_from: rule.effective_from,
    weights: rule.weights,
    refundPenaltyPerUnit: rule.refundPenaltyPerUnit,
    discussionThresholds: rule.discussionThresholds,
    crossDayAfterDays: rule.crossDayAfterDays,
    completionProgressThreshold: rule.completionProgressThreshold,
  };

  // 复算指纹：把全部原始输入（信号/排除/退款/调整/作品/规则）稳定哈希
  const inputHash = sha256({
    period,
    work_snapshot: workSnapshot,
    rule_snapshot: ruleSnapshot,
    accepted: signals.map((s) => s.event_id),
    excluded: exclusions.map((x) => x.event.event_id),
    refunds: refunds.map((r) => r.refund_id),
    adjustments: adjustments.map((a) => a.adjustment_id),
  });

  return {
    statement_id: `stmt-${period}-${shortHash(`${period}:${workId}:${inputHash}`, 10)}`,
    period,
    status: ledger.calendar.status(period),
    work: workSnapshot,
    rule: ruleSnapshot,
    summary: {
      gross_points: round2(grossPoints),
      refund_points: round2(refundPoints),
      adjustment_points: round2(adjustmentPoints),
      net_points: netPoints,
      accepted_signal_count: signals.length,
      excluded_signal_count: exclusions.length,
      refund_count: refunds.length,
    },
    supportBreakdown: [...byType.values()].map((b) => ({ ...b, points: round2(b.points) })),
    contributions,
    excluded: excludedItems,
    refunds: refundItems,
    adjustments: adjustments.map((a) => ({
      adjustment_id: a.adjustment_id,
      kind: a.kind,
      delta_points: a.delta_points,
      reason: a.reason,
      proposed_by: a.proposed_by,
      approved_by: a.approved_by,
      appeal_id: a.appeal_id ?? null,
    })),
    input_hash: inputHash,
    reproducible: true,
  };
}

/** 计算整个周期全部有数据作品的结算单集合。 */
export function computePeriod(events, period) {
  const ledger = buildLedger(events, {
    ruleForPeriod: (p) => new RuleBook(events).forPeriod(p),
  });
  const workIds = new Set();
  for (const s of ledger.accepted) if (s.period === period) workIds.add(s.work_id);
  for (const x of ledger.excluded) if (x.period === period) workIds.add(x.event.payload?.work_id);
  for (const r of ledger.refunds) if (r.period === period) workIds.add(r.work_id);
  for (const e of events) {
    if (e.kind === "ADJUSTMENT_APPROVED" && e.payload.target_period === period) workIds.add(e.payload.work_id);
  }
  const statements = [...workIds].filter(Boolean).sort().map((workId) => computeStatement(events, { period, workId }));
  return {
    period,
    status: ledger.calendar.status(period),
    statements,
    totals: {
      gross_points: round2(statements.reduce((a, s) => a + s.summary.gross_points, 0)),
      refund_points: round2(statements.reduce((a, s) => a + s.summary.refund_points, 0)),
      adjustment_points: round2(statements.reduce((a, s) => a + s.summary.adjustment_points, 0)),
      net_points: round2(statements.reduce((a, s) => a + s.summary.net_points, 0)),
    },
  };
}

/** 单条信号的数量口径：讨论按有效条数计 1；其余信号每条计 1（权重已体现差异）。 */
function signalQuantity(s) {
  if (s.signal_type === SIGNAL_TYPES.MEANINGFUL_DISCUSSION) return 1;
  return 1;
}

function exclusionEvidence(x, ledger) {
  const workId = x.event.payload?.work_id;
  const author = ledger.works.get(workId)?.author_id ?? null;
  const viewer = x.event.payload?.viewer_key ?? null;
  if (x.code === "RECIPROCAL") {
    const ring = ledger.graph.ringEvidence(viewer, author);
    return {
      rule: "互动有向图中存在 viewer→author 回流闭环（Tarjan 强连通分量规模≥2），非真实回访",
      ...(ring ? ring : {}),
    };
  }
  if (x.code === "SAME_CONTROL" || x.code === "SELF") {
    return { rule: "viewer 伪标识与作者在同一声明控制关系并查集内" };
  }
  if (x.code === "DUPLICATE") {
    return { dedup_key: naturalKeyOf(x.event.payload), rule: "自然键已存在，先到先得，重复上报不贡献两次价值" };
  }
  if (x.code === "LATE") {
    return { ingested_at: x.event.ingested_at ?? null, rule: "信号到达时归属周期窗口已封账" };
  }
  return null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

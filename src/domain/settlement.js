// 纯函数结算计算器：输入投影状态，输出每个作品的可复算结算单。
// 不读写事件日志、不依赖当前时间，便于单测与申诉时按原输入重算。
import { stableHash } from "./hash.js";

export const RULE_V1 = Object.freeze({
  rule_version: "v2026-09-01",
  effective_period: "2026-09",
  weights: {
    completed_view_cents: 120, // 跨越完成线的完整观看（每观众每周期 1 次）
    favorite_open_cents: 80, // 收藏后重新打开（每观众每周期 1 次）
    discussion_cents: 200, // 每条有效讨论
    refund_penalty_cents: 300, // 每笔退款负向扣减
    cross_day_revisit_cents: 150, // 跨日回访（每观众每周期 1 次）
  },
  quality_factor: { high: 1.5, normal: 1, low: 0.5 },
  completion_threshold: 0.9,
  mutual_min_each_direction: 1, // 双向各至少 N 条才判互刷
});

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// 检测同一控制关系与双向互刷，返回 Map<signal_id, 排除决定>。
export function detectFraud(works, periodSignals, groups, rule) {
  const exclusions = new Map();

  // viewer_h -> 控制它的创作主体集合
  const viewerOwners = new Map();
  for (const g of groups.values()) {
    for (const vh of g.viewer_hs) {
      if (!viewerOwners.has(vh)) viewerOwners.set(vh, new Set());
      for (const c of g.creator_ids) viewerOwners.get(vh).add(c);
    }
  }

  // 第一遍：同一控制关系下的自评自看。
  // 第二遍需要的有向互动边：ownerCreator -> 被互动作品的 creator。
  const edges = new Map(); // A|B -> {from:A,to:B,signal_ids:[]}
  for (const s of periodSignals) {
    const work = works.get(s.work_id);
    if (!work) continue;
    const owners = viewerOwners.get(s.viewer_h);
    if (!owners) continue;

    if (owners.has(work.creator_id)) {
      exclusions.set(s.signal_id, {
        reason: "CONTROL_RELATION",
        reason_label: "同一控制关系下的自评/关联互动",
        evidence: {
          group_ids: [...groups.values()].filter((g) => g.viewer_hs.has(s.viewer_h) && g.creator_ids.has(work.creator_id)).map((g) => g.group_id).sort(),
          creator_id: work.creator_id,
        },
      });
      continue;
    }
    for (const owner of owners) {
      const key = `${owner}|${work.creator_id}`;
      if (!edges.has(key)) edges.set(key, { from: owner, to: work.creator_id, signal_ids: [] });
      edges.get(key).signal_ids.push(s.signal_id);
    }
  }

  // 双向边互刷：A→B 与 B→A 同时成立（且各达到阈值）才排除，单向不惩罚。
  const min = rule.mutual_min_each_direction ?? 1;
  for (const [key, edge] of edges) {
    const reverseKey = `${edge.to}|${edge.from}`;
    const reverse = edges.get(reverseKey);
    if (!reverse || edge.signal_ids.length < min || reverse.signal_ids.length < min) continue;
    for (const sid of edge.signal_ids) {
      // 不覆盖已经定性的“同一控制关系”。
      if (exclusions.has(sid)) continue;
      exclusions.set(sid, {
        reason: "MUTUAL_PROMOTION",
        reason_label: "与对方账号双向互刷",
        evidence: {
          from_creator: edge.from,
          to_creator: edge.to,
          forward_signal_ids: [...edge.signal_ids].sort(),
          reverse_signal_ids: [...reverse.signal_ids].sort(),
          rule: "双向互动且各方向达到阈值",
        },
      });
    }
  }
  return exclusions;
}

// 计算单个作品一个周期的明细。
export function computeWorkSheet({ period, work, signals, exclusionsForWork, rule, inputEventIds }) {
  const contributions = [];
  const exclusions = [];

  // 先固化所有排除决定（同一控制关系、互刷、风控判定、不适用信号等）。
  const excludedIds = new Set();
  for (const s of signals) {
    const ex = exclusionsForWork.get(s.signal_id);
    if (ex) {
      excludedIds.add(s.signal_id);
      exclusions.push(toExclusionLine(s, ex));
    }
  }

  // FAVORITED 是前置事实，不参与计值；其余价值信号才进入计值流程。
  const active = signals.filter((s) => s.signal_type !== "FAVORITED" && !excludedIds.has(s.signal_id));

  // ---- PLAY_PROGRESS：每观众每周期最多 1 个完播单位，取最大进度 ----
  const byViewerPlay = new Map();
  for (const s of active.filter((x) => x.signal_type === "PLAY_PROGRESS")) {
    const list = byViewerPlay.get(s.viewer_h) ?? [];
    list.push(s);
    byViewerPlay.set(s.viewer_h, list);
  }
  for (const list of byViewerPlay.values()) {
    const sorted = [...list].sort((a, b) =>
      b.payload.progress - a.payload.progress || a.occurred_at.localeCompare(b.occurred_at) || a.signal_id.localeCompare(b.signal_id));
    sorted.forEach((s, i) => {
      if (i === 0 && s.payload.progress >= rule.completion_threshold) {
        contributions.push(line(s, "完整观看（跨日累计达到完成线）", 1, rule.weights.completed_view_cents, { max_progress: s.payload.progress }));
      } else if (i === 0) {
        contributions.push(infoLine(s, `最大进度 ${(s.payload.progress * 100).toFixed(0)}% 未达完成线 ${rule.completion_threshold * 100}%`, { max_progress: s.payload.progress }));
      } else {
        contributions.push(infoLine(s, "同一观众本周期已计一次完播，重复进度不再计值", { progress: s.payload.progress }));
      }
    });
  }

  // ---- FAVORITE_OPEN：每观众每作品每周期 1 次，且必须有收藏前置 ----
  const opens = active.filter((x) => x.signal_type === "FAVORITE_OPEN");
  const seenOpenViewer = new Set();
  for (const s of [...opens].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.signal_id.localeCompare(b.signal_id))) {
    if (seenOpenViewer.has(s.viewer_h)) {
      contributions.push(infoLine(s, "同一观众本周期的收藏后打开仅计一次", {}));
      continue;
    }
    seenOpenViewer.add(s.viewer_h);
    if (!s.payload.has_prerequisite_favorite) {
      exclusions.push(toExclusionLine(s, { reason: "PREREQUISITE_MISSING", reason_label: "缺少收藏前置事实", evidence: {} }));
      continue;
    }
    contributions.push(line(s, "收藏后再次打开（长期兴趣信号）", 1, rule.weights.favorite_open_cents, {
      seconds_after_favorite: s.payload.seconds_after_favorite ?? null,
    }));
  }

  // ---- VALID_DISCUSSION：每条讨论按质量系数计值 ----
  const seenDiscussion = new Set();
  for (const s of active.filter((x) => x.signal_type === "VALID_DISCUSSION")) {
    if (seenDiscussion.has(s.payload.discussion_id)) {
      contributions.push(infoLine(s, "同一讨论不重复计值", {}));
      continue;
    }
    seenDiscussion.add(s.payload.discussion_id);
    const factor = rule.quality_factor[s.payload.quality ?? "normal"] ?? 1;
    contributions.push(line(s, `有效讨论（质量系数 ×${factor}）`, factor, rule.weights.discussion_cents, {
      discussion_id: s.payload.discussion_id, quality: s.payload.quality ?? "normal",
    }));
  }

  // ---- REFUND：逐笔负向 ----
  const seenOrder = new Set();
  for (const s of active.filter((x) => x.signal_type === "REFUND")) {
    if (seenOrder.has(s.payload.order_id)) {
      contributions.push(infoLine(s, "同一订单退款不重复扣减", {}));
      continue;
    }
    seenOrder.add(s.payload.order_id);
    contributions.push(line(s, "退款负向扣减", 1, -rule.weights.refund_penalty_cents, {
      order_id: s.payload.order_id, reason_code: s.payload.reason_code ?? null,
    }));
  }

  // ---- CROSS_DAY_REVISIT：每观众每周期 1 次 ----
  const seenRevisit = new Set();
  for (const s of active.filter((x) => x.signal_type === "CROSS_DAY_REVISIT")) {
    if (seenRevisit.has(s.viewer_h)) {
      contributions.push(infoLine(s, "同一观众本周期跨日回访仅计一次", {}));
      continue;
    }
    seenRevisit.add(s.viewer_h);
    contributions.push(line(s, "跨日回访（经典内容长尾价值）", 1, rule.weights.cross_day_revisit_cents, {
      first_seen: s.payload.first_seen, gap_hours: hoursBetween(s.payload.first_seen, s.occurred_at),
    }));
  }

  const positive_cents = contributions.reduce((a, c) => a + Math.max(0, c.gross_cents), 0);
  const refund_cents = contributions.reduce((a, c) => a + Math.min(0, c.gross_cents), 0);
  const net_gross_cents = Math.max(0, positive_cents + refund_cents);

  for (const s of signals) inputEventIds.add(s.event_id);

  return {
    sheet: {
      period,
      work_id: work.work_id,
      title: work.title,
      creator_id: work.creator_id,
      rule_version: rule.rule_version,
      frozen_snapshot: {
        version: work.version,
        duration_sec: work.duration_sec,
        creator_id: work.creator_id,
        eligible_signals: [...work.eligible_signals],
        frozen_at: work.frozen_at,
        freeze_event_id: work.event_id,
      },
      contributions: contributions.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.signal_id.localeCompare(b.signal_id)),
      exclusions: exclusions.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.signal_id.localeCompare(b.signal_id)),
      subtotal: { positive_cents, refund_cents, net_gross_cents },
      accepted_count: active.length,
      excluded_count: excludedIds.size,
    },
  };
}

// 主入口：对周期内全部有信号的作品结算，并按资金池做比例分摊。
export function evaluatePeriod({ period, works, signals, anomalyExclusions, groups, rule, fund_cents, freezeHashes }) {
  const inputEventIds = new Set();

  // 合并全部排除来源：风控判定 + 同一控制关系 + 双向互刷 + 作品不适用的信号类型。
  const mergedExclusions = new Map(anomalyExclusions);
  const fraud = detectFraud(works, signals, groups, rule);
  for (const [sid, ex] of fraud) {
    if (!mergedExclusions.has(sid)) mergedExclusions.set(sid, ex);
  }
  for (const s of signals) {
    const work = works.get(s.work_id);
    if (!work) continue;
    if (s.signal_type !== "FAVORITED" && !work.eligible_signals.includes(s.signal_type) && !mergedExclusions.has(s.signal_id)) {
      mergedExclusions.set(s.signal_id, {
        reason: "NOT_ELIGIBLE",
        reason_label: `该作品发布时冻结的适用信号不含 ${s.signal_type}`,
        evidence: { eligible_signals: [...work.eligible_signals] },
      });
    }
  }

  const workIds = [...new Set(signals.map((s) => s.work_id))].sort();
  const perWork = [];
  for (const workId of workIds) {
    const work = works.get(workId);
    if (!work) continue;
    const mine = signals.filter((s) => s.work_id === workId);
    const exclusionsForWork = new Map();
    for (const s of mine) {
      const ex = mergedExclusions.get(s.signal_id);
      if (ex) exclusionsForWork.set(s.signal_id, ex);
    }
    const { sheet } = computeWorkSheet({
      period, work, signals: mine, exclusionsForWork, rule, inputEventIds,
    });
    perWork.push(sheet);
  }

  const totalGross = perWork.reduce((a, s) => a + s.subtotal.net_gross_cents, 0);
  if (totalGross <= fund_cents) {
    for (const sheet of perWork) {
      sheet.allocation = { gross_cents: sheet.subtotal.net_gross_cents, final_cents: sheet.subtotal.net_gross_cents, capped: false };
    }
  } else {
    // 资金池不足以按毛额发放：最大余数法比例分摊，各作品最终额之和恰为资金池。
    const shares = largestRemainder(perWork.map((s) => s.subtotal.net_gross_cents), fund_cents);
    perWork.forEach((sheet, i) => {
      sheet.allocation = { gross_cents: sheet.subtotal.net_gross_cents, final_cents: shares[i], capped: true };
    });
  }

  // manifest：复算所需的全部输入指纹（冻结快照哈希 + 输入事件 + 规则 + 资金池）。
  const verification = {
    period,
    rule_version: rule.rule_version,
    rule,
    fund_cents,
    freeze_hashes: [...freezeHashes].sort(),
    input_event_ids: [...inputEventIds].sort(),
    exclusion_count: mergedExclusions.size,
  };
  const calculation_hash = stableHash(canonicalJson({ verification, sheets: perWork }));

  return {
    sheets: perWork,
    calculation_hash,
    verification,
    totals: {
      gross_cents: totalGross,
      final_cents: perWork.reduce((a, s) => a + s.allocation.final_cents, 0),
      fund_cents,
      accepted: perWork.reduce((a, s) => a + s.accepted_count, 0),
      excluded: perWork.reduce((a, s) => a + s.excluded_count, 0),
    },
  };
}

function largestRemainder(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (w / sum) * total);
  const floors = exact.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < remainder; k++) floors[order[k][1]] += 1;
  return floors;
}

function line(signal, item, unit, unit_cents, detail) {
  return {
    signal_id: signal.signal_id,
    signal_type: signal.signal_type,
    occurred_at: signal.occurred_at,
    viewer_h: signal.viewer_h,
    item,
    count: 1,
    factor: unit,
    unit_cents,
    gross_cents: Math.round(unit * unit_cents),
    detail,
  };
}

function infoLine(signal, item, detail) {
  return {
    signal_id: signal.signal_id,
    signal_type: signal.signal_type,
    occurred_at: signal.occurred_at,
    viewer_h: signal.viewer_h,
    item,
    count: 0,
    factor: 0,
    unit_cents: 0,
    gross_cents: 0,
    detail,
    informational: true,
  };
}

function toExclusionLine(signal, ex) {
  return {
    signal_id: signal.signal_id,
    signal_type: signal.signal_type,
    occurred_at: signal.occurred_at,
    viewer_h: signal.viewer_h,
    reason: ex.reason,
    reason_label: ex.reason_label,
    evidence: ex.evidence,
  };
}

function hoursBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 3_600_000);
}

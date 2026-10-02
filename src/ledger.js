// 信号台账：把事件日志投影成“已采信信号 / 被排除信号 / 退款”。
//
// 这是反作弊与迟到策略唯一发生的地方，且是纯函数：给定同一份事件日志，
// 永远得到同一份台账。结算引擎只消费台账，结算单上的每一条采信/排除都可复算。
import { EXCLUSION_REASONS, SIGNAL_TYPES } from "./longform_value_settlement.js";
import { PeriodCalendar, periodOf } from "./periods.js";
import { WorkRegistry } from "./work_registry.js";
import { ControlGraph } from "./control_graph.js";

/**
 * 自然键：同一去标识化观众在同一作品下的同一事实只有一个键，重复上报不贡献两次价值。
 */
export function naturalKey(payload) {
  switch (payload.signal_type) {
    case SIGNAL_TYPES.MEANINGFUL_DISCUSSION:
      return `disc:${payload.work_id}:${payload.discussion_id ?? ""}`;
    case SIGNAL_TYPES.FAVORITE_THEN_OPEN:
      return `fav-open:${payload.work_id}:${payload.favorite_id ?? ""}`;
    default:
      return `${payload.signal_type}:${payload.work_id}:${payload.viewer_key ?? ""}`;
  }
}

/**
 * @param {Array<object>} events 事件日志（含 ingested_at）
 * @param {{ruleForPeriod?: (period:string)=>object}} [options]
 *   ruleForPeriod 返回该周期适用规则（讨论质量门槛按冻结规则复算）
 * @returns {{accepted: Array, excluded: Array<{event:object, code:string, reason:string, period:string}>, refunds:Array, refundExclusions:Array, works:WorkRegistry, calendar:PeriodCalendar}}
 */
export function buildLedger(events, options = {}) {
  const ruleForPeriod = options.ruleForPeriod ?? (() => null);
  const works = new WorkRegistry(events);
  const calendar = new PeriodCalendar(events);
  const graph = new ControlGraph(events);
  graph.resolveEdges((workId) => works.get(workId)?.author_id ?? null);

  const accepted = [];
  const excluded = [];
  const refunds = [];
  const refundExclusions = [];
  const seenKeys = new Set();
  const seenRefunds = new Set();

  const reject = (event, period, code) =>
    excluded.push({ event, period, code, reason: EXCLUSION_REASONS[code] ?? code });

  // 按事件顺序处理，自然键“先到先得”，后到即重复
  for (const event of events) {
    if (event.kind === "VALUE_SIGNAL") {
      classifySignal(event);
    } else if (event.kind === "REFUND_RECORDED") {
      classifyRefund(event);
    }
  }

  function classifySignal(event) {
    const p = event.payload ?? {};
    const period = safePeriod(p.occurred_at);
    const work = works.get(p.work_id);

    if (!period) return; // 非法时间由事件层拦截，这里忽略
    if (!work) return reject(event, period, "UNKNOWN_WORK");
    if (!(work.applicable_signals ?? []).includes(p.signal_type)) return reject(event, period, "NOT_APPLICABLE");

    // 迟到策略：信号必须能归入一个“到达时仍敞开”的窗口
    if (calendar.status(period) === "UNKNOWN") return reject(event, period, "NO_OPEN_WINDOW");
    const window = calendar.list().find((w) => w.period === period);
    if (window.closed_at && event.ingested_at >= window.closed_at) return reject(event, period, "LATE");
    if (window.opened_at && event.ingested_at < window.opened_at) return reject(event, period, "NO_OPEN_WINDOW");

    if (Date.parse(p.occurred_at) < Date.parse(work.published_at)) return reject(event, period, "PRIOR_TO_PUBLICATION");

    const key = naturalKey(p);
    if (seenKeys.has(key)) return reject(event, period, "DUPLICATE");

    // 反作弊（去标识化空间内判定）
    const viewer = p.viewer_key;
    if (viewer && viewer === work.author_id) {
      seenKeys.add(key); // 自我互动也占住自然键，避免换皮重报
      return reject(event, period, "SELF");
    }
    if (graph.sameController(viewer, work.author_id)) {
      seenKeys.add(key);
      return reject(event, period, "SAME_CONTROL");
    }
    if (graph.inReciprocalRing(viewer, work.author_id)) {
      seenKeys.add(key);
      return reject(event, period, "RECIPROCAL");
    }

    // 类型门槛（质量阈值按该周期冻结的规则版本复算）
    const gate = typeGate(p, work, ruleForPeriod(period));
    if (gate) return reject(event, period, gate);

    seenKeys.add(key);
    accepted.push({
      event,
      event_id: event.event_id,
      period,
      work_id: p.work_id,
      author_id: work.author_id,
      signal_type: p.signal_type,
      viewer_key: viewer,
      occurred_at: p.occurred_at,
      dedup_key: key,
      metrics: extractMetrics(p),
    });
  }

  function classifyRefund(event) {
    const p = event.payload ?? {};
    const period = safePeriod(p.occurred_at);
    if (!period) return;
    if (!works.get(p.work_id)) return refundExclusions.push({ event, period, code: "UNKNOWN_WORK", reason: EXCLUSION_REASONS.UNKNOWN_WORK });
    if (calendar.status(period) === "UNKNOWN") {
      return refundExclusions.push({ event, period, code: "NO_OPEN_WINDOW", reason: EXCLUSION_REASONS.NO_OPEN_WINDOW });
    }
    const window = calendar.list().find((w) => w.period === period);
    if (window.closed_at && event.ingested_at >= window.closed_at) {
      return refundExclusions.push({ event, period, code: "LATE", reason: EXCLUSION_REASONS.LATE });
    }
    if (seenRefunds.has(p.refund_id)) {
      return refundExclusions.push({ event, period, code: "REFUND_DUPLICATE", reason: EXCLUSION_REASONS.REFUND_DUPLICATE });
    }
    seenRefunds.add(p.refund_id);
    refunds.push({
      event,
      refund_id: p.refund_id,
      period,
      work_id: p.work_id,
      author_id: works.get(p.work_id).author_id,
      units: Number.isFinite(p.units) ? p.units : 1,
      occurred_at: p.occurred_at,
    });
  }

  function typeGate(p, work, rule) {
    const completionThreshold = rule?.completionProgressThreshold ?? 0.9;
    switch (p.signal_type) {
      case SIGNAL_TYPES.CROSS_DAY_COMPLETION: {
        if (!isCrossDay(p.occurred_at, work.published_at, rule?.crossDayAfterDays ?? 1)) return "NOT_CROSS_DAY";
        if (typeof p.progress !== "number" || p.progress < completionThreshold) return "BELOW_PROGRESS";
        return null;
      }
      case SIGNAL_TYPES.CROSS_DAY_REVISIT:
        return isCrossDay(p.occurred_at, work.published_at, rule?.crossDayAfterDays ?? 1) ? null : "NOT_CROSS_DAY";
      case SIGNAL_TYPES.FAVORITE_THEN_OPEN:
        if (!p.favorite_id || !p.favorited_at) return "NOT_FAVORITED";
        if (Date.parse(p.occurred_at) < Date.parse(p.favorited_at)) return "NOT_FAVORITED";
        return isCrossDay(p.occurred_at, work.published_at, rule?.crossDayAfterDays ?? 1) ? null : "NOT_CROSS_DAY";
      case SIGNAL_TYPES.MEANINGFUL_DISCUSSION:
        return qualityGate(p.discussion ?? {}, rule?.discussionThresholds) ? null : "LOW_QUALITY";
      case SIGNAL_TYPES.COMPLETION:
        return typeof p.progress === "number" && p.progress >= completionThreshold ? null : "BELOW_PROGRESS";
      default:
        return "NOT_APPLICABLE";
    }
  }

  // 有效讨论门槛：长度、回复数、且不能是连续重复字符灌水。阈值来自周期冻结规则。
  function qualityGate(d, thresholds = {}) {
    const minLength = thresholds.minLengthChars ?? 12;
    const minReplies = thresholds.minReplies ?? 0;
    const len = typeof d.length_chars === "number" ? d.length_chars : String(d.text ?? "").length;
    if (len < minLength) return false;
    if (typeof d.reply_count === "number" && d.reply_count < minReplies) return false;
    if (thresholds.forbidRepeatedChars !== false) {
      if (d.repeated_chars === true) return false;
      const text = String(d.text ?? "");
      if (text && /^(.)\1{7,}$/.test(text.trim())) return false;
    }
    return true;
  }

  return { accepted, excluded, refunds, refundExclusions, works, calendar, graph };
}

function extractMetrics(p) {
  const m = {};
  if (typeof p.progress === "number") m.progress = p.progress;
  if (p.discussion) m.discussion = p.discussion;
  if (p.favorite_id) m.favorite_id = p.favorite_id;
  return m;
}

function safePeriod(iso) {
  try {
    return periodOf(iso);
  } catch {
    return null;
  }
}

/** 跨日判定：行为时刻距发布超过 days 个完整自然日（按 24h 倍数，时区无关）。 */
export function isCrossDay(occurredIso, publishedIso, days = 1) {
  const dt = Date.parse(occurredIso) - Date.parse(publishedIso);
  return dt >= days * 86400000;
}

// 上报数据的严格校验 + 去标识化守卫。
// 信号载荷只允许出现白名单字段；任何疑似可标识个人信息的字段直接拒绝。
import { SIGNAL_TYPES, VALUE_SIGNAL_TYPES, REJECT_REASONS } from "./constants.js";
import { DomainError, periodOf } from "./time.js";
import { pseudonymizeViewer } from "./hash.js";

const PII_PATTERNS = [
  { name: "phone", re: /(?:(?:\+|00)86)?1[3-9]\d{9}/ },
  { name: "email", re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { name: "id_card", re: /\b\d{17}[\dXx]\b/ },
];

// 每种信号允许的载荷字段（viewer_token 在校验阶段转换为 viewer_h，不落盘）。
const SIGNAL_FIELDS = Object.freeze({
  PLAY_PROGRESS: ["viewer_token", "progress", "duration_sec", "session_id", "play_id"],
  FAVORITED: ["viewer_token", "session_id", "fav_id"],
  FAVORITE_OPEN: ["viewer_token", "session_id", "open_id", "seconds_after_favorite"],
  VALID_DISCUSSION: ["viewer_token", "discussion_id", "chars", "quality"],
  REFUND: ["viewer_token", "order_id", "reason_code"],
  CROSS_DAY_REVISIT: ["viewer_token", "session_id", "first_seen", "revisit_at"],
});

function findPii(value, path = "$") {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    for (const p of PII_PATTERNS) {
      if (p.re.test(value)) return { field: path, kind: p.name };
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/name|phone|email|idcard|id_card|passport|address|imei|idfa|openid|unionid/i.test(k)) {
        return { field: `${path}.${k}`, kind: "identifier_field" };
      }
      const hit = findPii(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

// 将外部上报体转换成内部“去标识化事件 payload”。
// 校验失败抛 DomainError(code=REJECT_*)，调用方据此拒收且不写日志。
export function sanitizeSignal(report, { pepper, now = new Date() }) {
  const { work_id, signal_type, occurred_at } = report;
  if (typeof work_id !== "string" || !work_id) throw new DomainError("缺少 work_id", REJECT_REASONS.UNKNOWN_WORK);
  if (!SIGNAL_TYPES.includes(signal_type)) {
    throw new DomainError(`未知信号类型: ${signal_type}`, "BAD_SIGNAL_TYPE");
  }
  const payload = report.payload ?? {};
  const pii = findPii(report) || findPii(payload);
  if (pii) {
    throw new DomainError(`载荷疑似包含可标识个人信息（${pii.kind} @ ${pii.field}）`, REJECT_REASONS.PII_DETECTED, pii);
  }
  if (typeof occurred_at !== "string" || Number.isNaN(new Date(occurred_at).getTime())) {
    throw new DomainError("occurred_at 非法", "BAD_TIME");
  }
  if (new Date(occurred_at).getTime() > now.getTime() + 60_000) {
    throw new DomainError("信号时间晚于当前时间", REJECT_REASONS.FUTURE_TIMESTAMP);
  }

  const allowed = new Set(SIGNAL_FIELDS[signal_type]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new DomainError(`${signal_type} 不允许字段 ${key}`, "INVALID_PAYLOAD");
    }
  }

  const viewer_h = pseudonymizeViewer(payload.viewer_token, pepper);
  const clean = { ...payload, viewer_h };
  delete clean.viewer_token;

  // 类型与阈值校验。
  if (signal_type === "PLAY_PROGRESS") {
    const p = Number(clean.progress);
    if (!Number.isFinite(p) || p < 0 || p > 1.0001) {
      throw new DomainError("progress 必须在 0~1 之间", "INVALID_PAYLOAD");
    }
    if (clean.duration_sec !== undefined) {
      const d = Number(clean.duration_sec);
      if (!Number.isFinite(d) || d <= 0) throw new DomainError("duration_sec 非法", "INVALID_PAYLOAD");
    }
    if (typeof clean.play_id !== "string" || !clean.play_id) {
      throw new DomainError("PLAY_PROGRESS 缺少 play_id", "INVALID_PAYLOAD");
    }
  }
  if (signal_type === "FAVORITE_OPEN" && (typeof clean.open_id !== "string" || !clean.open_id)) {
    throw new DomainError("FAVORITE_OPEN 缺少 open_id", "INVALID_PAYLOAD");
  }
  if (signal_type === "VALID_DISCUSSION") {
    if (typeof clean.discussion_id !== "string" || !clean.discussion_id) {
      throw new DomainError("VALID_DISCUSSION 缺少 discussion_id", "INVALID_PAYLOAD");
    }
    const q = clean.quality;
    if (q !== undefined && !["low", "normal", "high"].includes(q)) {
      throw new DomainError("quality 取值非法", "INVALID_PAYLOAD");
    }
  }
  if (signal_type === "REFUND" && (typeof clean.order_id !== "string" || !clean.order_id)) {
    throw new DomainError("REFUND 缺少 order_id", "INVALID_PAYLOAD");
  }
  if (signal_type === "CROSS_DAY_REVISIT") {
    const first = new Date(clean.first_seen);
    const revisit = new Date(clean.revisit_at ?? occurred_at);
    if (Number.isNaN(first.getTime()) || Number.isNaN(revisit.getTime())) {
      throw new DomainError("CROSS_DAY_REVISIT 时间非法", "INVALID_PAYLOAD");
    }
    // 必须跨越自然日（跨月也成立，信号归入行为发生月）。
    if (revisit.getTime() <= first.getTime() || !spansDay(first, revisit)) {
      throw new DomainError("回访必须发生在首次观看的次日或之后", REJECT_REASONS.NOT_CROSS_DAY);
    }
  }

  return {
    work_id,
    signal_type,
    occurred_at,
    period: periodOf(occurred_at),
    payload: clean,
  };
}

function spansDay(a, b) {
  const da = new Date(a).toISOString().slice(0, 10);
  const db = new Date(b).toISOString().slice(0, 10);
  return da !== db;
}

export { SIGNAL_FIELDS, VALUE_SIGNAL_TYPES };

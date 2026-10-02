// 结算窗口按业务时区（Asia/Shanghai，固定 UTC+8，无夏令时）划分自然月，标签 YYYY-MM。
// 跨日、跨月判断一律走业务时区，避免用 UTC 日界线错杀跨日回访。

export const BUSINESS_OFFSET_MS = 8 * 60 * 60 * 1000;

export class DomainError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

function toTime(value) {
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(t)) throw new DomainError(`无法解析时间: ${String(value)}`, "BAD_TIME");
  return t;
}

// 业务时区下的年月日数值。
export function localYmd(value) {
  const t = toTime(value) + BUSINESS_OFFSET_MS;
  const d = new Date(t);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    key: d.toISOString().slice(0, 10),
  };
}

export function periodOf(dateLike) {
  const { y, m } = localYmd(dateLike);
  return `${y}-${String(m).padStart(2, "0")}`;
}

// 周期在业务时区下的 [start, end) 毫秒点。
export function periodBounds(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new DomainError(`周期标签格式应为 YYYY-MM: ${period}`, "BAD_PERIOD");
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  if (month < 0 || month > 11) throw new DomainError(`非法月份: ${period}`, "BAD_PERIOD");
  const start = Date.UTC(year, month, 1) - BUSINESS_OFFSET_MS;
  const end = Date.UTC(year, month + 1, 1) - BUSINESS_OFFSET_MS;
  return { start, end };
}

export function assertValidPeriod(period) {
  periodBounds(period);
}

// 规则只能对“尚未开始”的周期生效：从新周期起生效。
export function isFuturePeriod(period, now) {
  const { start } = periodBounds(period);
  return start > toTime(now);
}

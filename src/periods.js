// 会计周期：结算窗口的打开与封账。
//
// 规则：
// - 每个自然周期（如 2026-09）有一个窗口；窗口未封账时，迟到数据可以补入该窗口，
//   这就是“迟到数据只能进入尚未封账的窗口”——窗口敞开期间到达的迟到数据仍可归属；
// - 封账后，信号/退款不再进入该窗口（排除原因 LATE），只允许成对的人工调整
//   （撤销/补结）落账；
// - 结算规则的新版本只对“尚未开始”的周期生效，进行中周期沿用旧规则（见 rules.js）。
export const PERIOD_STATUS = Object.freeze({
  OPEN: "OPEN",
  CLOSED: "CLOSED",
});

export class PeriodCalendar {
  /**
   * @param {Array<{kind:string, occurred_at:string, payload:object}>} events
   */
  constructor(events) {
    /** @type {Map<string, {period:string, opened_at:string, closed_at?:string, close_event?:object}>} */
    this.windows = new Map();
    for (const e of events) {
      if (e.kind === "PERIOD_OPENED") {
        this.windows.set(e.payload.period, {
          period: e.payload.period,
          opened_at: e.payload.opened_at ?? e.occurred_at,
        });
      } else if (e.kind === "PERIOD_CLOSED") {
        const w = this.windows.get(e.payload.period);
        if (w) {
          w.closed_at = e.payload.closed_at ?? e.occurred_at;
          w.close_event = e;
        }
      }
    }
  }

  isOpen(period) {
    const w = this.windows.get(period);
    return Boolean(w && !w.closed_at);
  }

  status(period) {
    if (!this.windows.has(period)) return "UNKNOWN";
    return this.isOpen(period) ? PERIOD_STATUS.OPEN : PERIOD_STATUS.CLOSED;
  }

  list() {
    return [...this.windows.values()].sort((a, b) => (a.period < b.period ? -1 : 1));
  }

  /**
   * 信号能否入账到其归属周期：窗口必须仍然开着。
   * 封账后才到达的迟到数据返回 null，由调用方记为 LATE 排除。
   * @returns {string|null} 可入账时返回周期，否则 null
   */
  admitPeriod(targetPeriod) {
    return this.isOpen(targetPeriod) ? targetPeriod : null;
  }
}

/** 把 ISO 时间戳归到自然月周期，如 2026-09-21T08:00+08:00 -> 2026-09。 */
export function periodOf(isoTimestamp) {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) throw new Error(`非法时间: ${isoTimestamp}`);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

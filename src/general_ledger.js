// 复式总账：所有价值变动以“有借必有贷、借贷必相等”的分录过账。
//
// 账户：
//   fund:long-term-value        长期价值扶持资金池（资产方，借方余额）
//   payable:author:{author_id}  应付创作者款项（负债方，贷方余额）
//
// 正常结算：借 资金池 / 贷 应付作者；人工补结同方向，撤销反方向。
// 任意时刻 verifyConservation：所有账户余额合计必须为 0，即总账守恒。

export const FUND_ACCOUNT = "fund:long-term-value";

export class GeneralLedger {
  constructor() {
    /** @type {Array<{entry_id:string, posted_at:string, memo:string, lines:Array<{account:string, cents:number}>}>} */
    this.entries = [];
  }

  /**
   * 过账一笔分录。lines 中 cents 正为借、负为贷；合计必须严格为 0，否则拒绝。
   * @returns 已过账分录
   */
  post(entry_id, lines, { memo = "", posted_at = new Date().toISOString() } = {}) {
    if (!lines.length) throw new Error("分录至少需要一条明细");
    const sum = lines.reduce((acc, l) => acc + l.cents, 0);
    if (sum !== 0) {
      throw new Error(`分录 ${entry_id} 借贷不平衡（差额 ${sum} 分），拒绝过账`);
    }
    if (this.entries.some((e) => e.entry_id === entry_id)) {
      throw new Error(`分录编号 ${entry_id} 已存在，禁止重复过账`);
    }
    const entry = Object.freeze({
      entry_id,
      posted_at,
      memo,
      lines: Object.freeze(lines.map((l) => Object.freeze({ ...l }))),
    });
    this.entries.push(entry);
    return entry;
  }

  /** 账户余额（分）：借方为正、贷方为负。 */
  balances() {
    const bal = new Map();
    for (const e of this.entries) {
      for (const l of e.lines) bal.set(l.account, (bal.get(l.account) ?? 0) + l.cents);
    }
    return bal;
  }

  payableOf(authorId) {
    return -(this.balances().get(`payable:author:${authorId}`) ?? 0); // 负债取反为应付正额
  }

  /** 守恒验证：所有账户余额之和为 0；返回 {conserved, total, byAccount}。 */
  verifyConservation() {
    const byAccount = this.balances();
    let total = 0;
    for (const v of byAccount.values()) total += v;
    return { conserved: total === 0, total, byAccount };
  }
}

/** 价值点 → 分：unit_value 为每点元值；用整数分避免浮点误差。 */
export function pointsToCents(points, unitValueYuan) {
  return Math.round(points * unitValueYuan * 100);
}

export function yuan(cents) {
  return (cents / 100).toFixed(2);
}

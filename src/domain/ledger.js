// 复式记账总账：所有资金动作以平衡分录入账（借合计 === 贷合计，整数分）。
// 余额带符号：借正贷负；全部账户余额之和恒为 0（守恒）。
import { newId, stableHash } from "../domain/hash.js";
import { DomainError } from "../domain/time.js";

export class Ledger {
  constructor() {
    this.balances = new Map();
    this.transactions = [];
  }

  account(name) {
    return this.balances.get(name) ?? 0;
  }

  // legs: [{account, cents}] 正借负贷，或 {account, debit, credit}。
  post({ date, memo, legs, ref_event_id, idempotency_key }) {
    if (idempotency_key && this.transactions.some((t) => t.idempotency_key === idempotency_key)) {
      return this.transactions.find((t) => t.idempotency_key === idempotency_key);
    }
    const norm = legs.map((l) => {
      const cents = l.cents ?? ((l.debit ?? 0) - (l.credit ?? 0));
      if (!Number.isInteger(cents) || cents === 0) {
        throw new DomainError(`分录金额必须为非零整数分: ${l.account}`, "BAD_LEDGER_AMOUNT");
      }
      return { account: l.account, cents };
    });
    const sum = norm.reduce((a, l) => a + l.cents, 0);
    if (sum !== 0) {
      throw new DomainError(`分录不平衡（净额 ${sum} 分）: ${memo}`, "UNBALANCED_ENTRY");
    }
    for (const l of norm) this.balances.set(l.account, this.account(l.account) + l.cents);

    const txn = {
      transaction_id: newId("txn"),
      date,
      memo,
      ref_event_id: ref_event_id ?? null,
      idempotency_key: idempotency_key ?? null,
      legs: norm,
    };
    txn.row_hash = stableHash(JSON.stringify(txn));
    this.transactions.push(txn);
    return txn;
  }

  // 守恒断言：资产/费用类（借正）之和 = 负债/权益类（贷负）之和。
  invariant() {
    const total = [...this.balances.values()].reduce((a, b) => a + b, 0);
    return total === 0;
  }
}

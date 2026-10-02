// 总账投影：从不可变事件日志重建复式总账。
//
// 两类过账：
//   SETTLEMENT_RECORDED  关账结算：借 资金池 / 贷 应付作者
//   ADJUSTMENT_APPROVED  人工补结(+)/撤销(-)：同结构、符号随 delta，成对平衡
// 重建是纯函数：任何时候都能验证“撤销与补结之后总账依然守恒”。
import { GeneralLedger, FUND_ACCOUNT, pointsToCents } from "./general_ledger.js";
import { RuleBook } from "./rules.js";

export function buildProjectedLedger(events) {
  const gl = new GeneralLedger();
  const rules = new RuleBook(events);

  for (const e of events) {
    if (e.kind === "SETTLEMENT_RECORDED") {
      const { target_period: period, work_id: workId, author_id: authorId, net_points: points } = e.payload;
      const unitValue = rules.forPeriod(period).unitValueYuan ?? 1;
      const cents = pointsToCents(points, unitValue);
      if (cents !== 0) {
        gl.post(
          `settle:${period}:${workId}`,
          [
            { account: FUND_ACCOUNT, cents, memo: `${period} 长内容价值结算` },
            { account: `payable:author:${authorId}`, cents: -cents, memo: `应付 ${authorId}` },
          ],
          { posted_at: e.occurred_at, memo: e.payload.memo ?? "周期结算" },
        );
      }
    } else if (e.kind === "ADJUSTMENT_APPROVED") {
      const { target_period: period, work_id: workId, author_id: authorId, delta_points: delta, adjustment_id: adjId } = e.payload;
      const unitValue = rules.forPeriod(period).unitValueYuan ?? 1;
      const cents = pointsToCents(delta, unitValue); // 撤销为负、补结为正
      if (cents !== 0) {
        const verb = delta < 0 ? "撤销" : "补结";
        gl.post(
          `adjust:${adjId}`,
          [
            { account: FUND_ACCOUNT, cents, memo: `${period} 人工${verb}` },
            { account: `payable:author:${authorId}`, cents: -cents, memo: `${verb} ${authorId}` },
          ],
          { posted_at: e.occurred_at, memo: e.payload.reason ?? "人工修正" },
        );
      }
    }
  }
  return gl;
}

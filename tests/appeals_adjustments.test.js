import assert from "node:assert/strict";
import test from "node:test";
import { makeService, classicWork, signals } from "./helpers.js";
import { ROLES } from "../src/domain/constants.js";

async function settled({ fund = 1_000_000 } = {}) {
  const ctx = await makeService();
  await ctx.service.openPeriod({ period: "2026-09", fund_cents: fund });
  await ctx.service.registerWork(classicWork());
  await ctx.service.ingestSignal(signals.play({ payload: { viewer_token: "v-real", progress: 1, play_id: "p" } }));
  await ctx.service.closePeriod("2026-09");
  await ctx.service.finalizeSettlement("2026-09");
  return ctx;
}

test("申诉保留原计算哈希；原结算单事件不被修改", async () => {
  const { service, store, cleanup } = await settled();
  try {
    const hashBefore = (await service.reverify("2026-09")).stored_hash;
    const appeal = await service.fileAppeal({
      period: "2026-09", work_id: "w-baicaiyuan", creator_id: "c-laoshe",
      reasons: ["该排除信号来自真实线下课学生"],
      evidence_refs: ["ticket-123"],
    });
    const evt = store.events().find((e) => e.kind === "APPEAL_FILED");
    assert.equal(evt.payload.original_calculation_hash, hashBefore);
    // 申诉后复算仍一致——原单冻结。
    assert.equal((await service.reverify("2026-09")).matches, true);

    // 非作者不能申诉。
    await assert.rejects(() => service.fileAppeal({
      period: "2026-09", work_id: "w-baicaiyuan", creator_id: "someone-else", reasons: ["x"],
    }), (e) => e.code === "FORBIDDEN");
  } finally {
    await cleanup();
  }
});

test("人工修正职责分离：运营发起、财务（不同人）复核，单人无法入账", async () => {
  const { service, cleanup } = await settled();
  try {
    // 运营发起补结。
    const req = await service.requestAdjustment({
      period: "2026-09", work_id: "w-baicaiyuan",
      type: "SUPPLEMENT", cents: 500, reason: "漏报的线下放映长尾信号，申诉成立后补结",
    }, { actor: "op-wang", actor_role: ROLES.OPERATOR });

    // 运营自己不能复核。
    await assert.rejects(
      () => service.approveAdjustment(
        { adjustment_id: req.adjustment_id, approved: true, reviewer: "op-wang", reviewer_role: ROLES.FINANCE_ADMIN, review_notes: "x" },
      ),
      (e) => e.code === "SEGREGATION_OF_DUTIES",
    );
    // 财务角色才能复核；发起人角色也受限。
    await assert.rejects(
      () => service.approveAdjustment(
        { adjustment_id: req.adjustment_id, approved: true, reviewer: "fin-li", reviewer_role: ROLES.OPERATOR },
      ),
      (e) => e.code === "FORBIDDEN_ROLE",
    );
    const ok = await service.approveAdjustment({
      adjustment_id: req.adjustment_id, approved: true, reviewer: "fin-li",
      reviewer_role: ROLES.FINANCE_ADMIN, review_notes: "证据充分",
    });
    assert.equal(ok.status, "APPROVED");
    assert.equal(ok.ledger_transaction.legs.length, 2);

    const stmt = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
    assert.equal(stmt.net_payable_cents, 120 + 500);
  } finally {
    await cleanup();
  }
});

test("申诉成立经仲裁转补结，再由财务复核入账，总账保持守恒", async () => {
  const { service, cleanup } = await settled();
  try {
    const appeal = await service.fileAppeal({
      period: "2026-09", work_id: "w-baicaiyuan", creator_id: "c-laoshe",
      reasons: ["回访信号被误判"],
    });
    // 仲裁裁定成立，但仲裁人不能直接批钱，只产生待复核请求。
    const reviewed = await service.reviewAppeal({
      appeal_id: appeal.appeal_id, decision: "UPHELD",
      reviewer: "arb-zhang", reviewer_role: ROLES.ARBITRATOR,
      review_notes: "证据链完整", adjustment: { type: "SUPPLEMENT", cents: 300 },
    });
    assert.ok(reviewed.adjustment_id);
    await service.approveAdjustment({
      adjustment_id: reviewed.adjustment_id, approved: true,
      reviewer: "fin-li", reviewer_role: ROLES.FINANCE_ADMIN, review_notes: "同意",
    });
    const stmt = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
    assert.equal(stmt.net_payable_cents, 420);
    assert.equal(service.ledgerReport().balanced, true);
  } finally {
    await cleanup();
  }
});

test("撤销不得超过原结算金额；撤销入账为红字反向平衡凭证", async () => {
  const { service, cleanup } = await settled();
  try {
    // 发起阶段即做守恒约束：累计撤销不得超过原结算 120。
    await assert.rejects(
      () => service.requestAdjustment({
        period: "2026-09", work_id: "w-baicaiyuan",
        type: "REVERSAL", cents: 121, reason: "发现互刷证据，超额撤销应被拦截",
      }, { actor: "op-wang", actor_role: ROLES.OPERATOR }),
      (e) => e.code === "OVER_REVERSAL",
    );

    // 全额撤销 120：应付与支出同时红字冲回。
    const okReq = await service.requestAdjustment({
      period: "2026-09", work_id: "w-baicaiyuan",
      type: "REVERSAL", cents: 120, reason: "互刷证据成立",
    }, { actor: "op-wang", actor_role: ROLES.OPERATOR });
    await service.approveAdjustment({
      adjustment_id: okReq.adjustment_id, approved: true,
      reviewer: "fin-li", reviewer_role: ROLES.FINANCE_ADMIN,
    });
    const stmt = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
    assert.equal(stmt.net_payable_cents, 0);
    const report = service.ledgerReport();
    assert.equal(report.balanced, true);
    // 支出与应付都回到 0。
    assert.equal(report.accounts.reduce((a, [, v]) => a + Math.abs(v), 0), 0);
  } finally {
    await cleanup();
  }
});

test("被拒绝的修正留痕且不入账", async () => {
  const { service, cleanup } = await settled();
  try {
    const req = await service.requestAdjustment({
      period: "2026-09", work_id: "w-baicaiyuan",
      type: "SUPPLEMENT", cents: 999, reason: "理由不充分",
    }, { actor: "op-wang", actor_role: ROLES.OPERATOR });
    await service.approveAdjustment({
      adjustment_id: req.adjustment_id, approved: false,
      reviewer: "fin-li", reviewer_role: ROLES.FINANCE_ADMIN, review_notes: "证据不足",
    });
    const stmt = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
    assert.equal(stmt.net_payable_cents, 120);
    assert.equal(service.ledgerReport().transaction_count, 1); // 只有结算凭证
  } finally {
    await cleanup();
  }
});

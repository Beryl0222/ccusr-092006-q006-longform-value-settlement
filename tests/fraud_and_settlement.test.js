import assert from "node:assert/strict";
import test from "node:test";
import { makeService, classicWork, signals } from "./helpers.js";
import { ACCOUNTS } from "../src/domain/constants.js";

async function setup() {
  const ctx = await makeService();
  await ctx.service.openPeriod({ period: "2026-09", fund_cents: 1_000_000 });
  await ctx.service.registerWork(classicWork());
  await ctx.service.registerWork(classicWork({
    work_id: "w-other", title: "另一部作品", creator_id: "c-other", version: "v1", duration_sec: 600,
  }));
  return ctx;
}

test("同一控制关系下的自评自看被排除，证据随结算单给出", async () => {
  const { service, cleanup } = await setup();
  try {
    // 创作者 c-laoshe 控制观众账号 viewer-A（矩阵号）。
    await service.declareControl({
      group_id: "g-1", creator_ids: ["c-laoshe"], viewer_tokens: ["viewer-A"],
      reason: "同主体矩阵账号",
    });
    const s = await service.ingestSignal(signals.play({ payload: {
      viewer_token: "viewer-A", progress: 1, play_id: "play-A-1",
    } }));
    await service.closePeriod("2026-09");
    await service.finalizeSettlement("2026-09");
    const stmt = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
    const ex = stmt.exclusions.find((e) => e.signal_id === s.signal_id);
    assert.equal(ex.reason, "CONTROL_RELATION");
    assert.deepEqual(ex.evidence.creator_id, "c-laoshe");
    assert.deepEqual(ex.evidence.group_ids, ["g-1"]);
    // 被排除的完播不产生价值。
    assert.equal(stmt.subtotal.positive_cents, 0);
  } finally {
    await cleanup();
  }
});

test("双向互刷双方互动均被排除；单向不惩罚", async () => {
  const { service, cleanup } = await setup();
  try {
    // A 矩阵（c-laoshe 控制 viewer-A），B 矩阵（c-other 控制 viewer-B）。
    await service.declareControl({ group_id: "g-A", creator_ids: ["c-laoshe"], viewer_tokens: ["viewer-A"] });
    await service.declareControl({ group_id: "g-B", creator_ids: ["c-other"], viewer_tokens: ["viewer-B"] });

    // A 给 B 的作品刷完播，B 给 A 的作品刷完播 → 双向互刷。
    const aToB = await service.ingestSignal(signals.play({
      work_id: "w-other",
      payload: { viewer_token: "viewer-A", progress: 1, play_id: "play-A-on-B" },
    }));
    const bToA = await service.ingestSignal(signals.play({
      work_id: "w-baicaiyuan",
      payload: { viewer_token: "viewer-B", progress: 1, play_id: "play-B-on-A" },
    }));
    await service.closePeriod("2026-09");
    await service.finalizeSettlement("2026-09");
    const stmtA = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
    const stmtB = await service.getStatement({ period: "2026-09", work_id: "w-other" });
    assert.equal(stmtA.exclusions.find((e) => e.signal_id === bToA.signal_id).reason, "MUTUAL_PROMOTION");
    assert.equal(stmtB.exclusions.find((e) => e.signal_id === aToB.signal_id).reason, "MUTUAL_PROMOTION");
    // 证据包含双向信号清单。
    const ev = stmtA.exclusions.find((e) => e.signal_id === bToA.signal_id).evidence;
    assert.ok(ev.forward_signal_ids.includes(bToA.signal_id));
    assert.ok(ev.reverse_signal_ids.includes(aToB.signal_id));
  } finally {
    await cleanup();
  }
});

test("普通真实观众跨日看完 + 收藏后打开 + 有效讨论形成长期价值扶持", async () => {
  const { service, cleanup } = await setup();
  try {
    await service.ingestSignal(signals.favorite()); // 9/2 收藏
    await service.ingestSignal(signals.play({ payload: {
      viewer_token: "viewer-A", progress: 0.35, play_id: "play-A-1",
    } })); // 首日完播率低
    await service.ingestSignal(signals.play({
      occurred_at: "2026-09-05T20:05:00+08:00",
      payload: { viewer_token: "viewer-A", progress: 0.95, play_id: "play-A-2" },
    })); // 跨日看完
    await service.ingestSignal(signals.favoriteOpen()); // 9/5 收藏后打开
    await service.ingestSignal(signals.discussion()); // 高质量有效讨论 ×1.5
    await service.ingestSignal(signals.revisit()); // 跨日回访

    await service.closePeriod("2026-09");
    await service.finalizeSettlement("2026-09");
    const stmt = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });

    const items = stmt.contributions.filter((c) => c.gross_cents > 0).map((c) => c.item);
    assert.ok(items.some((i) => /完整观看/.test(i)));
    assert.ok(items.some((i) => /收藏后再次打开/.test(i)));
    assert.ok(items.some((i) => /有效讨论/.test(i)));
    assert.ok(items.some((i) => /跨日回访/.test(i)));
    // 120 + 80 + 200*1.5 + 150 = 650
    assert.equal(stmt.subtotal.positive_cents, 650);
    assert.equal(stmt.allocation.final_cents, 650);
    assert.equal(stmt.exclusions.length, 0);
  } finally {
    await cleanup();
  }
});

test("资金池不足时按最大余数法分摊，最终额之和恰为资金池", async () => {
  const { service, cleanup } = await makeService();
  try {
    await service.openPeriod({ period: "2026-09", fund_cents: 100 });
    await service.registerWork(classicWork());
    await service.registerWork(classicWork({ work_id: "w-other", creator_id: "c-other", version: "v1", duration_sec: 600 }));
    for (const [work, token] of [["w-baicaiyuan", "v1"], ["w-other", "v2"]]) {
      await service.ingestSignal({
        work_id: work, signal_type: "PLAY_PROGRESS",
        occurred_at: "2026-09-03T20:00:00+08:00",
        payload: { viewer_token: token, progress: 1, play_id: `p-${token}` },
      });
    }
    await service.closePeriod("2026-09");
    const r = await service.finalizeSettlement("2026-09");
    assert.equal(r.totals.final_cents, 100);
    const a = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
    const b = await service.getStatement({ period: "2026-09", work_id: "w-other" });
    assert.equal(a.allocation.final_cents + b.allocation.final_cents, 100);
    assert.ok(a.allocation.capped && b.allocation.capped);
  } finally {
    await cleanup();
  }
});

test("风控异常判定可排除信号；封账后不能溯及既往", async () => {
  const { service, cleanup } = await setup();
  try {
    const s = await service.ingestSignal(signals.discussion());
    await service.markAnomaly({
      signal_id: s.signal_id, reason_label: "机刷评论团伙",
      evidence: { model: "spam-graph-v3", cluster_id: "cl-77" },
    });
    await service.closePeriod("2026-09");
    await service.finalizeSettlement("2026-09");
    const stmt = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
    const ex = stmt.exclusions.find((e) => e.signal_id === s.signal_id);
    assert.equal(ex.reason, "ANOMALY_VERDICT");
    assert.equal(ex.evidence.model, "spam-graph-v3");
  } finally {
    await cleanup();
  }
});

test("复算哈希一致：按封账序号重放得到同一 calculation_hash", async () => {
  const { service, cleanup } = await setup();
  try {
    await service.ingestSignal(signals.favorite());
    await service.ingestSignal(signals.play({ payload: { viewer_token: "viewer-A", progress: 0.95, play_id: "p1" } }));
    await service.closePeriod("2026-09");
    await service.finalizeSettlement("2026-09");
    const v = await service.reverify("2026-09");
    assert.equal(v.matches, true);
  } finally {
    await cleanup();
  }
});

test("封账后申报的控制关系不溯及既往（原结算单保持可复算）", async () => {
  const { service, cleanup } = await setup();
  try {
    const s = await service.ingestSignal(signals.play({ payload: { viewer_token: "viewer-A", progress: 1, play_id: "p1" } }));
    await service.closePeriod("2026-09");
    await service.finalizeSettlement("2026-09");
    const hashBefore = (await service.reverify("2026-09")).stored_hash;
    await service.declareControl({ group_id: "g-late", creator_ids: ["c-laoshe"], viewer_tokens: ["viewer-A"] });
    // 原单哈希不变、复算一致；该信号只能通过申诉/人工修正处理。
    assert.equal((await service.reverify("2026-09")).stored_hash, hashBefore);
    const stmt = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
    assert.ok(!stmt.exclusions.some((e) => e.signal_id === s.signal_id));
  } finally {
    await cleanup();
  }
});

test("复式记账：结算后支出与应付平衡，总账恒守恒", async () => {
  const { service, cleanup } = await setup();
  try {
    await service.ingestSignal(signals.play({ payload: { viewer_token: "v-real", progress: 1, play_id: "p" } }));
    await service.closePeriod("2026-09");
    await service.finalizeSettlement("2026-09");
    const report = service.ledgerReport();
    assert.equal(report.balanced, true);
    assert.equal(report.accounts.find(([a]) => a === ACCOUNTS.PERIOD_EXPENSE("2026-09"))[1], 120);
    assert.equal(report.accounts.find(([a]) => a === ACCOUNTS.PAYABLE("c-laoshe"))[1], -120);
  } finally {
    await cleanup();
  }
});

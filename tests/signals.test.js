import assert from "node:assert/strict";
import test from "node:test";
import { makeService, classicWork, signals } from "./helpers.js";

async function setup() {
  const ctx = await makeService();
  await ctx.service.openPeriod({ period: "2026-09", fund_cents: 100000 });
  await ctx.service.registerWork(classicWork());
  return ctx;
}

test("重复上报不第二次贡献价值（同业务键冲突）", async () => {
  const { service, cleanup } = await setup();
  try {
    await service.ingestSignal(signals.play());
    await assert.rejects(() => service.ingestSignal(signals.play()), (e) => e.code === "DUPLICATE_REPORT");
  } finally {
    await cleanup();
  }
});

test("同幂等键的客户端重试原样回放，不新增事件", async () => {
  const { service, store, cleanup } = await setup();
  try {
    const r1 = await service.ingestSignal(signals.play(), { idemKey: "req-1" });
    const r2 = await service.ingestSignal(signals.play(), { idemKey: "req-1" });
    assert.equal(r1.signal_id, r2.signal_id);
    assert.equal(r2.replayed, true);
    const count = store.events().filter((e) => e.kind === "VALUE_SIGNAL_INGESTED").length;
    assert.equal(count, 1);
  } finally {
    await cleanup();
  }
});

test("事件存储层幂等键同样去重", async () => {
  const { store, cleanup } = await makeService();
  try {
    const e1 = await store.append("PERIOD_OPENED", { period: "2026-09", fund_cents: 1 }, { idemKey: "k" });
    const e2 = await store.append("PERIOD_OPENED", { period: "2026-09", fund_cents: 2 }, { idemKey: "k" });
    assert.equal(e1.event_id, e2.event_id);
    assert.equal(store.events().length, 1);
  } finally {
    await cleanup();
  }
});

test("载荷携带手机号/邮箱等可标识信息被拒收，且不写日志", async () => {
  const { service, store, cleanup } = await setup();
  try {
    const base = store.events().length;
    await assert.rejects(
      () => service.ingestSignal(signals.play({ payload: {
        viewer_token: "viewer-A", progress: 0.9, play_id: "p-x",
        phone: "13800138000",
      } })),
      (e) => e.code === "PII_DETECTED",
    );
    await assert.rejects(
      () => service.ingestSignal(signals.play({ payload: {
        viewer_token: "viewer-A", progress: 0.9, play_id: "p-y",
        session_id: "contact me a@b.com",
      } })),
      (e) => e.code === "PII_DETECTED",
    );
    assert.equal(store.events().length, base);
  } finally {
    await cleanup();
  }
});

test("入库后只剩 viewer_h，原始 viewer_token 不落盘", async () => {
  const { service, store, cleanup } = await setup();
  try {
    await service.ingestSignal(signals.play());
    const evt = store.events().find((e) => e.kind === "VALUE_SIGNAL_INGESTED");
    assert.match(evt.payload.payload.viewer_h, /^vh_[0-9a-f]{32}$/);
    assert.equal("viewer_token" in evt.payload.payload, false);
    assert.ok(!JSON.stringify(evt).includes("viewer-A"));
  } finally {
    await cleanup();
  }
});

test("收藏后打开必须有收藏前置事实", async () => {
  const { service, cleanup } = await setup();
  try {
    await assert.rejects(() => service.ingestSignal(signals.favoriteOpen()), (e) => e.code === "PREREQUISITE_MISSING");
    await service.ingestSignal(signals.favorite());
    const ok = await service.ingestSignal(signals.favoriteOpen());
    assert.equal(ok.signal_type, "FAVORITE_OPEN");
  } finally {
    await cleanup();
  }
});

test("跨日回访要求首次观看与回访跨越自然日", async () => {
  const { service, cleanup } = await setup();
  try {
    await assert.rejects(
      () => service.ingestSignal(signals.revisit({
        payload: {
          viewer_token: "viewer-A", session_id: "s",
          first_seen: "2026-09-10T20:00:00+08:00",
          revisit_at: "2026-09-10T23:00:00+08:00",
        },
      })),
      (e) => e.code === "NOT_CROSS_DAY",
    );
    const ok = await service.ingestSignal(signals.revisit());
    assert.equal(ok.signal_type, "CROSS_DAY_REVISIT");
  } finally {
    await cleanup();
  }
});

test("同观众多次进度取最大值，只有一次跨越完成线计值", async () => {
  const { service, cleanup } = await setup();
  try {
    await service.ingestSignal(signals.play({ occurred_at: "2026-09-02T21:00:00+08:00", payload: {
      viewer_token: "viewer-A", progress: 0.4, play_id: "play-A-1",
    } }));
    await service.ingestSignal(signals.play({ occurred_at: "2026-09-03T21:00:00+08:00", payload: {
      viewer_token: "viewer-A", progress: 0.95, play_id: "play-A-2",
    } }));
    await service.ingestSignal(signals.play({ occurred_at: "2026-09-04T21:00:00+08:00", payload: {
      viewer_token: "viewer-A", progress: 0.95, play_id: "play-A-3",
    } }));
    await service.closePeriod("2026-09");
    await service.finalizeSettlement("2026-09");
    const stmt = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
    const valued = stmt.contributions.filter((c) => c.gross_cents > 0);
    assert.equal(valued.length, 1);
    assert.equal(valued[0].unit_cents, 120);
    const infos = stmt.contributions.filter((c) => c.informational);
    assert.ok(infos.some((i) => /重复进度/.test(i.item)));
  } finally {
    await cleanup();
  }
});

test("进度未达完成线的首日低完播不计值但留痕", async () => {
  const { service, cleanup } = await setup();
  try {
    await service.ingestSignal(signals.play({ payload: {
      viewer_token: "viewer-A", progress: 0.35, play_id: "play-A-1",
    } }));
    await service.closePeriod("2026-09");
    await service.finalizeSettlement("2026-09");
    const stmt = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
    assert.equal(stmt.subtotal.net_gross_cents, 0);
    assert.ok(stmt.contributions.some((c) => /未达完成线/.test(c.item)));
  } finally {
    await cleanup();
  }
});

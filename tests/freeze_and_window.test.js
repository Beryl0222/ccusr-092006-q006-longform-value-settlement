import assert from "node:assert/strict";
import test from "node:test";
import { makeService, classicWork } from "./helpers.js";

test("作品发布即冻结版本、时长、作者关系与适用信号", async () => {
  const { service, cleanup } = await makeService();
  try {
    const res = await service.registerWork(classicWork());
    assert.match(res.freeze_hash, /^[0-9a-f]{64}$/);
    const state = service.state();
    const w = state.works.get("w-baicaiyuan");
    assert.equal(w.version, "v1.0.0");
    assert.equal(w.duration_sec, 1500);
    assert.equal(w.creator_id, "c-laoshe");
    assert.ok(w.eligible_signals.includes("CROSS_DAY_REVISIT"));
    // 冻结不可变：重复发布被拒绝。
    await assert.rejects(() => service.registerWork(classicWork()), (e) => e.code === "WORK_EXISTS");
  } finally {
    await cleanup();
  }
});

test("冻结的适用信号收窄后，其余信号被排除并在结算单注明", async () => {
  const { service, cleanup } = await makeService();
  try {
    await service.openPeriod({ period: "2026-09", fund_cents: 100000 });
    await service.registerWork(classicWork({ eligible_signals: ["PLAY_PROGRESS"] }));
    const s = await service.ingestSignal({
      work_id: "w-baicaiyuan",
      signal_type: "VALID_DISCUSSION",
      occurred_at: "2026-09-06T09:00:00+08:00",
      payload: { viewer_token: "v1", discussion_id: "d1", chars: 100, quality: "normal" },
    });
    await service.closePeriod("2026-09");
    await service.finalizeSettlement("2026-09");
    const stmt = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
    const ex = stmt.exclusions.find((e) => e.signal_id === s.signal_id);
    assert.equal(ex.reason, "NOT_ELIGIBLE");
    assert.match(ex.reason_label, /VALID_DISCUSSION/);
  } finally {
    await cleanup();
  }
});

test("结算规则只能从新周期起生效", async () => {
  const { service, clock, cleanup } = await makeService({ start: "2026-09-15T12:00:00+08:00" });
  try {
    const v2 = {
      rule_version: "v2026-10-01",
      weights: {
        completed_view_cents: 200, favorite_open_cents: 100, discussion_cents: 300,
        refund_penalty_cents: 500, cross_day_revisit_cents: 200,
      },
      quality_factor: { high: 1.5, normal: 1, low: 0.5 },
      completion_threshold: 0.8,
      mutual_min_each_direction: 1,
    };
    // 9 月已经开始：不能对 2026-09 生效。
    await assert.rejects(
      () => service.publishRule({ rule: v2, effective_period: "2026-09" }),
      (e) => e.code === "RULE_PERIOD_NOT_FUTURE",
    );
    // 10 月尚未开始：允许。
    const r = await service.publishRule({ rule: v2, effective_period: "2026-10" });
    assert.equal(r.rule_version, "v2026-10-01");
    // 同周期不能再挂第二个版本。
    await assert.rejects(
      () => service.publishRule({ rule: { ...v2, rule_version: "x" }, effective_period: "2026-10" }),
      (e) => e.code === "RULE_EXISTS",
    );
  } finally {
    await cleanup();
  }
});

test("迟到数据只能进入尚未封账的窗口，封账后拒收且不写日志", async () => {
  const { service, store, clock, cleanup } = await makeService();
  try {
    await service.openPeriod({ period: "2026-09", fund_cents: 100000 });
    await service.registerWork(classicWork());
    const before = store.events().length;
    // 月末关账：时钟推进到 10 月 1 日再封 9 月窗口。
    clock.set("2026-10-01T00:05:00+08:00");
    await service.closePeriod("2026-09");
    await assert.rejects(
      () => service.ingestSignal({
        work_id: "w-baicaiyuan",
        signal_type: "PLAY_PROGRESS",
        occurred_at: "2026-09-20T10:00:00+08:00",
        payload: { viewer_token: "viewer-A", progress: 1, play_id: "late-1" },
      }),
      (e) => e.code === "LATE_FOR_CLOSED_PERIOD",
    );
    assert.equal(store.events().length, before + 1 /* 只有封账事件 */);
  } finally {
    await cleanup();
  }
});

test("窗口未开启时信号无法归入", async () => {
  const { service, cleanup } = await makeService();
  try {
    await service.registerWork(classicWork());
    await assert.rejects(
      () => service.ingestSignal({
        work_id: "w-baicaiyuan", signal_type: "PLAY_PROGRESS",
        occurred_at: "2026-08-31T10:00:00+08:00",
        payload: { viewer_token: "v", progress: 1, play_id: "p" },
      }),
      (e) => e.code === "WINDOW_NOT_OPENED",
    );
  } finally {
    await cleanup();
  }
});

test("去标识化盐值过短时拒绝启动", async () => {
  const { SettlementService } = await import("../src/application/services.js");
  assert.throws(() => new SettlementService({ store: {}, pepper: "short" }), /盐值/);
});

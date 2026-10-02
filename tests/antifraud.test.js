// 反作弊与去重：重复上报、同一控制关系、自我互动、互刷闭环、质量门槛、时间倒置。
import assert from "node:assert/strict";
import test from "node:test";
import { setupFixture, at } from "./helpers.js";
import { computeStatement } from "../src/engine.js";
import { buildLedger } from "../src/ledger.js";

test("重复上报不贡献两次价值（自然键去重，先到先得）", () => {
  const { svc, log } = setupFixture();
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_COMPLETION", viewer_key: "v1", occurred_at: "2026-09-04T20:00:00Z", progress: 0.95 }, at("2026-09-04T20:00:00Z"));
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_COMPLETION", viewer_key: "v1", occurred_at: "2026-09-04T20:05:00Z", progress: 1.0 }, at("2026-09-04T20:05:00Z"));
  const stmt = computeStatement(log.events, { period: "2026-09", workId: "w1" });
  assert.equal(stmt.summary.accepted_signal_count, 1);
  assert.equal(stmt.excluded.filter((x) => x.code === "DUPLICATE").length, 1);
  assert.equal(stmt.summary.gross_points, 4.0);
});

test("讨论按 discussion_id 去重，与观众无关；灌水被 LOW_QUALITY 排除", () => {
  const { svc, log } = setupFixture();
  const good = {
    work_id: "w1",
    signal_type: "MEANINGFUL_DISCUSSION",
    viewer_key: "v1",
    discussion_id: "d1",
    occurred_at: "2026-09-06T10:00:00Z",
    discussion: { length_chars: 50, text: "这一段对父爱的处理非常克制" },
  };
  svc.ingestSignal(good, at("2026-09-06T10:00:00Z"));
  svc.ingestSignal({ ...good, viewer_key: "v2" }, at("2026-09-06T10:01:00Z")); // 同 discussion_id
  svc.ingestSignal({ work_id: "w1", signal_type: "MEANINGFUL_DISCUSSION", viewer_key: "v3", discussion_id: "d2", occurred_at: "2026-09-06T11:00:00Z", discussion: { text: "啊啊啊啊啊啊啊啊啊啊" } }, at("2026-09-06T11:00:00Z"));
  const stmt = computeStatement(log.events, { period: "2026-09", workId: "w1" });
  assert.equal(stmt.summary.accepted_signal_count, 1);
  assert.equal(stmt.excluded.some((x) => x.code === "DUPLICATE"), true);
  assert.equal(stmt.excluded.some((x) => x.code === "LOW_QUALITY"), true);
});

test("同一控制关系下的互动被 SAME_CONTROL 排除", () => {
  const { svc, log } = setupFixture();
  svc.declareControlLink({ entities: ["creator_lu", "sock_1", "sock_2"], reason: "同设备" }, at("2026-09-03T00:00:00Z"));
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_REVISIT", viewer_key: "sock_1", occurred_at: "2026-09-05T20:00:00Z" }, at("2026-09-05T20:00:00Z"));
  const stmt = computeStatement(log.events, { period: "2026-09", workId: "w1" });
  assert.equal(stmt.summary.accepted_signal_count, 0);
  assert.equal(stmt.excluded.some((x) => x.code === "SAME_CONTROL"), true);
});

test("作者自我互动被 SELF 排除", () => {
  const { svc, log } = setupFixture();
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_REVISIT", viewer_key: "creator_lu", occurred_at: "2026-09-05T20:00:00Z" }, at("2026-09-05T20:00:00Z"));
  const ledger = buildLedger(log.events);
  assert.equal(ledger.excluded.some((x) => x.code === "SELF"), true);
});

test("互刷闭环 A→B→A 被 RECIPROCAL 排除，环外单向观看不连坐", () => {
  const { svc, log } = setupFixture();
  // 两个互刷号各自的作品
  svc.registerWork({ work_id: "wb", version: "v1", content_hash: "b", duration_seconds: 300, author_id: "u_b", published_at: "2026-09-03T08:00:00Z", applicable_signals: ["CROSS_DAY_REVISIT"] }, at("2026-09-03T08:00:00Z"));
  svc.registerWork({ work_id: "wa", version: "v1", content_hash: "a", duration_seconds: 300, author_id: "u_a", published_at: "2026-09-03T08:00:00Z", applicable_signals: ["CROSS_DAY_REVISIT"] }, at("2026-09-03T08:00:00Z"));
  // 闭环：u_a 看 b，u_b 看 a
  svc.ingestSignal({ work_id: "wb", signal_type: "CROSS_DAY_REVISIT", viewer_key: "u_a", occurred_at: "2026-09-10T09:00:00Z" }, at("2026-09-10T09:00:00Z"));
  svc.ingestSignal({ work_id: "wa", signal_type: "CROSS_DAY_REVISIT", viewer_key: "u_b", occurred_at: "2026-09-10T09:10:00Z" }, at("2026-09-10T09:10:00Z"));
  // u_a 去看陆老师：单向边，不在闭环上，应采信
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_REVISIT", viewer_key: "u_a", occurred_at: "2026-09-11T09:00:00Z" }, at("2026-09-11T09:00:00Z"));

  const stmtB = computeStatement(log.events, { period: "2026-09", workId: "wb" });
  assert.equal(stmtB.excluded.some((x) => x.code === "RECIPROCAL"), true);
  const stmtW1 = computeStatement(log.events, { period: "2026-09", workId: "w1" });
  assert.equal(stmtW1.summary.accepted_signal_count, 1);
});

test("发布当日的跨日信号被 NOT_CROSS_DAY 排除", () => {
  const { svc, log } = setupFixture();
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_REVISIT", viewer_key: "v_same", occurred_at: "2026-09-02T23:00:00Z" }, at("2026-09-02T23:00:00Z"));
  const ledger = buildLedger(log.events);
  assert.equal(ledger.excluded.some((x) => x.code === "NOT_CROSS_DAY"), true);
});

test("跨日完播进度不足被 BELOW_PROGRESS 排除", () => {
  const { svc, log } = setupFixture();
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_COMPLETION", viewer_key: "v_low", occurred_at: "2026-09-04T20:00:00Z", progress: 0.5 }, at("2026-09-04T20:00:00Z"));
  const ledger = buildLedger(log.events);
  assert.equal(ledger.excluded.some((x) => x.code === "BELOW_PROGRESS"), true);
});

test("信号早于作品发布被 PRIOR_TO_PUBLICATION 排除", () => {
  const { svc, log } = setupFixture();
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_REVISIT", viewer_key: "v_time", occurred_at: "2026-09-01T08:00:00Z" }, at("2026-09-01T08:00:00Z"));
  const ledger = buildLedger(log.events);
  assert.equal(ledger.excluded.some((x) => x.code === "PRIOR_TO_PUBLICATION"), true);
});

test("收藏后打开缺少在先收藏被 NOT_FAVORITED 排除", () => {
  const { svc, log } = setupFixture();
  // 有 favorite_id（通过入口校验），但没有在先 favorited_at → 无法认定收藏后回访
  svc.ingestSignal({ work_id: "w1", signal_type: "FAVORITE_THEN_OPEN", viewer_key: "v_fav", favorite_id: "fav_x", occurred_at: "2026-09-08T10:00:00Z" }, at("2026-09-08T10:00:00Z"));
  const ledger = buildLedger(log.events);
  assert.equal(ledger.excluded.some((x) => x.code === "NOT_FAVORITED"), true);
});

test("不在作品适用信号范围内被 NOT_APPLICABLE 排除", () => {
  const { svc, log } = setupFixture();
  svc.registerWork({ work_id: "w2", version: "v1", content_hash: "c", duration_seconds: 60, author_id: "creator_lu", published_at: "2026-09-03T08:00:00Z", applicable_signals: ["COMPLETION"] }, at("2026-09-03T08:00:00Z"));
  svc.ingestSignal({ work_id: "w2", signal_type: "CROSS_DAY_REVISIT", viewer_key: "v_x", occurred_at: "2026-09-06T08:00:00Z" }, at("2026-09-06T08:00:00Z"));
  const ledger = buildLedger(log.events);
  assert.equal(ledger.excluded.some((x) => x.code === "NOT_APPLICABLE"), true);
});

test("未知作品被 UNKNOWN_WORK 排除", () => {
  const { svc } = setupFixture();
  svc.ingestSignal({ work_id: "ghost", signal_type: "COMPLETION", viewer_key: "v_g", occurred_at: "2026-09-06T08:00:00Z", progress: 1 }, at("2026-09-06T08:00:00Z"));
  const ledger = buildLedger(svc.log.events);
  assert.equal(ledger.excluded.some((x) => x.code === "UNKNOWN_WORK"), true);
});

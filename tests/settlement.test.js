// 结算幂等、可复算、申诉冻结、maker/checker 修正与总账守恒。
import assert from "node:assert/strict";
import test from "node:test";
import { setupFixture, at } from "./helpers.js";
import { computeStatement } from "../src/engine.js";
import { buildProjectedLedger } from "../src/postings.js";
import { EventLog } from "../src/event_log.js";
import { SettlementService } from "../src/service.js";
import { rm } from "node:fs/promises";

const FINANCE = { actor_id: "fin_wang", role: "FINANCE" };
const FINANCE2 = { actor_id: "fin_zhao", role: "FINANCE" };
const OPERATOR = { actor_id: "op_li", role: "OPERATOR" };
const OTHER_OP = { actor_id: "op_chen", role: "OPERATOR" };
const LU = { actor_id: "creator_lu", role: "CREATOR" };

function seedValue(svc) {
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_COMPLETION", viewer_key: "v1", occurred_at: "2026-09-04T20:00:00Z", progress: 0.95 }, at("2026-09-04T20:00:00Z"));
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_REVISIT", viewer_key: "v2", occurred_at: "2026-09-07T20:00:00Z" }, at("2026-09-07T20:00:00Z"));
  svc.recordRefund({ work_id: "w1", refund_id: "r1", occurred_at: "2026-09-15T10:00:00Z", units: 1 }, at("2026-09-15T10:00:00Z"));
}

test("结算结果可复算：相同日志产出相同净值与 input_hash", () => {
  const { svc, log } = setupFixture();
  seedValue(svc);
  const a = computeStatement(log.events, { period: "2026-09", workId: "w1" });
  const b = computeStatement(log.events, { period: "2026-09", workId: "w1" });
  assert.equal(a.input_hash, b.input_hash);
  assert.equal(a.summary.net_points, 4 + 1.5 - 3); // 跨日完播 4 + 跨日回访 1.5 - 退款 3
});

test("重复结算幂等：不产生第二份价值", () => {
  const { svc } = setupFixture();
  seedValue(svc);
  svc.closePeriod("2026-09", FINANCE, at("2026-10-05T00:00:00Z"));
  const first = svc.settleWork("2026-09", "w1", FINANCE, at("2026-10-06T09:00:00Z"));
  const second = svc.settleWork("2026-09", "w1", FINANCE, at("2026-10-06T09:01:00Z"));
  assert.equal(first.duplicated, false);
  assert.equal(second.duplicated, true);
  const settles = svc.log.events.filter((e) => e.kind === "SETTLEMENT_RECORDED");
  assert.equal(settles.length, 1);
});

test("非财务不能执行结算", () => {
  const { svc } = setupFixture();
  seedValue(svc);
  assert.throws(() => svc.settleWork("2026-09", "w1", OPERATOR, at("2026-10-06T09:00:00Z")), /FINANCE/);
});

test("未封账不能结算：必须先封账冻结输入", () => {
  const { svc } = setupFixture();
  seedValue(svc);
  assert.throws(() => svc.settleWork("2026-09", "w1", FINANCE, at("2026-10-06T09:00:00Z")), /尚未封账/);
});

test("申诉冻结当时计算：后续修正不改变申诉快照", () => {
  const { svc } = setupFixture();
  seedValue(svc);
  const before = computeStatement(svc.log.events, { period: "2026-09", workId: "w1" });
  const appeal = svc.fileAppeal({ period: "2026-09", workId: "w1", by: LU, reason: "申请复核" }, at("2026-10-07T00:00:00Z"));
  // 之后发生补结
  const prop = svc.proposeAdjustment({ period: "2026-09", workId: "w1", kind: "TOPUP", delta_points: 2, reason: "补", by: OPERATOR, appeal_id: appeal.appeal_id }, at("2026-10-07T12:00:00Z"));
  svc.approveAdjustment(prop.adjustment_id, FINANCE, at("2026-10-08T09:00:00Z"));
  const snap = svc.getAppealSnapshot(appeal.appeal_id);
  assert.equal(snap.statement.input_hash, before.input_hash);
  assert.equal(snap.statement.summary.net_points, before.summary.net_points);
});

test("创作者只能申诉自己名下作品", () => {
  const { svc } = setupFixture();
  seedValue(svc);
  assert.throws(() => svc.fileAppeal({ period: "2026-09", workId: "w1", by: { actor_id: "someone_else", role: "CREATOR" }, reason: "x" }, at("2026-10-07T00:00:00Z")), /自己名下/);
});

test("maker/checker 分离：运营提议必须由另一财务复核", () => {
  const { svc } = setupFixture();
  seedValue(svc);
  // 运营不能自批（角色不符）
  const prop = svc.proposeAdjustment({ period: "2026-09", workId: "w1", kind: "TOPUP", delta_points: 2, reason: "补", by: OPERATOR }, at("2026-10-07T12:00:00Z"));
  assert.throws(() => svc.approveAdjustment(prop.adjustment_id, { actor_id: "op_li", role: "FINANCE" }, at("2026-10-07T13:00:00Z")), /同一人/);
  // 财务复核成功
  assert.doesNotThrow(() => svc.approveAdjustment(prop.adjustment_id, FINANCE2, at("2026-10-08T09:00:00Z")));
  // 不能重复决定
  assert.throws(() => svc.approveAdjustment(prop.adjustment_id, FINANCE, at("2026-10-08T10:00:00Z")), /已复核/);
});

test("撤销为负、补结为正，复式总账守恒", () => {
  const { svc } = setupFixture();
  seedValue(svc);
  svc.closePeriod("2026-09", FINANCE, at("2026-10-05T00:00:00Z"));
  svc.settleWork("2026-09", "w1", FINANCE, at("2026-10-06T09:00:00Z"));
  const topup = svc.proposeAdjustment({ period: "2026-09", workId: "w1", kind: "TOPUP", delta_points: 2.5, reason: "补结", by: OPERATOR }, at("2026-10-07T12:00:00Z"));
  svc.approveAdjustment(topup.adjustment_id, FINANCE2, at("2026-10-08T09:00:00Z"));
  const reversal = svc.proposeAdjustment({ period: "2026-09", workId: "w1", kind: "REVERSAL", delta_points: 1.5, reason: "撤销", by: OTHER_OP }, at("2026-10-08T10:00:00Z"));
  svc.approveAdjustment(reversal.adjustment_id, FINANCE, at("2026-10-08T11:00:00Z"));

  const gl = buildProjectedLedger(svc.log.events);
  const v = gl.verifyConservation();
  assert.equal(v.conserved, true);
  assert.equal(v.total, 0);
  // 原净值 2.5，补结 +2.5，撤销 -1.5 → 应付 3.5 点 = 350 分
  assert.equal(gl.payableOf("creator_lu"), 350);

  const stmt = computeStatement(svc.log.events, { period: "2026-09", workId: "w1" });
  assert.equal(stmt.summary.adjustment_points, 1);
  assert.equal(stmt.summary.net_points, 3.5);
});

test("被驳回的修正不产生任何分录", () => {
  const { svc } = setupFixture();
  seedValue(svc);
  svc.closePeriod("2026-09", FINANCE, at("2026-10-05T00:00:00Z"));
  svc.settleWork("2026-09", "w1", FINANCE, at("2026-10-06T09:00:00Z"));
  const prop = svc.proposeAdjustment({ period: "2026-09", workId: "w1", kind: "TOPUP", delta_points: 5, reason: "证据不足", by: OPERATOR }, at("2026-10-07T12:00:00Z"));
  svc.rejectAdjustment(prop.adjustment_id, FINANCE2, { reason: "证据不足", now: "2026-10-08T09:00:00Z" });
  const gl = buildProjectedLedger(svc.log.events);
  assert.equal(gl.entries.length, 1); // 仅原始结算
});

test("事件日志哈希链：篡改任意字段将无法加载", async () => {
  const file = `/tmp/lf-tamper-${process.pid}.jsonl`;
  await rm(file, { force: true });
  const fresh = new SettlementService(await EventLog.fromFile(file));
  fresh.openPeriod("2026-09", { now: "2026-09-01T00:00:00Z" });
  await fresh.log.flush();
  // 手工破坏第二行内容
  const { readFile, writeFile } = await import("node:fs/promises");
  let text = await readFile(file, "utf8");
  text = text.replace("PERIOD_OPENED", "PERIOD_CLOSED");
  await writeFile(file, text);
  await assert.rejects(() => EventLog.fromFile(file), /哈希链断裂/);
  await rm(file, { force: true });
});

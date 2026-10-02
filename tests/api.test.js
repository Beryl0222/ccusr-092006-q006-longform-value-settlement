// HTTP API 集成测试：在随机端口启动内存日志服务，走完整 REST 流程。
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { createApp } from "../src/server.js";

const STORE = `/tmp/lf-api-${process.pid}.jsonl`;
let base;
let server;

test.before(async () => {
  await rm(STORE, { force: true });
  server = await createApp({ store: STORE });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(STORE, { force: true });
});

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

const FINANCE_HEADERS = { "x-actor-id": "fin_wang", "x-actor-role": "FINANCE" };
const OPERATOR_HEADERS = { "x-actor-id": "op_li", "x-actor-role": "OPERATOR" };
const LU_HEADERS = { "x-actor-id": "creator_lu", "x-actor-role": "CREATOR" };

test("规则 → 开窗 → 作品冻结 → 信号 → 封账 → 结算 → 结算单 全链路", async () => {
  const rule = {
    rule_id: "rule-v1-2026-09",
    version: 1,
    effective_from: "2026-09",
    published_at: "2026-09-01T00:00:00Z",
    weights: { CROSS_DAY_COMPLETION: 4, FAVORITE_THEN_OPEN: 2.5, MEANINGFUL_DISCUSSION: 3, CROSS_DAY_REVISIT: 1.5, COMPLETION: 0.5 },
    discussionThresholds: { minLengthChars: 12, minReplies: 0, forbidRepeatedChars: true },
    refundPenaltyPerUnit: 3,
    crossDayAfterDays: 1,
    completionProgressThreshold: 0.9,
    unitValueYuan: 1,
  };
  assert.equal((await call("POST", "/rules", rule)).status, 201);
  assert.equal((await call("POST", "/periods/2026-09/open", {})).status, 201);

  const work = {
    work_id: "wapi1",
    title: "API 经典课文",
    version: "v1",
    content_hash: "sha256:api",
    duration_seconds: 2000,
    author_id: "creator_lu",
    published_at: "2026-09-02T20:00:00Z",
    applicable_signals: ["CROSS_DAY_COMPLETION", "FAVORITE_THEN_OPEN", "MEANINGFUL_DISCUSSION", "CROSS_DAY_REVISIT", "COMPLETION"],
  };
  assert.equal((await call("POST", "/works", work)).status, 201);

  assert.equal(
    (
      await call("POST", "/signals", {
        work_id: "wapi1",
        signal_type: "CROSS_DAY_COMPLETION",
        viewer_key: "vk_real_1",
        occurred_at: "2026-09-04T21:00:00Z",
        progress: 0.97,
      })
    ).status,
    201,
  );
  // 重复上报
  await call("POST", "/signals", { work_id: "wapi1", signal_type: "CROSS_DAY_COMPLETION", viewer_key: "vk_real_1", occurred_at: "2026-09-04T21:05:00Z", progress: 1 });

  // 运营封账被拒
  assert.equal((await call("POST", "/periods/2026-09/close", {}, OPERATOR_HEADERS)).status, 400);
  assert.equal((await call("POST", "/periods/2026-09/close", {}, FINANCE_HEADERS)).status, 201);

  // 封账后迟到信号
  await call("POST", "/signals", { work_id: "wapi1", signal_type: "CROSS_DAY_REVISIT", viewer_key: "vk_late", occurred_at: "2026-09-20T20:00:00Z" });

  const settle = await call("POST", "/settlements", { period: "2026-09", work_id: "wapi1" }, FINANCE_HEADERS);
  assert.equal(settle.status, 201);
  assert.equal(settle.json.statement.summary.net_points, 4);
  assert.equal(settle.json.statement.excluded.some((x) => x.code === "DUPLICATE"), true);
  assert.equal(settle.json.statement.excluded.some((x) => x.code === "LATE"), true);

  // 再次结算幂等
  const again = await call("POST", "/settlements", { period: "2026-09", work_id: "wapi1" }, FINANCE_HEADERS);
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicated, true);

  // 文本结算单
  const res = await fetch(`${base}/periods/2026-09/works/wapi1/statement.txt`);
  const text = await res.text();
  assert.match(text, /哪些长期信号形成了扶持/);
  assert.match(text, /哪些流量因何被排除/);
  assert.match(text, /净价值/);
});

test("申诉与双角色修正：自批拒绝、异角色复核通过", async () => {
  const appeal = await call(
    "POST",
    "/appeals",
    { period: "2026-09", work_id: "wapi1", reason: "复核" },
    LU_HEADERS,
  );
  assert.equal(appeal.status, 201);
  assert.ok(appeal.json.snapshot.statement.input_hash);

  const proposed = await call(
    "POST",
    "/adjustments",
    { period: "2026-09", work_id: "wapi1", kind: "TOPUP", delta_points: 2, reason: "补结 2 点", appeal_id: appeal.json.appeal_id },
    OPERATOR_HEADERS,
  );
  assert.equal(proposed.status, 201);
  const adjId = proposed.json.adjustment_id;

  // 运营（即使伪造财务角色头）同一人复核被拒
  assert.equal((await call("POST", `/adjustments/${adjId}/approve`, {}, { "x-actor-id": "op_li", "x-actor-role": "FINANCE" })).status, 400);
  // 财务另一人通过
  assert.equal((await call("POST", `/adjustments/${adjId}/approve`, {}, FINANCE_HEADERS)).status, 201);

  const cons = await call("GET", "/ledger/conservation");
  assert.equal(cons.json.conserved, true);
  assert.equal(cons.json.total_cents, 0);
});

test("服务重启后从哈希链 JSONL 完整恢复", async () => {
  // 复用同一 STORE 文件创建新 app 实例
  const restored = await createApp({ store: STORE });
  await new Promise((resolve) => restored.listen(0, resolve));
  const port2 = restored.address().port;
  const health = await (await fetch(`http://127.0.0.1:${port2}/health`)).json();
  assert.ok(health.events > 0);
  const stmt = await (await fetch(`http://127.0.0.1:${port2}/periods/2026-09/works/wapi1/statement`)).json();
  assert.equal(stmt.summary.net_points, 6); // 4 + 补结 2
  restored.close();
});

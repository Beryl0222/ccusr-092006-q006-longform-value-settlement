import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { EventStore } from "../src/infra/event_store.js";
import { SettlementService } from "../src/application/services.js";
import { createHttpApi } from "../src/interfaces/http_server.js";

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "lvs-http-"));
  const store = await new EventStore(join(dir, "events.jsonl")).load();
  const service = new SettlementService({ store, pepper: "http-test-pepper-0123456789" });
  const server = createHttpApi(service);
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, service,
    stop: async () => { await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); },
  };
}

async function call(base, method, path, body, { actor, role, idem } = {}) {
  const headers = { "content-type": "application/json" };
  if (actor) headers["x-actor-id"] = actor;
  if (role) headers["x-actor-role"] = role;
  if (idem) headers["idempotency-key"] = idem;
  const res = await fetch(base + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("HTTP：完整关账链路 + 迟到数据 409 + 结算单可查", async () => {
  const { base, stop } = await startServer();
  try {
    assert.equal((await call(base, "GET", "/health")).status, 200);

    assert.equal((await call(base, "POST", "/periods/open", { period: "2026-09", fund_cents: 100000 }, { actor: "fin-li", role: "FINANCE_ADMIN" })).status, 201);
    assert.equal((await call(base, "POST", "/works", {
      work_id: "w1", title: "经典长内容", creator_id: "c1", version: "v1", duration_sec: 1500,
    }, { actor: "system" })).status, 201);

    const sig = await call(base, "POST", "/signals", {
      work_id: "w1", signal_type: "PLAY_PROGRESS", occurred_at: "2026-09-03T20:00:00+08:00",
      payload: { viewer_token: "viewer-A", progress: 0.95, play_id: "p1" },
    }, { idem: "client-req-1" });
    assert.equal(sig.status, 202);
    assert.match(sig.json.viewer_h, /^vh_/);

    // PII 被 422 拒绝。
    const pii = await call(base, "POST", "/signals", {
      work_id: "w1", signal_type: "PLAY_PROGRESS", occurred_at: "2026-09-03T20:00:00+08:00",
      payload: { viewer_token: "viewer-A", progress: 1, play_id: "p2", phone: "13800138000" },
    });
    assert.equal(pii.status, 422);
    assert.equal(pii.json.error, "PII_DETECTED");

    // 同幂等键重试返回同一信号（202，replayed）。
    const retry = await call(base, "POST", "/signals", {
      work_id: "w1", signal_type: "PLAY_PROGRESS", occurred_at: "2026-09-03T20:00:00+08:00",
      payload: { viewer_token: "viewer-A", progress: 0.95, play_id: "p1" },
    }, { idem: "client-req-1" });
    assert.equal(retry.status, 202);
    assert.equal(retry.json.signal_id, sig.json.signal_id);

    // 无幂等键的重复业务事实 → 409。
    const dup = await call(base, "POST", "/signals", {
      work_id: "w1", signal_type: "PLAY_PROGRESS", occurred_at: "2026-09-03T20:00:00+08:00",
      payload: { viewer_token: "viewer-A", progress: 0.95, play_id: "p1" },
    });
    assert.equal(dup.status, 409);

    assert.equal((await call(base, "POST", "/periods/2026-09/close", {}, { actor: "fin-li" })).status, 200);

    // 封账后迟到数据 409。
    const late = await call(base, "POST", "/signals", {
      work_id: "w1", signal_type: "PLAY_PROGRESS", occurred_at: "2026-09-20T20:00:00+08:00",
      payload: { viewer_token: "viewer-X", progress: 1, play_id: "late" },
    });
    assert.equal(late.status, 409);
    assert.equal(late.json.error, "LATE_FOR_CLOSED_PERIOD");

    const fin = await call(base, "POST", "/periods/2026-09/finalize", {});
    assert.equal(fin.status, 200);

    const rev = await call(base, "GET", "/periods/2026-09/reverify");
    assert.equal(rev.json.matches, true);

    const stmt = await call(base, "GET", "/statements?period=2026-09&work_id=w1");
    assert.equal(stmt.status, 200);
    assert.equal(stmt.json.allocation.final_cents, 120);

    const ledger = await call(base, "GET", "/ledger");
    assert.equal(ledger.json.balanced, true);

    const events = await call(base, "GET", "/events");
    assert.ok(events.json.count >= 5);
  } finally {
    await stop();
  }
});

test("HTTP：人工修正的角色隔离（403）", async () => {
  const { base, stop } = await startServer();
  try {
    await call(base, "POST", "/periods/open", { period: "2026-09", fund_cents: 100000 }, { actor: "fin-li" });
    await call(base, "POST", "/works", { work_id: "w1", title: "t", creator_id: "c1", version: "v1", duration_sec: 600 });
    await call(base, "POST", "/signals", {
      work_id: "w1", signal_type: "PLAY_PROGRESS", occurred_at: "2026-09-03T20:00:00+08:00",
      payload: { viewer_token: "v", progress: 1, play_id: "p" },
    });
    await call(base, "POST", "/periods/2026-09/close", {}, { actor: "fin-li" });
    await call(base, "POST", "/periods/2026-09/finalize", {});

    // 非运营角色不能发起修正。
    const forbidden = await call(base, "POST", "/adjustments", {
      period: "2026-09", work_id: "w1", type: "SUPPLEMENT", cents: 100, reason: "x",
    }, { actor: "fin-li", role: "FINANCE_ADMIN" });
    assert.equal(forbidden.status, 403);
  } finally {
    await stop();
  }
});

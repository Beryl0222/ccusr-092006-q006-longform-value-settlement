import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, readFile } from "node:fs/promises";
import { makeService } from "./helpers.js";

test("事件日志被篡改时重放抛错（哈希链断裂）", async () => {
  const { service, path, cleanup } = await makeService();
  try {
    await service.openPeriod({ period: "2026-09", fund_cents: 100 });
    const text = await readFile(path, "utf8");
    const [first, ...rest] = text.split("\n").filter(Boolean);
    const entry = JSON.parse(first);
    entry.payload.fund_cents = 999; // 篡改资金池
    await writeFile(path, [JSON.stringify(entry), ...rest].join("\n") + "\n");

    const { EventStore } = await import("../src/infra/event_store.js");
    await assert.rejects(() => new EventStore(path).load(), (e) => e.code === "LOG_TAMPERED");
  } finally {
    await cleanup();
  }
});

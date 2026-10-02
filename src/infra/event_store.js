// 只追加事件日志：JSONL，每条带序号与前条哈希。
// 重放时校验哈希链，任何篡改都会被发现。
import { mkdir, readFile, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { newId } from "../domain/hash.js";
import { DomainError } from "../domain/time.js";

function hashEntry(prevHash, body) {
  return createHash("sha256").update(`${prevHash}\n${JSON.stringify(body)}`).digest("hex");
}

export class EventStore {
  constructor(path) {
    this.path = path;
    this._events = null;
    this._idempotency = new Map(); // idem_key -> event_id
  }

  async load() {
    let text = "";
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        this._events = [];
        return this;
      }
      throw err;
    }
    const events = [];
    let prev = "GENESIS";
    text.split("\n").filter(Boolean).forEach((line, idx) => {
      const entry = JSON.parse(line);
      const { hash, ...body } = entry;
      const expect = hashEntry(prev, body);
      if (hash !== expect) {
        throw new DomainError(`事件日志哈希链在第 ${idx + 1} 条断裂`, "LOG_TAMPERED");
      }
      prev = hash;
      events.push(entry);
      if (body.idem_key) this._idempotency.set(body.idem_key, body.event_id);
    });
    this._events = events;
    return this;
  }

  events() {
    if (!this._events) throw new DomainError("事件存储尚未 load()", "STORE_NOT_READY");
    return this._events;
  }

  // 幂等追加：同一 idem_key 直接返回既有事件，绝不产生第二条。
  async append(kind, payload, { idemKey = null, actor = "SYSTEM", occurredAt = new Date().toISOString() } = {}) {
    if (!this._events) await this.load();
    if (idemKey && this._idempotency.has(idemKey)) {
      const existingId = this._idempotency.get(idemKey);
      return this._events.find((e) => e.event_id === existingId);
    }
    const seq = this._events.length + 1;
    const prevHash = this._events.length === 0 ? "GENESIS" : this._events[this._events.length - 1].hash;
    const body = {
      event_id: newId("evt"),
      seq,
      kind,
      occurred_at: occurredAt,
      actor,
      subject_id: payload.work_id ?? payload.period ?? "system",
      payload,
    };
    if (idemKey) body.idem_key = idemKey;
    const hash = hashEntry(prevHash, body);
    const entry = { ...body, hash };

    await mkdir(dirname(this.path), { recursive: true });
    // 先写临时文件再原子替换地追加不太适用于 append 语义；这里串行追加 + fsync 风格的句柄复用。
    const fh = await open(this.path, "a");
    try {
      await fh.appendFile(JSON.stringify(entry) + "\n", "utf8");
    } finally {
      await fh.close();
    }
    this._events.push(entry);
    if (idemKey) this._idempotency.set(idemKey, body.event_id);
    return entry;
  }
}

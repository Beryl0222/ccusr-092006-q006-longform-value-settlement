// 事件日志：只追加（append-only）、哈希链防篡改、按 event_id 幂等。
// 这是整个结算后端唯一的事实来源（source of truth）。结算结果可以随时丢弃重算。
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256 } from "./hash.js";
import { validateEvent } from "./longform_value_settlement.js";

export class EventLog {
  constructor() {
    /** @type {Array<object>} 已落账事件，按追加顺序 */
    this.events = [];
    /** @type {Set<string>} 幂等键：同一 event_id 只接受一次 */
    this._seen = new Set();
    /** 上一个事件的哈希，形成哈希链 */
    this._prevHash = "0".repeat(64);
    this._file = null;
  }

  /** 从 JSONL 文件加载（若已被外部改动导致断链会直接报错——证据链不允许断裂）。 */
  static async fromFile(file) {
    const log = new EventLog();
    log._file = file;
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return log;
      throw err;
    }
    for (const [idx, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error(`事件日志第 ${idx + 1} 行不是合法 JSON，证据链不可读`);
      }
      const problems = validateEvent(record);
      if (problems.length) throw new Error(`事件日志第 ${idx + 1} 行不合规: ${problems.join("；")}`);
      if (record._prevHash !== log._prevHash || record._hash !== chainHash(record, log._prevHash)) {
        throw new Error(`事件日志第 ${idx + 1} 行哈希链断裂，日志可能被篡改`);
      }
      if (log._seen.has(record.event_id)) throw new Error(`事件日志第 ${idx + 1} 行 event_id 重复: ${record.event_id}`);
      log._seen.add(record.event_id);
      log._prevHash = record._hash;
      log.events.push(stripChainFields(record));
    }
    return log;
  }

  /**
   * 追加一个事件。返回落账后的完整记录（含哈希链字段）。
   * 重复 event_id 返回 null（幂等丢弃，而不是报错中断批处理）。
   */
  append(record, { now = new Date().toISOString() } = {}) {
    const problems = validateEvent(record);
    if (problems.length) throw new Error(`事件不合规: ${problems.join("；")}`);
    if (this._seen.has(record.event_id)) return null;

    const stored = { ...record };
    if (!stored.ingested_at) stored.ingested_at = now; // 入账时刻：用于判定迟到数据
    stored._prevHash = this._prevHash;
    stored._hash = chainHash(stored, this._prevHash);

    this._seen.add(stored.event_id);
    this._prevHash = stored._hash;
    this.events.push(stripChainFields(stored));
    this._dirty = true;
    return stored;
  }

  /** 同步刷盘（先写临时文件再原子改名 + 全量重写，保证证据文件不出现半行）。 */
  async flush() {
    if (!this._file || !this._dirty) return;
    await mkdir(dirname(this._file), { recursive: true });
    let prev = "0".repeat(64);
    const lines = [];
    for (const ev of this.events) {
      const withChain = { ...ev, _prevHash: prev };
      withChain._hash = chainHash(withChain, prev);
      lines.push(JSON.stringify(withChain));
      prev = withChain._hash;
    }
    const tmp = `${this._file}.tmp`;
    await writeFile(tmp, lines.length ? `${lines.join("\n")}\n` : "");
    await rename(tmp, this._file);
    this._dirty = false;
  }

  /** 追加后异步刷盘的便捷方法。 */
  async appendAndFlush(record, opts) {
    const stored = this.append(record, opts);
    await this.flush();
    return stored;
  }

  byKind(kind) {
    return this.events.filter((e) => e.kind === kind);
  }

  headHash() {
    return this._prevHash;
  }
}

function chainHash(record, prevHash) {
  const { _hash, _prevHash, ...body } = record; // 哈希内容不含链字段本身
  return sha256(`${prevHash}\n${JSON.stringify(body)}`);
}

function stripChainFields(record) {
  const { _hash, _prevHash, ...body } = record;
  return body;
}

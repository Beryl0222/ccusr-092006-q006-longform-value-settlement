// 哈希工具：结算单需要“可复算”——同一份输入必须永远得到同一份结果。
// 统一使用 Node 内置 crypto，避免第三方依赖。
import { createHash } from "node:crypto";

export function sha256(input) {
  return createHash("sha256").update(typeof input === "string" ? input : stableStringify(input)).digest("hex");
}

/** 稳定序列化：键排序，保证 {a:1,b:2} 与 {b:2,a:1} 哈希一致。 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** 截取短哈希用于编号展示。 */
export function shortHash(input, len = 12) {
  return sha256(input).slice(0, len);
}

// 领域资料的兼容入口：事件种类与字段校验统一以 domain/ 下的实现为准。
export { EVENT_KINDS } from "./domain/constants.js";
import { EVENT_KINDS } from "./domain/constants.js";

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}

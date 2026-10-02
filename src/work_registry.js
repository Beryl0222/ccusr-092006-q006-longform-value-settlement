// 作品登记：发布时冻结版本、时长、作者关系与“适用信号”。
//
// 冻结后的字段是结算的依据：后续即便源站改了标题或时长，已结算周期仍按快照复算。
// 结算单上的每条价值都能回溯到 work_id + version + content_hash。
export class WorkRegistry {
  constructor(events) {
    /** @type {Map<string, object>} work_id -> 冻结记录 */
    this.works = new Map();
    for (const e of events) {
      if (e.kind !== "WORK_REGISTERED") continue;
      if (this.works.has(e.payload.work_id)) {
        // 作品只能冻结一次；新版本应作为新作品发布，不允许覆盖历史
        throw new Error(`作品 ${e.payload.work_id} 重复登记，发布冻结不可覆盖`);
      }
      this.works.set(e.payload.work_id, { ...e.payload, registered_event: e.event_id, registered_at: e.occurred_at });
    }
  }

  get(workId) {
    return this.works.get(workId) ?? null;
  }

  list() {
    return [...this.works.values()];
  }
}

/** 登记前校验，供写入接口调用。 */
export function validateWorkRegistration(payload) {
  const problems = [];
  for (const field of ["work_id", "version", "content_hash", "duration_seconds", "author_id", "published_at", "applicable_signals"]) {
    if (payload[field] === undefined || payload[field] === null) problems.push(`缺少冻结字段: ${field}`);
  }
  if (payload.duration_seconds !== undefined && !(Number.isFinite(payload.duration_seconds) && payload.duration_seconds > 0)) {
    problems.push("duration_seconds 必须为正数");
  }
  if (payload.applicable_signals !== undefined && !Array.isArray(payload.applicable_signals)) {
    problems.push("applicable_signals 必须是信号类型数组");
  }
  return problems;
}

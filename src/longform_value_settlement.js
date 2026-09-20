// longform_value_settlement 领域资料的基础结构。

export const EVENT_KINDS = Object.freeze(["WORK_REGISTERED", "VALUE_SIGNAL_INGESTED", "ANOMALY_EXCLUDED", "PERIOD_CLOSED", "ADJUSTMENT_POSTED"]);
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}

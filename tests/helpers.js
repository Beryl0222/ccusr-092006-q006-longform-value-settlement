// 测试夹具：快速搭建一个内存结算服务与固定角色/时钟。
import { EventLog } from "../src/event_log.js";
import { SettlementService, ROLES } from "../src/service.js";
import { DEFAULT_RULE } from "../src/rules.js";

export function at(iso) {
  return { now: iso };
}

export function setupFixture() {
  const log = new EventLog();
  const svc = new SettlementService(log);
  const actors = {
    finance: { actor_id: "fin_wang", role: ROLES.FINANCE },
    finance2: { actor_id: "fin_zhao", role: ROLES.FINANCE },
    operator: { actor_id: "op_li", role: ROLES.OPERATOR },
    lu: { actor_id: "creator_lu", role: ROLES.CREATOR },
  };

  svc.publishRule(DEFAULT_RULE, at("2026-08-31T00:00:00Z"));
  svc.openPeriod("2026-09", at("2026-09-01T00:00:00Z"));
  svc.openPeriod("2026-10", at("2026-10-01T00:00:00Z"));
  svc.registerWork(
    {
      work_id: "w1",
      title: "经典课文长视频",
      version: "v1.0",
      content_hash: "sha256:abc",
      duration_seconds: 2400,
      author_id: "creator_lu",
      published_at: "2026-09-02T20:00:00Z",
      applicable_signals: ["CROSS_DAY_COMPLETION", "FAVORITE_THEN_OPEN", "MEANINGFUL_DISCUSSION", "CROSS_DAY_REVISIT", "COMPLETION"],
    },
    at("2026-09-02T20:00:00Z"),
  );
  return { log, svc, actors };
}

export const SIGNALS = {
  completion: (over = {}) => ({
    work_id: "w1",
    signal_type: "CROSS_DAY_COMPLETION",
    viewer_key: "v_carol",
    occurred_at: "2026-09-04T21:00:00Z",
    progress: 0.95,
    ...over,
  }),
};

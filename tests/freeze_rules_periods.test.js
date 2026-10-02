// 冻结、规则版本与周期窗口约束。
import assert from "node:assert/strict";
import test from "node:test";
import { setupFixture, at } from "./helpers.js";
import { DEFAULT_RULE } from "../src/rules.js";
import { computeStatement } from "../src/engine.js";
import { buildLedger } from "../src/ledger.js";

const FINANCE = { actor_id: "fin_wang", role: "FINANCE" };

test("作品发布字段被冻结：重复登记与覆盖被拒绝", () => {
  const { svc } = setupFixture();
  assert.throws(
    () =>
      svc.registerWork(
        { work_id: "w1", version: "v9.9", content_hash: "x", duration_seconds: 1, author_id: "a", published_at: "2026-09-02T20:00:00Z", applicable_signals: [] },
        at("2026-09-03T00:00:00Z"),
      ),
    /不可覆盖/,
  );
});

test("登记缺少冻结字段被拒绝", () => {
  const { svc } = setupFixture();
  assert.throws(() => svc.registerWork({ work_id: "w2" }, at("2026-09-03T00:00:00Z")), /冻结字段/);
});

test("新规则只能从新周期起生效：对已开窗周期溯及被拒绝", () => {
  const { svc } = setupFixture();
  assert.throws(
    () => svc.publishRule({ ...DEFAULT_RULE, rule_id: "rule-v2", effective_from: "2026-09" }, at("2026-09-10T00:00:00Z")),
    /新周期起生效/,
  );
});

test("规则选择按周期冻结（v1 权重用于 9 月，v2 权重用于 10 月）", () => {
  const { svc, log } = setupFixture();
  svc.publishRule(
    { ...DEFAULT_RULE, rule_id: "rule-v2", version: 2, effective_from: "2026-10", weights: { ...DEFAULT_RULE.weights, CROSS_DAY_REVISIT: 9 } },
    at("2026-09-20T00:00:00Z"),
  );
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_REVISIT", viewer_key: "v9", occurred_at: "2026-09-05T20:00:00Z" }, at("2026-09-05T21:00:00Z"));
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_REVISIT", viewer_key: "v10", occurred_at: "2026-10-03T20:00:00Z" }, at("2026-10-03T21:00:00Z"));
  const sept = computeStatement(log.events, { period: "2026-09", workId: "w1" });
  const oct = computeStatement(log.events, { period: "2026-10", workId: "w1" });
  assert.equal(sept.rule.rule_id, "rule-v1-2026-09");
  assert.equal(oct.rule.rule_id, "rule-v2");
  assert.equal(sept.summary.gross_points, 1.5);
  assert.equal(oct.summary.gross_points, 9);
});

test("迟到数据：窗口敞开时可补入；封账后到达被排除为 LATE", () => {
  const { svc, log } = setupFixture();
  // 9 月 3 日发生，10 月 2 日才到（9 月窗口还开着）
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_REVISIT", viewer_key: "late_ok", occurred_at: "2026-09-03T22:00:00Z" }, at("2026-10-02T08:00:00Z"));
  svc.closePeriod("2026-09", FINANCE, at("2026-10-05T00:00:00Z"));
  // 封账后到达
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_REVISIT", viewer_key: "too_late", occurred_at: "2026-09-20T22:00:00Z" }, at("2026-10-06T08:00:00Z"));
  const stmt = computeStatement(log.events, { period: "2026-09", workId: "w1" });
  assert.equal(stmt.contributions.some((c) => c.viewer === "late**"), true);
  assert.equal(stmt.excluded.some((x) => x.code === "LATE"), true);
});

test("归属周期从未开窗 → NO_OPEN_WINDOW", () => {
  const { svc } = setupFixture();
  svc.ingestSignal({ work_id: "w1", signal_type: "CROSS_DAY_REVISIT", viewer_key: "v_old", occurred_at: "2026-08-20T20:00:00Z" }, at("2026-08-20T20:00:00Z"));
  const ledger = buildLedger(svc.log.events);
  assert.equal(ledger.excluded.some((x) => x.code === "NO_OPEN_WINDOW"), true);
});

test("非财务角色不能封账", () => {
  const { svc, actors } = setupFixture();
  assert.throws(() => svc.closePeriod("2026-09", actors.operator, at("2026-10-05T00:00:00Z")), /FINANCE/);
});

// 端到端演示：经典课文影像在 9 月窗口内的长尾价值如何被识别、排除与结算。
// 运行：node scripts/demo.mjs
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/infra/event_store.js";
import { SettlementService } from "../src/application/services.js";
import { ROLES } from "../src/domain/constants.js";

const PEPPER = "demo-pepper-0123456789abcdef";
const yuan = (cents) => `¥${(cents / 100).toFixed(2)}`;

const dir = await mkdtemp(join(tmpdir(), "lvs-demo-"));
const store = await new EventStore(join(dir, "events.jsonl")).load();
let now = new Date("2026-09-01T09:00:00+08:00");
const service = new SettlementService({ store, pepper: PEPPER, now: () => now });

console.log("=== 1. 开窗并冻结作品 ===");
await service.openPeriod({ period: "2026-09", fund_cents: 2_000_000 }, { actor: "fin-li" });
await service.registerWork({
  work_id: "w-baicaiyuan",
  title: "经典课文影像：从百草园到三味书屋",
  creator_id: "c-laoshe",
  version: "v1.0.0",
  duration_sec: 1500,
  // 发布即声明适用信号；FAVORITE_OPEN 隐含收藏前置事实。
  eligible_signals: ["PLAY_PROGRESS", "FAVORITE_OPEN", "VALID_DISCUSSION", "REFUND", "CROSS_DAY_REVISIT"],
});

console.log("=== 2. 真实观众：首日低完播，跨日看完、收藏、回访、讨论 ===");
now = new Date("2026-09-12T09:00:00+08:00");
await service.ingestSignal({ work_id: "w-baicaiyuan", signal_type: "FAVORITED", occurred_at: "2026-09-02T21:10:00+08:00",
  payload: { viewer_token: "viewer-A", fav_id: "fav-A-1" } });
await service.ingestSignal({ work_id: "w-baicaiyuan", signal_type: "PLAY_PROGRESS", occurred_at: "2026-09-02T21:00:00+08:00",
  payload: { viewer_token: "viewer-A", progress: 0.35, play_id: "play-A-1" } }); // 首日只看了 35%
await service.ingestSignal({ work_id: "w-baicaiyuan", signal_type: "PLAY_PROGRESS", occurred_at: "2026-09-05T20:05:00+08:00",
  payload: { viewer_token: "viewer-A", progress: 0.95, play_id: "play-A-2" } }); // 跨日看完
await service.ingestSignal({ work_id: "w-baicaiyuan", signal_type: "FAVORITE_OPEN", occurred_at: "2026-09-05T20:00:00+08:00",
  payload: { viewer_token: "viewer-A", open_id: "open-A-1", seconds_after_favorite: 260000 } });
await service.ingestSignal({ work_id: "w-baicaiyuan", signal_type: "VALID_DISCUSSION", occurred_at: "2026-09-06T09:00:00+08:00",
  payload: { viewer_token: "viewer-B", discussion_id: "disc-B-1", chars: 420, quality: "high" } });
await service.ingestSignal({ work_id: "w-baicaiyuan", signal_type: "CROSS_DAY_REVISIT", occurred_at: "2026-09-10T20:00:00+08:00",
  payload: { viewer_token: "viewer-A", first_seen: "2026-09-02T21:00:00+08:00", revisit_at: "2026-09-10T20:00:00+08:00" } });

console.log("=== 3. 异常互动：矩阵号自评 + 双向互刷 + 风控机刷 ===");
await service.declareControl({ group_id: "g-laoshe", creator_ids: ["c-laoshe"], viewer_tokens: ["viewer-fake1"] }, { actor: "op-wang" });
await service.declareControl({ group_id: "g-other", creator_ids: ["c-other"], viewer_tokens: ["viewer-fake2"] }, { actor: "op-wang" });
await service.registerWork({ work_id: "w-short", title: "短内容", creator_id: "c-other", version: "v1", duration_sec: 600 });
// 矩阵自评
await service.ingestSignal({ work_id: "w-baicaiyuan", signal_type: "PLAY_PROGRESS", occurred_at: "2026-09-08T10:00:00+08:00",
  payload: { viewer_token: "viewer-fake1", progress: 1, play_id: "play-fake1" } });
// 双向互刷
await service.ingestSignal({ work_id: "w-short", signal_type: "PLAY_PROGRESS", occurred_at: "2026-09-08T10:01:00+08:00",
  payload: { viewer_token: "viewer-fake1", progress: 1, play_id: "play-f1-on-short" } });
await service.ingestSignal({ work_id: "w-baicaiyuan", signal_type: "PLAY_PROGRESS", occurred_at: "2026-09-08T10:02:00+08:00",
  payload: { viewer_token: "viewer-fake2", progress: 1, play_id: "play-f2-on-bcy" } });
// 风控判定的机刷讨论
const spam = await service.ingestSignal({ work_id: "w-baicaiyuan", signal_type: "VALID_DISCUSSION", occurred_at: "2026-09-09T10:00:00+08:00",
  payload: { viewer_token: "viewer-spam", discussion_id: "disc-spam", chars: 5, quality: "low" } });
await service.markAnomaly({ signal_id: spam.signal_id, reason_label: "机刷评论团伙",
  evidence: { model: "spam-graph-v3", cluster_id: "cl-77" } });

console.log("=== 4. 月末封账；迟到的 9 月信号被拒收 ===");
now = new Date("2026-10-01T00:05:00+08:00");
await service.closePeriod("2026-09", { actor: "fin-li" });
try {
  await service.ingestSignal({ work_id: "w-baicaiyuan", signal_type: "PLAY_PROGRESS", occurred_at: "2026-09-28T10:00:00+08:00",
    payload: { viewer_token: "viewer-late", progress: 1, play_id: "play-late" } });
} catch (e) {
  console.log(`  拒收迟到数据：${e.code}`);
}

console.log("=== 5. 定稿结算单（可复算） ===");
const finalize = await service.finalizeSettlement("2026-09");
const stmt = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
console.log(`  calculation_hash: ${finalize.calculation_hash.slice(0, 24)}…`);
console.log("  --- 形成扶持的长期信号 ---");
for (const c of stmt.contributions.filter((c) => c.gross_cents > 0)) {
  console.log(`  + ${yuan(c.gross_cents).padStart(8)}  ${c.item}（${c.signal_type}，观众 ${c.viewer_h.slice(0, 12)}…）`);
}
for (const c of stmt.contributions.filter((c) => c.informational)) {
  console.log(`  ${"(不计值)".padStart(10)}  ${c.item}`);
}
console.log("  --- 被排除的流量 ---");
for (const ex of stmt.exclusions) {
  console.log(`  ${"(排除)".padStart(10)}  ${ex.reason} — ${ex.reason_label}`);
}
console.log(`  毛额合计 ${yuan(stmt.subtotal.positive_cents)}，退款扣减 ${yuan(stmt.subtotal.refund_cents)}，应付 ${yuan(stmt.allocation.final_cents)}`);

console.log("=== 6. 独立复算校验 ===");
const v = await service.reverify("2026-09");
console.log(`  重放重算哈希一致：${v.matches}`);

console.log("=== 7. 申诉与双人复核补结 ===");
const appeal = await service.fileAppeal({
  period: "2026-09", work_id: "w-baicaiyuan", creator_id: "c-laoshe",
  reasons: ["一条跨日回访在封账前已产生但上报被网关丢弃"], evidence_refs: ["ticket-2026-1001"],
});
const reviewed = await service.reviewAppeal({
  appeal_id: appeal.appeal_id, decision: "UPHELD", reviewer: "arb-zhang", reviewer_role: ROLES.ARBITRATOR,
  review_notes: "网关日志证实", adjustment: { type: "SUPPLEMENT", cents: 150 },
});
await service.approveAdjustment({ adjustment_id: reviewed.adjustment_id, approved: true,
  reviewer: "fin-li", reviewer_role: ROLES.FINANCE_ADMIN, review_notes: "同意补结跨日回访" });
const finalStmt = await service.getStatement({ period: "2026-09", work_id: "w-baicaiyuan" });
console.log(`  原结算 ${yuan(stmt.allocation.final_cents)} + 补结 150 = 净应付 ${yuan(finalStmt.net_payable_cents)}`);

console.log("=== 8. 总账守恒校验 ===");
const report = service.ledgerReport();
console.log(`  平衡：${report.balanced}；凭证数：${report.transaction_count}`);
for (const [account, cents] of report.accounts) console.log(`    ${account.padEnd(34)} ${yuan(cents)}`);

await rm(dir, { recursive: true, force: true });

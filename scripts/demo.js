// 端到端演示：用一段固定时间线，把题述的月末关账故事完整走一遍。
//   node scripts/demo.js
// 全程使用内存事件日志与固定时钟，输出可复现。
import { EventLog } from "../src/event_log.js";
import { SettlementService, ROLES } from "../src/service.js";
import { computeStatement, computePeriod } from "../src/engine.js";
import { buildProjectedLedger } from "../src/postings.js";
import { renderStatement } from "../src/statement_render.js";
import { DEFAULT_RULE } from "../src/rules.js";

const log = new EventLog();
const svc = new SettlementService(log);

// 角色（演示账号）
const FINANCE = { actor_id: "fin_wang", role: ROLES.FINANCE }; // 财务
const OPERATOR = { actor_id: "op_li", role: ROLES.OPERATOR }; // 运营
const LU = { actor_id: "creator_lu", role: ROLES.CREATOR }; // 创作者：陆老师（经典课文讲解）
const ALPHA = { actor_id: "u_alpha", role: ROLES.CREATOR };

const at = (iso) => ({ now: iso });
const line = (s) => console.log(`\n${s}\n`);

// 1) 规则与窗口：规则先发布、窗口后打开；规则只对新周期生效
line("① 发布 v1 规则并打开 2026-09 周期窗口");
svc.publishRule(DEFAULT_RULE, at("2026-08-31T00:00:00Z"));
try {
  // 窗口打开后再想让新规则溯及 2026-09，应被拒绝
  svc.openPeriod("2026-09", at("2026-09-01T00:00:00Z"));
  svc.publishRule({ ...DEFAULT_RULE, rule_id: "rule-v2-bad", effective_from: "2026-09" }, at("2026-09-15T00:00:00Z"));
} catch (e) {
  console.log(`　已拒绝溯及既往的规则：${e.message}`);
}
svc.publishRule({ ...DEFAULT_RULE, rule_id: "rule-v2-2026-11", version: 2, effective_from: "2026-11", weights: { ...DEFAULT_RULE.weights, CROSS_DAY_REVISIT: 2.0 } }, at("2026-09-15T00:00:00Z"));
console.log("　v2 规则可提前发布，但只对尚未开始的 2026-11 周期生效，9 月仍按 v1 结算");

// 2) 作品发布即冻结
line("② 作品发布：冻结版本、时长、作者关系与适用信号");
svc.registerWork(
  {
    work_id: "work-classic-01",
    title: "《背影》课文精讲（影像版）",
    version: "v3.2",
    content_hash: "sha256:9f1c…be07",
    duration_seconds: 2580,
    author_id: "creator_lu",
    published_at: "2026-09-02T20:00:00Z",
    applicable_signals: ["CROSS_DAY_COMPLETION", "FAVORITE_THEN_OPEN", "MEANINGFUL_DISCUSSION", "CROSS_DAY_REVISIT", "COMPLETION"],
  },
  at("2026-09-02T20:00:00Z"),
);
svc.registerWork(
  {
    work_id: "work-knowledge-02",
    title: "长知识：引力波是怎么被听到的",
    version: "v1.0",
    content_hash: "sha256:41da…77ac",
    duration_seconds: 1860,
    author_id: "creator_lu",
    published_at: "2026-09-05T20:00:00Z",
    applicable_signals: ["CROSS_DAY_COMPLETION", "FAVORITE_THEN_OPEN", "MEANINGFUL_DISCUSSION", "CROSS_DAY_REVISIT", "COMPLETION"],
  },
  at("2026-09-05T20:00:00Z"),
);
// 互刷环所需的两位作者与作品
svc.registerWork(
  { work_id: "work-mini-03", title: "号 beta 的短片", version: "v1", content_hash: "sha256:bb…01", duration_seconds: 300, author_id: "u_beta", published_at: "2026-09-03T08:00:00Z", applicable_signals: ["CROSS_DAY_REVISIT"] },
  at("2026-09-03T08:00:00Z"),
);
svc.registerWork(
  { work_id: "work-alpha-04", title: "号 alpha 的短片", version: "v1", content_hash: "sha256:aa…02", duration_seconds: 320, author_id: "u_alpha", published_at: "2026-09-03T08:00:00Z", applicable_signals: ["CROSS_DAY_REVISIT"] },
  at("2026-09-03T08:00:00Z"),
);

// 3) 反作弊输入：同一控制关系声明
line("③ 声明同一控制关系（设备群 / 矩阵号）");
svc.declareControlLink({ entities: ["creator_lu", "vk_sockpuppet_01"], reason: "同设备登录" }, at("2026-09-03T00:00:00Z"));
console.log("　creator_lu 与 vk_sockpuppet_01 被声明为同一控制");

// 4) 长期价值信号（去标识化），其中夹杂各类异常
line("④ 上报 9 月长期价值信号（含真实回访与各类作弊/噪声）");
const ingest = (p, when) => svc.ingestSignal(p, at(when));

// —— 真实长期价值：首日完播率低，但跨日看完 ——
ingest({ work_id: "work-classic-01", signal_type: "CROSS_DAY_COMPLETION", viewer_key: "vk_carol_5d9", occurred_at: "2026-09-04T21:30:00Z", progress: 0.97 }, "2026-09-04T21:30:00Z");
ingest({ work_id: "work-classic-01", signal_type: "CROSS_DAY_COMPLETION", viewer_key: "vk_dave_a17", occurred_at: "2026-09-06T22:00:00Z", progress: 1.0 }, "2026-09-06T22:00:00Z");
// 同一观众重复上报（跨端重试）→ 重复，不贡献两次价值
ingest({ work_id: "work-classic-01", signal_type: "CROSS_DAY_COMPLETION", viewer_key: "vk_dave_a17", occurred_at: "2026-09-06T22:05:00Z", progress: 1.0 }, "2026-09-06T22:05:00Z");
// 收藏后跨日打开
ingest({ work_id: "work-classic-01", signal_type: "FAVORITE_THEN_OPEN", viewer_key: "vk_erin_88c", favorite_id: "fav_1001", favorited_at: "2026-09-03T09:00:00Z", occurred_at: "2026-09-08T19:40:00Z" }, "2026-09-08T19:40:00Z");
// 有效讨论
ingest({ work_id: "work-classic-01", signal_type: "MEANINGFUL_DISCUSSION", viewer_key: "vk_frank_42", discussion_id: "disc_2001", occurred_at: "2026-09-09T10:00:00Z", discussion: { length_chars: 64, reply_count: 3, text: "老师讲买橘子那段的克制，让人听见父爱的笨拙。" } }, "2026-09-09T10:00:00Z");
// 灌水讨论 → LOW_QUALITY
ingest({ work_id: "work-classic-01", signal_type: "MEANINGFUL_DISCUSSION", viewer_key: "vk_noise_00", discussion_id: "disc_2002", occurred_at: "2026-09-09T11:00:00Z", discussion: { text: "啊啊啊啊啊啊啊啊啊啊" } }, "2026-09-09T11:00:00Z");
// 跨日回访
ingest({ work_id: "work-classic-01", signal_type: "CROSS_DAY_REVISIT", viewer_key: "vk_grace_77", occurred_at: "2026-09-12T20:00:00Z" }, "2026-09-12T20:00:00Z");
// 发布当日的回访 → NOT_CROSS_DAY
ingest({ work_id: "work-classic-01", signal_type: "CROSS_DAY_REVISIT", viewer_key: "vk_sameday_9", occurred_at: "2026-09-02T23:00:00Z" }, "2026-09-02T23:00:00Z");
// 马甲观看 → SAME_CONTROL
ingest({ work_id: "work-classic-01", signal_type: "CROSS_DAY_REVISIT", viewer_key: "vk_sockpuppet_01", occurred_at: "2026-09-10T20:00:00Z" }, "2026-09-10T20:00:00Z");
// 作者自己 → SELF
ingest({ work_id: "work-classic-01", signal_type: "CROSS_DAY_REVISIT", viewer_key: "creator_lu", occurred_at: "2026-09-10T21:00:00Z" }, "2026-09-10T21:00:00Z");

// 互刷环：u_alpha 看 beta，u_beta 看 alpha，闭环回访 → RECIPROCAL
ingest({ work_id: "work-mini-03", signal_type: "CROSS_DAY_REVISIT", viewer_key: "u_alpha", occurred_at: "2026-09-10T09:00:00Z" }, "2026-09-10T09:00:00Z");
ingest({ work_id: "work-alpha-04", signal_type: "CROSS_DAY_REVISIT", viewer_key: "u_beta", occurred_at: "2026-09-10T09:10:00Z" }, "2026-09-10T09:10:00Z");
// 环内账号再去看陆老师？不在环上，不连坐；真正的环只作用于闭环边本身
ingest({ work_id: "work-classic-01", signal_type: "CROSS_DAY_REVISIT", viewer_key: "u_alpha", occurred_at: "2026-09-11T09:00:00Z" }, "2026-09-11T09:00:00Z");

// 知识讲解作品的真实跨日看完
ingest({ work_id: "work-knowledge-02", signal_type: "CROSS_DAY_COMPLETION", viewer_key: "vk_helen_b3", occurred_at: "2026-09-08T21:00:00Z", progress: 0.95 }, "2026-09-08T21:00:00Z");
ingest({ work_id: "work-knowledge-02", signal_type: "FAVORITE_THEN_OPEN", viewer_key: "vk_ivan_64", favorite_id: "fav_1002", favorited_at: "2026-09-06T10:00:00Z", occurred_at: "2026-09-15T10:00:00Z" }, "2026-09-15T10:00:00Z");
// 退款
svc.recordRefund({ work_id: "work-knowledge-02", refund_id: "ref_3001", occurred_at: "2026-09-20T10:00:00Z", units: 1 }, "2026-09-20T10:00:00Z");
svc.recordRefund({ work_id: "work-knowledge-02", refund_id: "ref_3001", occurred_at: "2026-09-20T10:00:00Z", units: 1 }, "2026-09-20T10:05:00Z"); // 重复退款单

// 5) 迟到数据：窗口仍敞开时到达 → 可补入
line("⑤ 迟到数据：10 月 2 日才到达一条 9 月 1 日发生的跨日回访，窗口尚未封账 → 采信");
ingest({ work_id: "work-classic-01", signal_type: "CROSS_DAY_REVISIT", viewer_key: "vk_late_but_ok", occurred_at: "2026-09-03T22:00:00Z" }, "2026-10-02T08:00:00Z");

// 6) 财务封账；封账后迟到数据被排除
line("⑥ 财务封账 2026-09，随后到达的迟到信号只能被排除");
svc.closePeriod("2026-09", FINANCE, at("2026-10-05T00:00:00Z"));
ingest({ work_id: "work-classic-01", signal_type: "CROSS_DAY_REVISIT", viewer_key: "vk_too_late_zz", occurred_at: "2026-09-25T20:00:00Z" }, "2026-10-06T08:00:00Z");

// 7) 结算（幂等）
line("⑦ 按作品出具可复算结算单（重复结算不产生第二份价值）");
const r1 = svc.settleWork("2026-09", "work-classic-01", FINANCE, at("2026-10-06T09:00:00Z"));
const r2 = svc.settleWork("2026-09", "work-classic-01", FINANCE, at("2026-10-06T09:01:00Z"));
console.log(`　首次结算：${r1.duplicated ? "重复" : "成功"}，净价值 ${r1.statement.summary.net_points} 点，指纹 ${r1.statement.input_hash.slice(0, 16)}…`);
console.log(`　再次结算：${r2.duplicated ? "判定重复并拒绝重复计值" : "成功"}`);
svc.settleWork("2026-09", "work-knowledge-02", FINANCE, at("2026-10-06T09:02:00Z"));
svc.settleWork("2026-09", "work-mini-03", FINANCE, at("2026-10-06T09:03:00Z"));
svc.settleWork("2026-09", "work-alpha-04", FINANCE, at("2026-10-06T09:04:00Z"));

// 8) 创作者拿到结算单
line("⑧ 创作者陆老师看到的结算单（不是一句“算法判定优质”）");
const stmt = computeStatement(log.events, { period: "2026-09", workId: "work-classic-01" });
console.log(renderStatement(stmt, { payableCents: Math.round(stmt.summary.net_points * 100) }));

// 9) 申诉冻结原计算与证据
line("⑨ 创作者申诉：系统冻结当时的结算单、反作弊证据与日志头哈希");
const appeal = svc.fileAppeal({ period: "2026-09", workId: "work-classic-01", by: LU, reason: "vk_erin_88c 的收藏回访被低估，申请人工复核" }, at("2026-10-07T00:00:00Z"));
console.log(`　申诉已受理：${appeal.appeal_id}`);
console.log(`　冻结日志头哈希：${appeal.snapshot.log_head_hash.slice(0, 20)}…`);

// 10) 人工修正：运营提议、财务复核（不同角色、不同人）
line("⑩ 人工补结：运营提议 → 财务复核（同一人复核会被拒绝）");
const prop = svc.proposeAdjustment({ period: "2026-09", workId: "work-classic-01", kind: "TOPUP", delta_points: 2.5, reason: "复核确认一条收藏后回访应计，补结 2.5 点", by: OPERATOR, appeal_id: appeal.appeal_id }, at("2026-10-07T12:00:00Z"));
try {
  svc.approveAdjustment(prop.adjustment_id, OPERATOR, at("2026-10-07T13:00:00Z"));
} catch (e) {
  console.log(`　运营自批被拒：${e.message}`);
}
svc.approveAdjustment(prop.adjustment_id, FINANCE, at("2026-10-08T09:00:00Z"));
console.log("　财务 fin_wang 复核通过，补结过账");

// 演示一笔撤销（负向修正）
const rev = svc.proposeAdjustment({ period: "2026-09", workId: "work-classic-01", kind: "REVERSAL", delta_points: 1.5, reason: "一条跨日回访事后被确认来自关联设备，撤销 1.5 点", by: OPERATOR }, at("2026-10-08T10:00:00Z"));
svc.approveAdjustment(rev.adjustment_id, FINANCE, at("2026-10-08T11:00:00Z"));

// 11) 总账守恒
line("⑪ 重建复式总账并验证守恒（结算 + 补结 + 撤销）");
const gl = buildProjectedLedger(log.events);
const v = gl.verifyConservation();
for (const [account, cents] of v.byAccount) console.log(`　${account}: ${cents} 分`);
console.log(`　全部账户余额合计 = ${v.total} 分，总账${v.conserved ? "守恒 ✓" : "不平衡 ✗"}`);
console.log(`　creator_lu 应付余额：¥${(gl.payableOf("creator_lu") / 100).toFixed(2)}`);

// 12) 修正后的结算单
line("⑫ 修正后重新复算：历史结算不改写，撤销/补结单列，净价值可追溯");
const stmt2 = computeStatement(log.events, { period: "2026-09", workId: "work-classic-01" });
console.log(`　原结算净值 ${r1.statement.summary.net_points} → 调整后净值 ${stmt2.summary.net_points}（含补结 +2.5 / 撤销 -1.5）`);
console.log(`　复算指纹：${stmt2.input_hash.slice(0, 20)}…（输入变了，指纹变了，但原申诉快照不变）`);

line("⑬ 周期汇总");
const periodSummary = computePeriod(log.events, "2026-09");
console.log(`　2026-09 共 ${periodSummary.statements.length} 份结算单`);
console.log(`　总扶持 ${periodSummary.totals.gross_points} 点，退款冲减 ${periodSummary.totals.refund_points} 点，人工调整 ${periodSummary.totals.adjustment_points} 点，净 ${periodSummary.totals.net_points} 点`);
console.log(`　日志事件总数：${log.events.length}，日志头哈希 ${log.headHash().slice(0, 20)}…`);

// 长内容价值结算 —— 领域术语与事件类型定义。
//
// 本文件是业务、运营、研发共用的术语表：只描述“发生了什么事实”，
// 不包含任何计分逻辑。计分逻辑见 rules.js（规则版本化，仅对新周期生效）。

/**
 * 事件种类（事件溯源日志中的事件类型）：
 *
 * WORK_REGISTERED       作品发布：冻结版本、时长、作者关系、发布时刻
 * RULE_PUBLISHED        发布一套新结算规则（从未来某个新周期起生效）
 * PERIOD_OPENED         打开一个结算周期窗口（窗口内允许迟到数据入账）
 * VALUE_SIGNAL          去标识化的长期价值信号（观看进度/收藏后打开/有效讨论/跨日回访等）
 * CONTROL_LINK_DECLARED 同一控制关系声明（设备群、机构矩阵号等反作弊输入）
 * REFUND_RECORDED       退款事件（负向价值）
 * PERIOD_CLOSED         周期封账（关账后该窗口只进调整，不进信号）
 * SETTLEMENT_RECORDED   结算结果入账（重算幂等：同一周期重复结算不产生第二份价值）
 * APPEAL_FILED          创作者申诉：冻结原计算与反作弊证据快照
 * ADJUSTMENT_PROPOSED   人工修正提议（运营角色）
 * ADJUSTMENT_APPROVED   人工修正复核通过（财务角色，且不能与提议人相同）
 * ADJUSTMENT_REJECTED   人工修正复核驳回
 */
export const EVENT_KINDS = Object.freeze([
  "WORK_REGISTERED",
  "RULE_PUBLISHED",
  "PERIOD_OPENED",
  "VALUE_SIGNAL",
  "CONTROL_LINK_DECLARED",
  "REFUND_RECORDED",
  "PERIOD_CLOSED",
  "SETTLEMENT_RECORDED",
  "APPEAL_FILED",
  "ADJUSTMENT_PROPOSED",
  "ADJUSTMENT_APPROVED",
  "ADJUSTMENT_REJECTED",
]);

/** 所有事件记录必须具备的信封字段。 */
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

/**
 * 去标识化的长期价值信号类型。
 * 不接收用户身份字段；viewer_key 是上报方完成去标识化后的稳定伪标识（如哈希），
 * 且同一个伪标识在同一作品下的同类信号只有一个自然键，重复上报不贡献两次价值。
 */
export const SIGNAL_TYPES = Object.freeze({
  // 跨日看完：作品很长，首日完播率低，但观众在后续日子继续观看直至完成
  CROSS_DAY_COMPLETION: "CROSS_DAY_COMPLETION",
  // 收藏后打开：先收藏，之后真实回访打开（收藏动作本身不产生价值）
  FAVORITE_THEN_OPEN: "FAVORITE_THEN_OPEN",
  // 有效讨论：达到质量门槛的讨论（长度/互动），而非灌水
  MEANINGFUL_DISCUSSION: "MEANINGFUL_DISCUSSION",
  // 跨日回访：发布次日之后的回访观看（衡量长期留存价值）
  CROSS_DAY_REVISIT: "CROSS_DAY_REVISIT",
  // 完播（用于对照首日完播率；长内容中不是主要价值来源）
  COMPLETION: "COMPLETION",
});

/** 信号入账后在结算单上的排除原因（中文可解释）。 */
export const EXCLUSION_REASONS = Object.freeze({
  DUPLICATE: "重复上报（同一自然键已计过价值，不重复计）",
  LATE: "迟到数据：信号到达时归属周期窗口已封账（迟到数据只能进入尚未封账的窗口）",
  SAME_CONTROL: "同一控制关系下的异常互动（发布者控制范围内的自演互览）",
  RECIPROCAL: "互刷团伙的循环互动（A→B→A 闭环，非真实回访）",
  LOW_QUALITY: "未达到有效讨论质量门槛",
  SELF: "自我互动（观众伪标识与作者控制范围重合）",
  PRIOR_TO_PUBLICATION: "信号发生于作品发布之前（时间倒置，不计）",
  NOT_FAVORITED: "缺少在先收藏记录，无法认定为收藏后回访",
  NOT_APPLICABLE: "该信号类型不在作品发布时冻结的适用信号范围内",
  REFUND_DUPLICATE: "退款单重复上报（同一退款单号只冲减一次）",
  NOT_CROSS_DAY: "发生在发布当日，不构成跨日长期信号（当日行为另有首日指标承接）",
  UNKNOWN_WORK: "引用的作品不存在或未冻结登记",
  BELOW_PROGRESS: "观看进度未达到跨日完播门槛",
  NO_OPEN_WINDOW: "信号到达时归属周期没有开窗承接，无法归入明确周期",
});

export function validateEvent(record) {
  const problems = [];
  for (const name of REQUIRED_FIELDS) {
    if (!(name in record)) problems.push(`缺少字段: ${name}`);
  }
  if ("kind" in record && !EVENT_KINDS.includes(record.kind)) problems.push(`未知事件类型: ${record.kind}`);
  if ("occurred_at" in record) {
    const t = Date.parse(record.occurred_at);
    if (Number.isNaN(t)) problems.push("occurred_at 不是合法时间");
  }
  return problems;
}

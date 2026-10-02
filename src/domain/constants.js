// 领域常量：事件种类、信号类型、原因码、角色与账户名。
// 全部业务模块只依赖这里的枚举，避免字符串散落。

export const EVENT_KINDS = Object.freeze([
  "WORK_REGISTERED", // 作品发布即冻结
  "RULE_VERSION_PUBLISHED", // 结算规则新版本（仅新周期生效）
  "PERIOD_OPENED", // 结算窗口开启（含本期扶持资金池）
  "VALUE_SIGNAL_INGESTED", // 去标识化的价值信号
  "CONTROL_RELATION_DECLARED", // 同一控制关系申报
  "ANOMALY_EXCLUDED", // 外部异常判定（风控/离线模型）
  "SIGNAL_EXCLUDED", // 封账时固化的排除决定及证据
  "PERIOD_CLOSED", // 封账
  "SETTLEMENT_FINALIZED", // 可复算结算单定稿
  "ADJUSTMENT_REQUESTED", // 人工修正请求（职责分离：发起人）
  "ADJUSTMENT_APPROVED", // 人工修正复核结论（不同角色）
  "ADJUSTMENT_POSTED", // 复核通过后的撤销 / 补结（复式记账）
  "APPEAL_FILED", // 创作者申诉
  "APPEAL_REVIEWED", // 申诉复核结论
]);

// 计入价值的信号（权重在规则版本中配置）。
// FAVORITED 不直接计值，是 FAVORITE_OPEN 的前置事实。
export const SIGNAL_TYPES = Object.freeze([
  "PLAY_PROGRESS", // 观看进度（取窗口内单观众最大进度，跨越完成线才计值）
  "FAVORITED", // 收藏（前置事实，不计值）
  "FAVORITE_OPEN", // 收藏后打开
  "VALID_DISCUSSION", // 有效讨论
  "REFUND", // 退款（负向）
  "CROSS_DAY_REVISIT", // 跨日回访
]);

export const VALUE_SIGNAL_TYPES = Object.freeze([
  "PLAY_PROGRESS",
  "FAVORITE_OPEN",
  "VALID_DISCUSSION",
  "REFUND",
  "CROSS_DAY_REVISIT",
]);

// 排除原因码：结算单上每一条被排除的流量都必须带其中之一。
export const EXCLUSION_REASONS = Object.freeze({
  CONTROL_RELATION: "CONTROL_RELATION", // 同一控制关系下的自评/关联互动
  MUTUAL_PROMOTION: "MUTUAL_PROMOTION", // 跨控制关系互刷（双向才判定）
  ANOMALY_VERDICT: "ANOMALY_VERDICT", // 风控/离线模型判定
  NOT_ELIGIBLE: "NOT_ELIGIBLE", // 作品冻结清单中不适用的信号
  INVALID_PAYLOAD: "INVALID_PAYLOAD", // 未通过字段/阈值校验
});

// 上报即拒绝（不进入事件日志）的原因码。
export const REJECT_REASONS = Object.freeze({
  LATE_FOR_CLOSED_PERIOD: "LATE_FOR_CLOSED_PERIOD", // 迟到数据撞上已封账窗口
  DUPLICATE_REPORT: "DUPLICATE_REPORT", // 重复上报，不第二次贡献价值
  PII_DETECTED: "PII_DETECTED", // 携带可标识个人信息
  UNKNOWN_WORK: "UNKNOWN_WORK",
  SIGNAL_NOT_APPLICABLE: "SIGNAL_NOT_APPLICABLE",
  PREREQUISITE_MISSING: "PREREQUISITE_MISSING",
  NOT_CROSS_DAY: "NOT_CROSS_DAY",
  FUTURE_TIMESTAMP: "FUTURE_TIMESTAMP",
  WINDOW_NOT_OPENED: "WINDOW_NOT_OPENED",
  BAD_AMOUNT: "BAD_AMOUNT",
});

export const ROLES = Object.freeze({
  SYSTEM: "SYSTEM",
  OPERATOR: "OPERATOR", // 运营
  FINANCE_ADMIN: "FINANCE_ADMIN", // 财务复核
  ARBITRATOR: "ARBITRATOR", // 申诉仲裁
  CREATOR: "CREATOR",
});

export const ADJUSTMENT_TYPES = Object.freeze({
  SUPPLEMENT: "SUPPLEMENT", // 补结
  REVERSAL: "REVERSAL", // 撤销
});

export const ADJUSTMENT_STATUS = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});

export const APPEAL_DECISIONS = Object.freeze({
  UPHELD: "UPHELD", // 申诉成立
  REJECTED: "REJECTED",
});

// 复式记账账户。
export const ACCOUNTS = Object.freeze({
  TREASURY: "treasury", // 资金（资产，借增）
  PERIOD_EXPENSE: (period) => `expense:period:${period}`, // 扶持支出（借增）
  PAYABLE: (creatorId) => `payable:creator:${creatorId}`, // 创作者应付款（负债，贷增）
  ADJUSTMENT_EQUITY: "equity:settlement_adjustment", // 人工修正对冲（权益）
});

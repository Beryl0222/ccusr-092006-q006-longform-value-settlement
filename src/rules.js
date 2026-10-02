// 结算规则版本：规则必须可解释、可复算，且“从新周期起生效”。
//
// - RULE_PUBLISHED 事件携带完整规则与 effective_from（周期）；
// - 进行中的周期不受影响：取 effective_from <= period 的最新一版；
// - 规则只做确定性的线性加权与门槛判定，不出现“算法判定优质”这类黑箱。

export const RULE_KIND = "RULE_PUBLISHED";

/**
 * 默认规则（v1）。每个权重都对应一种创作者在结算单上能看见的长期信号。
 * discussion 门槛保证“有效讨论”可被复算。
 */
export const DEFAULT_RULE = Object.freeze({
  rule_id: "rule-v1-2026-09",
  version: 1,
  effective_from: "2026-09",
  published_at: "2026-09-01T00:00:00Z",
  description: "长内容长期价值基线规则：跨日看完、收藏后回访、有效讨论、跨日回访为主，首日完播仅作对照",
  weights: {
    CROSS_DAY_COMPLETION: 4.0,
    FAVORITE_THEN_OPEN: 2.5,
    MEANINGFUL_DISCUSSION: 3.0,
    CROSS_DAY_REVISIT: 1.5,
    COMPLETION: 0.5,
  },
  // 有效讨论门槛（任一不满足则 LOW_QUALITY 排除）
  discussionThresholds: {
    minLengthChars: 12,
    minReplies: 0,
    forbidRepeatedChars: true, // "啊啊啊啊啊啊啊啊" 之类
  },
  refundPenaltyPerUnit: 3.0, // 每条退款冲减的价值单位
  crossDayAfterDays: 1, // 发布次日（>24h 或日期跨天）之后才算跨日
  completionProgressThreshold: 0.9, // 跨日完播要求最终进度 >= 90%
  unitValueYuan: 1, // 每价值点折算 1 元（演示口径；真实单价同样在规则中冻结）
});

export class RuleBook {
  constructor(events, fallback = DEFAULT_RULE) {
    this.published = events
      .filter((e) => e.kind === RULE_KIND)
      .map((e) => ({ ...e.payload, published_at: e.payload.published_at ?? e.occurred_at }))
      .sort((a, b) => {
        if (a.effective_from !== b.effective_from) return a.effective_from < b.effective_from ? -1 : 1;
        return (a.published_at ?? "") < (b.published_at ?? "") ? -1 : 1;
      });
    this.fallback = fallback;
  }

  /**
   * 取适用于某周期的规则：effective_from <= period 的最新一版。
   * 若某周期已开窗后才发布、且 effective_from 落在该周期，属于“溯及既往”，
   * 由发布接口拒绝；这里只做纯函数选择。
   */
  forPeriod(period) {
    let chosen = this.fallback;
    for (const rule of this.published) {
      if (rule.effective_from <= period) chosen = rule;
    }
    return chosen;
  }

  /** 发布新规则前的不变量检查：生效周期在发布时刻必须尚未开始（开窗）。 */
  static validateEffective(rule, calendar, publishedAt) {
    if (!/^\d{4}-\d{2}$/.test(rule.effective_from)) {
      return ["effective_from 必须是 YYYY-MM 周期"];
    }
    const problems = [];
    if (!rule.weights || typeof rule.weights !== "object") problems.push("weights 缺失");
    // 对已开窗（无论是否封账）的周期生效 = 改变进行中/已封账周期，禁止
    const existing = calendar.list().find((w) => w.period === rule.effective_from);
    if (existing && existing.opened_at <= publishedAt) {
      problems.push(`新规则只能从新周期起生效：周期 ${rule.effective_from} 已在 ${existing.opened_at} 开窗`);
    }
    return problems;
  }
}

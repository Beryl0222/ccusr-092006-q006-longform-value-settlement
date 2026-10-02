// 结算单中文渲染：把结构化结算单渲染成创作者能看懂、能复算的文本。
// 每一行扶持价值对应具体长期信号；每一行排除流量对应具体原因与证据。
import { yuan } from "./general_ledger.js";

const CODE_LABELS = {
  DUPLICATE: "重复上报",
  LATE: "迟到且窗口已封账",
  SAME_CONTROL: "同一控制关系",
  RECIPROCAL: "互刷闭环",
  LOW_QUALITY: "讨论质量不足",
  SELF: "自我互动",
  PRIOR_TO_PUBLICATION: "时间早于发布",
  NOT_FAVORITED: "无在先收藏",
  NOT_APPLICABLE: "不在适用信号范围",
  NOT_CROSS_DAY: "当日行为非跨日",
  BELOW_PROGRESS: "进度未达门槛",
  UNKNOWN_WORK: "作品未登记",
  NO_OPEN_WINDOW: "无承接窗口",
};

export function renderStatement(stmt, { payableCents = null } = {}) {
  const lines = [];
  const w = stmt.work;
  lines.push("════════════════════════════════════════════");
  lines.push("            长内容价值结算单（可复算）");
  lines.push("════════════════════════════════════════════");
  lines.push(`结算单号   : ${stmt.statement_id}`);
  lines.push(`结算周期   : ${stmt.period}（窗口状态：${stmt.status === "CLOSED" ? "已封账" : "未封账"}）`);
  lines.push(`作品       : ${w.title ?? w.work_id}  [${w.work_id}]`);
  lines.push(`冻结版本   : ${w.version}  内容指纹: ${w.content_hash}`);
  lines.push(`时长       : ${w.duration_seconds} 秒   作者: ${w.author_id}`);
  lines.push(`发布时间   : ${w.published_at}`);
  lines.push(`适用规则   : ${stmt.rule.rule_id}（自 ${stmt.rule.effective_from} 周期生效）`);
  lines.push(`复算指纹   : ${stmt.input_hash}`);
  lines.push("");

  lines.push("【一】哪些长期信号形成了扶持");
  lines.push("────────────────────────────────────────────");
  if (!stmt.supportBreakdown.length) {
    lines.push("（本周期无采信的长期信号）");
  } else {
    for (const b of stmt.supportBreakdown) {
      lines.push(`· ${b.label}　权重 ${b.weight}/条 × ${b.count} 条 = ${b.points.toFixed(2)} 价值点`);
    }
  }
  lines.push("");
  lines.push("采信信号逐条明细：");
  if (!stmt.contributions.length) lines.push("（无）");
  for (const c of stmt.contributions) {
    lines.push(`  - ${c.occurred_at}　${c.label}　观众 ${c.viewer}　权重 ${c.weight}　+${c.points.toFixed(2)} 点　[事件 ${c.event_id}]`);
  }
  lines.push("");

  lines.push("【二】退款冲减");
  lines.push("────────────────────────────────────────────");
  if (!stmt.refunds.length) lines.push("（无退款）");
  for (const r of stmt.refunds) {
    lines.push(`  - ${r.occurred_at}　退款单 ${r.refund_id}　${r.units} 单 × ${r.penalty_per_unit} = -${r.points.toFixed(2)} 点`);
  }
  lines.push("");

  lines.push("【三】人工撤销 / 补结（双角色复核）");
  lines.push("────────────────────────────────────────────");
  if (!stmt.adjustments.length) lines.push("（无人工修正）");
  for (const a of stmt.adjustments) {
    const verb = a.kind === "REVERSAL" ? "撤销" : "补结";
    lines.push(`  - ${verb} ${a.delta_points > 0 ? "+" : ""}${a.delta_points.toFixed(2)} 点　运营 ${a.proposed_by} → 财务 ${a.approved_by}`);
    lines.push(`    原因：${a.reason}${a.appeal_id ? `　（申诉 ${a.appeal_id}）` : ""}`);
  }
  lines.push("");

  lines.push("【四】哪些流量因何被排除（不计价值）");
  lines.push("────────────────────────────────────────────");
  if (!stmt.excluded.length) lines.push("（无排除）");
  for (const x of stmt.excluded) {
    lines.push(`  - ${x.occurred_at ?? ""}　${CODE_LABELS[x.code] ?? x.code}　观众 ${x.viewer}　[事件 ${x.event_id}]`);
    lines.push(`    原因：${x.reason}`);
    if (x.evidence) {
      const ev = Object.entries(x.evidence)
        .filter(([k]) => k !== "rule")
        .map(([k, v]) => `${k}=${v}`)
        .join("  ");
      lines.push(`    判定依据：${x.evidence.rule ?? ""}${ev ? `（${ev}）` : ""}`);
    }
  }
  lines.push("");

  const s = stmt.summary;
  lines.push("【五】汇总复算");
  lines.push("────────────────────────────────────────────");
  lines.push(`  采信长期信号价值　+ ${s.gross_points.toFixed(2)} 点（${s.accepted_signal_count} 条）`);
  lines.push(`  退款冲减　　　　　- ${s.refund_points.toFixed(2)} 点（${s.refund_count} 笔）`);
  lines.push(`  人工撤销/补结　　 ${s.adjustment_points >= 0 ? "+" : ""}${s.adjustment_points.toFixed(2)} 点`);
  lines.push(`  ────────────────────────────`);
  lines.push(`  净价值　　　　　　= ${s.net_points.toFixed(2)} 点（被排除 ${s.excluded_signal_count} 条，不贡献价值）`);
  if (payableCents !== null) lines.push(`  折合应付金额　　　= ¥${yuan(payableCents)}`);
  lines.push("");
  lines.push("复算方式：使用相同事件日志与上述冻结规则，按结算单复算指纹可得到完全一致的结果。");
  lines.push("════════════════════════════════════════════");
  return lines.join("\n");
}

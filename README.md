# 长内容价值结算后端

月末关账时，财务不再面对一句"算法判定优质"。本系统给每位创作者出具一份**可复算的结算单**：
哪些长期信号形成了扶持、哪些流量因何被排除、退款如何冲减、人工撤销/补结如何影响净值，
都能拿着同一份事件日志复算出完全一致的结果。

纯 Node.js（`node:http`、`node:crypto`），**零第三方依赖**；事件溯源 + 哈希链存证 + 复式总账。

## 它解决了什么

针对题述业务约束，逐条落地：

| 业务约束 | 落地方式 |
| --- | --- |
| 作品发布时冻结版本、时长、作者关系、适用信号 | `WORK_REGISTERED` 冻结快照，重复登记/覆盖一律拒绝；结算单回显冻结字段与内容指纹 |
| 去标识化的观看进度/收藏后打开/有效讨论/退款/跨日回访归入明确周期 | 信号只认 `viewer_key` 伪标识；按发生时刻归自然月周期；结算单观众字段掩码展示 |
| 迟到数据只能进入尚未封账的窗口 | 信号到达（`ingested_at`）时归属周期窗口仍敞开才采信；封账后到达记 `LATE` 排除 |
| 重复上报不贡献两次价值 | 每类信号有自然键（人/作品/讨论号/收藏号），先到先得，后者记 `DUPLICATE` |
| 同一控制关系下的异常互动 | `CONTROL_LINK_DECLARED` 建并查集；作者控制范围内互动记 `SAME_CONTROL` / `SELF` |
| 分不清真实回访与互刷 | 以全部互动构建有向图，Tarjan 强连通分量识别 A→B→A 闭环，记 `RECIPROCAL`；环外单向观看不连坐 |
| 结算规则从新周期起生效 | `RULE_PUBLISHED` 带 `effective_from`；对已开窗周期溯及既往在发布时被拒绝；每单回显适用规则 |
| 申诉保留原计算和反作弊证据 | 申诉时冻结结算单全文 + 逐条证据 + 日志头哈希；日后日志变化也能对出"当时算的是什么" |
| 人工修正由不同角色复核 | 运营 `OPERATOR` 提议、财务 `FINANCE` 复核，且**提议人与复核人不能相同**；另可驳回 |
| 撤销与补结保持总账守恒 | 修正以带符号 delta（撤销负/补结正）经同一复式账套过账，借贷必相等；可随时验证余额合计为 0 |
| 创作者拿到可复算结算单 | 每分价值对应信号事件，每笔排除对应中文原因 + 证据；`input_hash` 锁定计算输入 |

## 目录

```
src/
  longform_value_settlement.js  领域术语：事件类型、信号类型、排除原因（中英对照口径）
  hash.js                       稳定序列化与 SHA-256
  event_log.js                  只追加事件日志 + 哈希链 + event_id 幂等（JSONL 原子落盘）
  periods.js                    会计周期开窗/封账、迟到数据归属
  rules.js                      规则版本（只对新周期生效的确定性加权与门槛）
  work_registry.js              作品发布冻结登记
  control_graph.js              并查集（同控）+ Tarjan SCC（互刷环）
  ledger.js                     信号台账投影：采信/排除/退款的纯函数分类
  engine.js                     结算引擎：确定性计分、input_hash、掩码、结算单结构
  general_ledger.js             复式总账与守恒校验
  postings.js                   从事件日志重建复式总账
  service.js                    应用服务：写入编排、角色分权、申诉冻结、修正流、结算幂等
  statement_render.js           中文可复算结算单渲染
  server.js / main.js           HTTP API（零依赖）与启动入口
scripts/demo.js                 端到端叙事演示（固定时钟，输出可复现）
data/sample.json                虚构冻结登记样例
tests/                          31 个 node:test 用例（含原有契约测试与 HTTP 集成）
```

## 快速开始

```bash
npm test          # 31 个用例全绿
npm run demo      # 看一遍月末关账完整故事
npm start         # 启动 HTTP 后端，默认 http://localhost:3000
                  # 环境变量 PORT、LONGFORM_STORE（默认 data/store.jsonl）
```

## 一个请求走一遍

```bash
# 角色通过请求头携带：X-Actor-Id / X-Actor-Role
curl -s -X POST localhost:3000/rules -H 'content-type: application/json' -d '{
  "rule_id":"rule-v1-2026-09","version":1,"effective_from":"2026-09",
  "weights":{"CROSS_DAY_COMPLETION":4,"FAVORITE_THEN_OPEN":2.5,
    "MEANINGFUL_DISCUSSION":3,"CROSS_DAY_REVISIT":1.5,"COMPLETION":0.5},
  "discussionThresholds":{"minLengthChars":12,"minReplies":0,"forbidRepeatedChars":true},
  "refundPenaltyPerUnit":3,"crossDayAfterDays":1,
  "completionProgressThreshold":0.9,"unitValueYuan":1}'

curl -s -X POST localhost:3000/periods/2026-09/open -d '{}'
curl -s -X POST localhost:3000/works -H 'content-type: application/json' -d '{
  "work_id":"w1","version":"v1.0","content_hash":"sha256:abc","duration_seconds":2400,
  "author_id":"creator_lu","published_at":"2026-09-02T20:00:00Z",
  "applicable_signals":["CROSS_DAY_COMPLETION","FAVORITE_THEN_OPEN",
    "MEANINGFUL_DISCUSSION","CROSS_DAY_REVISIT","COMPLETION"]}'

curl -s -X POST localhost:3000/signals -H 'content-type: application/json' -d '{
  "work_id":"w1","signal_type":"CROSS_DAY_COMPLETION",
  "viewer_key":"vk_carol_5d9","occurred_at":"2026-09-04T21:00:00Z","progress":0.97}'

curl -s -X POST localhost:3000/periods/2026-09/close \
  -H 'X-Actor-Id: fin_wang' -H 'X-Actor-Role: FINANCE' -d '{}'
curl -s -X POST localhost:3000/settlements -H 'content-type: application/json' \
  -H 'X-Actor-Id: fin_wang' -H 'X-Actor-Role: FINANCE' \
  -d '{"period":"2026-09","work_id":"w1"}'

curl -s localhost:3000/periods/2026-09/works/w1/statement.txt   # 中文结算单
```

主要路由：`POST /works /rules /signals /control-links /refunds /appeals /adjustments`、
`POST /periods/:p/open|close`、`POST /settlements`（幂等）、
`GET /periods/:p/statements`、`GET /periods/:p/works/:w/statement[.txt]`、
`GET /appeals/:id`、`POST /adjustments/:id/approve|reject`、`GET /ledger/conservation`。

## 结算单长什么样

```
【一】哪些长期信号形成了扶持
· 跨日看完　权重 4/条 × 2 条 = 8.00 价值点
· 收藏后回访打开　权重 2.5/条 × 1 条 = 2.50 点
  - 2026-09-08T19:40Z　收藏后回访打开　观众 vk_e**　权重 2.5　+2.50 点　[事件 evt-sig_…]
【四】哪些流量因何被排除（不计价值）
  - 2026-09-06T22:05Z　重复上报　观众 vk_d**
    原因：重复上报（同一自然键已计过价值，不重复计）
    判定依据：…（dedup_key=CROSS_DAY_COMPLETION:w1:vk_dave_a17）
  - 2026-09-10T20:00Z　同一控制关系　观众 vk_s**
    判定依据：viewer 伪标识与作者在同一声明控制关系并查集内
【五】汇总复算
  采信长期信号 +18.00　退款冲减 -0.00　人工撤销/补结 +1.00
  净价值 = 19.00 点（被排除 6 条，不贡献价值）
复算指纹 3fb1d0d3…　← 相同事件日志 + 冻结规则必得到相同指纹与净值
```

## 设计要点

- **事件溯源是唯一事实来源**：信号事件一律如实落账，采信/排除是随时可丢弃重算的投影；
  因此规则口径演进后，历史账仍能按当时规则与 `input_hash` 复算。
- **确定性**：计分只用线性权重与明确门槛，不出现黑箱"优质"判定；
  哈希采用键排序的稳定序列化，浮点结果统一保留两位。
- **证据链**：事件以 `_prevHash → _hash` 串联，改动任意一个字段都会在加载时因断链报错。
- **复式守恒**：资金池（借）与应付作者（贷）成对过账；撤销是补结的反向分录，而非删除历史。
- **分权与冻结**：封账/结算/复核需财务角色；提议与复核同人拒绝；申诉快照不可变。

## 边界说明

- 时间按 UTC 解析归月；生产部署应统一上报时区与服务端时钟，迟到判定以服务端 `ingested_at` 为准。
- `unitValueYuan` 为演示口径（1 点 = 1 元），真实单价同样应在规则中冻结并版本化。
- 互刷识别基于已声明控制关系与互动图结构，是可解释的规则判定；更复杂的模型分应先沉淀为
  可复算信号再入账，而不是直接给结论。
- 本仓库只含虚构伪标识数据，无真实个人信息、生产连接或外部账号。

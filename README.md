# 长内容价值结算后端

面向经典课文影像、长知识讲解等**长内容**的价值结算系统。解决月末关账时的核心矛盾：
首日完播率很低、但被反复收藏、跨日看完的内容具有长期价值；运营临时补发奖金既无法证明价值，
也分不清真实回访与互刷。

系统给创作者的不是一句“算法判定优质”，而是一份**可复算的结算单**：
每一笔扶持由哪些长期信号形成、每一笔流量因何被排除（含证据），都能按封账时刻的输入重算出同一个哈希。

- 零第三方依赖，仅用 Node.js 内置模块（`node:http` / `node:test` / `node:crypto`）。
- 事件溯源：一切事实只追加，哈希链防篡改；结算单是纯函数投影。
- 复式记账：借/贷平衡分录入账，撤销与补结保持总账守恒。

## 业务约束如何落地

| 业务要求 | 实现方式 |
| --- | --- |
| 发布时冻结版本、时长、作者关系、适用信号 | `WORK_REGISTERED` 事件固化快照并计算 `freeze_hash`，不可二次发布 |
| 去标识化的观看进度/收藏后打开/有效讨论/退款/跨日回访 | 入库前 HMAC 假名化（`viewer_token` 永不落盘），白名单字段 + PII 正则拒收 |
| 后续信号归入明确周期 | 按业务时区 UTC+8 划自然月；信号必属于一个“已开窗”的窗口 |
| 迟到数据只能进尚未封账的窗口 | 封账后该周期信号一律 `LATE_FOR_CLOSED_PERIOD`（409），且不写日志 |
| 封账时刻的输入固定 | 定稿只取封账序号之前的事件（含控制关系/风控判定），之后的事实不溯及既往 |
| 重复上报不贡献两次价值 | 业务去重键（play_id / order_id / discussion_id / 观众+周期）+ 事件层幂等键双层去重 |
| 同一控制关系下异常互动 | `CONTROL_RELATION_DECLARED` 声明创作主体与受控观众；自评自看按 `CONTROL_RELATION` 排除 |
| 互刷与真实回访分开 | 仅当两个受控主体**双向**互动且各方向达到阈值才判 `MUTUAL_PROMOTION`，单向不惩罚 |
| 结算规则从新周期起生效 | 规则版本只能挂到“尚未开始”的周期，周期内不可替换 |
| 申诉保留原计算和反作弊证据 | 原结算单事件永不修改/删除；申诉携带原事件 id 与原 `calculation_hash`，只追加 |
| 人工修正由不同角色复核 | 运营 `OPERATOR` 发起 → 财务 `FINANCE_ADMIN`（不得同人）复核；仲裁只能转待复核请求 |
| 撤销与补结保持总账守恒 | 每笔调整是借贷平衡凭证；累计撤销不得超过原结算额；`Σ 账户余额 ≡ 0` |
| 可复算 | 结算单含输入事件清单、规则、冻结哈希、资金池；`reverify` 按封账序号重放比对哈希 |

### 长期信号的计值口径（规则 v2026-09-01）

- **完整观看**：同一观众在周期内多次进度取最大值，只有跨 90% 完成线才计 ¥1.20；首日 35% 这类低完播留痕但不计值。
- **收藏后打开**：必须存在收藏前置事实（可跨周期），每观众每周期 ¥0.80。
- **有效讨论**：每条按质量系数（high ×1.5 / normal ×1 / low ×0.5）计，基础 ¥2.00。
- **退款**：逐笔负向 ¥3.00，同一订单不重复扣减；作品净毛额保底为 0。
- **跨日回访**：首次观看与回访必须跨越业务时区自然日，每观众每周期 ¥1.50。
- 资金池不足时按**最大余数法**比例分摊，各作品最终额之和恰为资金池（整数分）。

## 目录

```
src/
  domain/            领域层（无 IO，纯逻辑，可独立单测）
    constants.js       事件种类、信号类型、原因码、角色、账户
    time.js            UTC+8 周期/跨日计算
    hash.js            HMAC 假名化、哈希、ID
    validation.js      信号白名单校验与 PII 拦截
    ledger.js          复式记账总账（守恒断言）
    settlement.js      纯函数结算计算器（计值/反作弊/分摊/可复算哈希）
    projection.js      事件重放读模型（支持 upToSeq 按封账时刻重算）
  infra/
    event_store.js     JSONL 只追加事件日志（序号 + 哈希链 + 幂等键）
  application/
    services.js        应用服务：全部写操作与业务约束的唯一收口
  interfaces/
    http_server.js     无依赖 HTTP API
  server.js            启动入口
scripts/demo.mjs      端到端演示（月末关账全流程）
tests/                node:test 测试（31+ 用例）
```

## 本地运行

```bash
npm test                 # 全部测试
node scripts/demo.mjs    # 端到端演示：真实长尾价值 / 互刷排除 / 申诉补结 / 总账
VIEWER_PEPPER='至少16字符的盐值' PORT=8080 npm start
```

`VIEWER_PEPPER` 为观众假名化 HMAC 盐值，缺失时服务拒绝启动。事件日志默认写
`data/settlement-events.jsonl`（可用 `SETTLEMENT_LOG` 覆盖）。

## HTTP 接口

身份通过请求头传递（演示用；生产应由网关注入）：`x-actor-id`、`x-actor-role`
（`OPERATOR` / `FINANCE_ADMIN` / `ARBITRATOR` / `SYSTEM`），信号上报支持 `Idempotency-Key`。

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /works` | SYSTEM | 作品发布即冻结 |
| `POST /rules` | OPERATOR | 新规则版本（effective_period 必须未开始） |
| `POST /periods/open` | FINANCE_ADMIN | 开窗并指定资金池（分） |
| `POST /signals` | 上报方 | 去标识化信号；202 接收 / 409 重复或迟到 / 422 含 PII |
| `POST /control-relations` | OPERATOR | 申报同一控制关系 |
| `POST /anomalies` | SYSTEM | 风控/离线模型排除（带证据） |
| `POST /periods/:period/close` | FINANCE_ADMIN | 封账 |
| `POST /periods/:period/finalize` | SYSTEM | 定稿结算单并记结算凭证 |
| `GET  /periods/:period/reverify` | 任意 | 按封账序号重算并比对哈希 |
| `GET  /statements?period=&work_id=` | 任意 | 创作者可复算结算单 |
| `POST /appeals` | 作者本人 | 申诉（自动关联原单哈希） |
| `POST /appeals/:id/review` | ARBITRATOR/FINANCE_ADMIN | 申诉成立只能生成待复核修正 |
| `POST /adjustments` | OPERATOR | 人工修正（补结/撤销） |
| `POST /adjustments/:id/approve` | FINANCE_ADMIN（非发起人） | 复核通过才入平衡凭证 |
| `GET  /ledger` | 任意 | 总账余额与守恒状态 |
| `GET  /events` | 任意 | 事件日志审计（含哈希链） |

### 结算单示例（节选）

```json
{
  "work_id": "w-baicaiyuan",
  "creator_id": "c-laoshe",
  "rule_version": "v2026-09-01",
  "frozen_snapshot": { "version": "v1.0.0", "duration_sec": 1500, "eligible_signals": ["…"] },
  "contributions": [
    { "signal_type": "PLAY_PROGRESS", "item": "完整观看（跨日累计达到完成线）", "gross_cents": 120 },
    { "signal_type": "FAVORITE_OPEN", "item": "收藏后再次打开（长期兴趣信号）", "gross_cents": 80 }
  ],
  "exclusions": [
    { "signal_id": "sig_…", "reason": "MUTUAL_PROMOTION", "reason_label": "与对方账号双向互刷",
      "evidence": { "forward_signal_ids": ["…"], "reverse_signal_ids": ["…"] } }
  ],
  "allocation": { "gross_cents": 650, "final_cents": 650, "capped": false },
  "net_payable_cents": 800,
  "recompute": { "as_of_close_seq": 14, "calculation_hash": "84c0…", "input_event_ids": ["…"] }
}
```

## 设计要点

1. **事件溯源 + 哈希链**：资金池、冻结快照、排除证据、申诉、调整都是只追加事件；改任何一条历史记录，
   `EventStore.load()` 即报 `LOG_TAMPERED`。
2. **封账序号即时间机器**：定稿与复算都以 `PERIOD_CLOSED` 的序号截断事件流，
   迟到数据、封账后申报的控制关系天然无法影响原单（只能走申诉/修正流程，并留痕）。
3. **纯函数结算核心**：`evaluatePeriod` 不碰时钟和存储，给定相同输入必得相同 `calculation_hash`，
   这是“可复算”而非“黑箱判定”的基础。
4. **复式记账守恒**：结算借 `expense:period:*` 贷 `payable:creator:*`；
   撤销红字反向冲回，补结同向追加；所有账户余额之和恒为 0。

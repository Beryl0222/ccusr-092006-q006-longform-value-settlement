// 服务启动入口：node src/server.js
// 环境变量：SETTLEMENT_LOG（事件日志路径）、VIEWER_PEPPER（去标识化盐值）、PORT。
import { EventStore } from "./infra/event_store.js";
import { SettlementService } from "./application/services.js";
import { createHttpApi } from "./interfaces/http_server.js";

const logPath = process.env.SETTLEMENT_LOG || "data/settlement-events.jsonl";
const pepper = process.env.VIEWER_PEPPER;
if (!pepper) {
  console.error("缺少 VIEWER_PEPPER 环境变量（至少 16 字符），拒绝启动");
  process.exit(1);
}
const port = Number(process.env.PORT || 8080);

const store = await new EventStore(logPath).load();
const service = new SettlementService({ store, pepper });
const server = createHttpApi(service);

server.listen(port, () => {
  console.log(`长内容价值结算后端已启动: http://localhost:${port}（日志 ${logPath}）`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

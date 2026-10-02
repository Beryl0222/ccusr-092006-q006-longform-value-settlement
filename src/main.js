// 服务启动入口：node src/main.js
// 环境变量：PORT（默认 3000）、LONGFORM_STORE（默认 data/store.jsonl）
import { createApp } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const store = process.env.LONGFORM_STORE ?? "data/store.jsonl";
const server = await createApp({ store });
server.listen(port, () => {
  console.log(`长内容价值结算后端已启动: http://localhost:${port}`);
  console.log(`事件日志: ${store}`);
});

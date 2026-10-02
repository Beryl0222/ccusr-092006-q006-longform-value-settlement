// HTTP 后端：零第三方依赖（node:http），事件日志落盘为带哈希链的 JSONL。
//
// 角色通过 X-Actor-Id / X-Actor-Role 请求头（或 JSON 体内 actor 字段）携带。
// 所有写操作在成功后原子刷盘；所有读操作都是对日志的即时重算投影。
import { createServer } from "node:http";
import { EventLog } from "./event_log.js";
import { SettlementService, ServiceError, ROLES } from "./service.js";
import { computeStatement, computePeriod } from "./engine.js";
import { buildProjectedLedger } from "./postings.js";
import { renderStatement } from "./statement_render.js";

export async function createApp({ store = process.env.LONGFORM_STORE ?? "data/store.jsonl" } = {}) {
  const log = await EventLog.fromFile(store);
  const svc = new SettlementService(log);

  const actorFrom = (req, body) => {
    const a = body?.actor ?? {};
    return {
      actor_id: a.actor_id ?? req.headers["x-actor-id"] ?? null,
      role: a.role ?? (req.headers["x-actor-role"] ? String(req.headers["x-actor-role"]).toUpperCase() : null),
    };
  };

  /** @type {import('node:http').RequestListener} */
  const handler = async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
      res.end(JSON.stringify(data, null, 2));
    };
    try {
      if (req.method === "GET" && p === "/health") return send(200, { ok: true, events: log.events.length, head: log.headHash() });
      if (req.method === "GET" && p === "/events") {
        return send(200, { count: log.events.length, events: log.events });
      }

      // 作品登记（冻结）
      if (req.method === "POST" && p === "/works") {
        const body = await readJson(req);
        const event = svc.registerWork(body);
        await log.flush();
        return send(201, { ok: true, event });
      }

      // 规则发布
      if (req.method === "POST" && p === "/rules") {
        const body = await readJson(req);
        const event = svc.publishRule(body);
        await log.flush();
        return send(201, { ok: true, event });
      }

      // 周期开窗/封账
      let m = p.match(/^\/periods\/(\d{4}-\d{2})\/(open|close)$/);
      if (req.method === "POST" && m) {
        const [, period, action] = m;
        const body = await readJson(req).catch(() => ({}));
        const event = action === "open" ? svc.openPeriod(period) : svc.closePeriod(period, actorFrom(req, body));
        await log.flush();
        return send(201, { ok: true, event });
      }

      if (req.method === "POST" && p === "/signals") {
        const body = await readJson(req);
        const event = svc.ingestSignal(body);
        await log.flush();
        return send(201, { ok: true, event, note: "事件已落账；是否采信见结算单的采信/排除明细" });
      }
      if (req.method === "POST" && p === "/control-links") {
        const body = await readJson(req);
        const event = svc.declareControlLink(body);
        await log.flush();
        return send(201, { ok: true, event });
      }
      if (req.method === "POST" && p === "/refunds") {
        const body = await readJson(req);
        const event = svc.recordRefund(body);
        await log.flush();
        return send(201, { ok: true, event });
      }

      // 结算（幂等）
      if (req.method === "POST" && p === "/settlements") {
        const body = await readJson(req);
        require(body.period, "period");
        require(body.work_id, "work_id");
        const result = svc.settleWork(body.period, body.work_id, actorFrom(req, body));
        await log.flush();
        return send(result.duplicated ? 200 : 201, { ok: true, ...scrub(result) });
      }

      // 周期汇总 / 单作品结算单
      m = p.match(/^\/periods\/(\d{4}-\d{2})\/statements$/);
      if (req.method === "GET" && m) return send(200, computePeriod(log.events, m[1]));

      m = p.match(/^\/periods\/(\d{4}-\d{2})\/works\/([^/]+)\/statement(\.txt)?$/);
      if (req.method === "GET" && m) {
        const stmt = computeStatement(log.events, { period: m[1], workId: decodeURIComponent(m[2]) });
        if (m[3]) {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          return res.end(renderStatement(stmt, { payableCents: Math.round(stmt.summary.net_points * (stmt.rule.unitValueYuan ?? 1) * 100) }));
        }
        return send(200, stmt);
      }

      // 申诉
      if (req.method === "POST" && p === "/appeals") {
        const body = await readJson(req);
        const result = svc.fileAppeal({ period: body.period, workId: body.work_id, by: actorFrom(req, body), reason: body.reason });
        await log.flush();
        return send(201, { ok: true, appeal_id: result.appeal_id, event: result.event, snapshot: result.snapshot });
      }
      m = p.match(/^\/appeals\/(.+)$/);
      if (req.method === "GET" && m) {
        const snapshot = svc.getAppealSnapshot(decodeURIComponent(m[1]));
        return snapshot ? send(200, snapshot) : send(404, { error: "申诉不存在" });
      }

      // 人工修正：提议 / 复核 / 驳回
      if (req.method === "POST" && p === "/adjustments") {
        const body = await readJson(req);
        const result = svc.proposeAdjustment({
          period: body.period,
          workId: body.work_id,
          kind: body.kind,
          delta_points: body.delta_points,
          reason: body.reason,
          by: actorFrom(req, body),
          appeal_id: body.appeal_id ?? null,
        });
        await log.flush();
        return send(201, { ok: true, adjustment_id: result.adjustment_id, event: result.event });
      }
      m = p.match(/^\/adjustments\/([^/]+)\/(approve|reject)$/);
      if (req.method === "POST" && m) {
        const body = await readJson(req).catch(() => ({}));
        const actor = actorFrom(req, body);
        const event = m[2] === "approve"
          ? svc.approveAdjustment(m[1], actor)
          : svc.rejectAdjustment(m[1], actor, { reason: body.reason ?? "" });
        await log.flush();
        return send(201, { ok: true, event });
      }

      // 总账与守恒
      if (req.method === "GET" && p === "/ledger/conservation") {
        const gl = buildProjectedLedger(log.events);
        const v = gl.verifyConservation();
        return send(200, {
          conserved: v.conserved,
          total_cents: v.total,
          accounts: Object.fromEntries([...v.byAccount.entries()].map(([k, val]) => [k, val])),
          entries: gl.entries.length,
        });
      }

      return send(404, { error: `无此路由: ${req.method} ${p}` });
    } catch (err) {
      if (err instanceof ServiceError) return send(400, { error: err.message });
      return send(500, { error: `内部错误: ${err.message}` });
    }
  };

  return createServer(handler);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function require(value, name) {
  if (value === undefined) throw new ServiceError(`缺少参数: ${name}`);
}

function scrub(result) {
  return { duplicated: result.duplicated, note: result.note, event: result.event, statement: result.statement };
}

export { ROLES };

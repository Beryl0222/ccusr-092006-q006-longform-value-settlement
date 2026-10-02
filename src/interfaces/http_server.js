// 无第三方依赖的 HTTP 后端。
// 身份信息取自请求头 x-actor-id / x-actor-role（演示用，生产环境应替换为网关鉴权）。
import { createServer } from "node:http";
import { DomainError } from "../domain/time.js";
import { REJECT_REASONS } from "../domain/constants.js";

export function createHttpApi(service) {
  return createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body, null, 2));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      const actor = req.headers["x-actor-id"] || "anonymous";
      const actorRole = (req.headers["x-actor-role"] || "OPERATOR").toUpperCase();
      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJson(req) : {};

      const route = match(req.method, url.pathname);

      switch (route?.name) {
        case "health":
          return send(200, { ok: true });

        case "registerWork":
          return send(201, await service.registerWork(body, { actor }));
        case "publishRule":
          return send(201, await service.publishRule(body, { actor }));
        case "openPeriod":
          return send(201, await service.openPeriod(body, { actor }));
        case "ingestSignal":
          return send(202, await service.ingestSignal(body, { idemKey: req.headers["idempotency-key"] || null }));
        case "declareControl":
          return send(201, await service.declareControl(body, { actor }));
        case "markAnomaly":
          return send(201, await service.markAnomaly(body, { actor }));
        case "closePeriod":
          return send(200, await service.closePeriod(route.p.period, { actor }));
        case "finalize":
          return send(200, await service.finalizeSettlement(route.p.period, { actor }));
        case "reverify":
          return send(200, await service.reverify(route.p.period));
        case "statement":
          return send(200, await service.getStatement({
            period: url.searchParams.get("period"),
            work_id: url.searchParams.get("work_id"),
          }));
        case "fileAppeal":
          return send(201, await service.fileAppeal({ ...body, creator_id: actor }));
        case "reviewAppeal":
          return send(200, await service.reviewAppeal({
            appeal_id: route.p.id, ...body, reviewer: actor, reviewer_role: actorRole,
          }));
        case "requestAdjustment":
          return send(201, await service.requestAdjustment(body, { actor, actor_role: actorRole }));
        case "approveAdjustment":
          return send(200, await service.approveAdjustment({
            adjustment_id: route.p.id, ...body, reviewer: actor, reviewer_role: actorRole,
          }, { actor }));
        case "ledger":
          return send(200, service.ledgerReport());
        case "events": {
          return send(200, { count: service.store.events().length, events: service.store.events() });
        }
        default:
          return send(404, { error: "NOT_FOUND", path: url.pathname });
      }
    } catch (err) {
      if (err instanceof DomainError) {
        return send(statusForCode(err.code), { error: err.code, message: err.message, details: err.details ?? null });
      }
      if (err instanceof SyntaxError) {
        return send(400, { error: "BAD_JSON", message: "请求体不是合法 JSON" });
      }
      return send(500, { error: "INTERNAL", message: String(err?.message ?? err) });
    }
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 2_000_000) reject(new SyntaxError("body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function statusForCode(code) {
  if (code === REJECT_REASONS.LATE_FOR_CLOSED_PERIOD) return 409;
  if (code === REJECT_REASONS.DUPLICATE_REPORT) return 409;
  if (code === "PII_DETECTED") return 422;
  if (["FORBIDDEN", "FORBIDDEN_ROLE", "SEGREGATION_OF_DUTIES"].includes(code)) return 403;
  if (["UNKNOWN_WORK", "UNKNOWN_SIGNAL", "NOT_FINALIZED", "UNKNOWN_APPEAL", "UNKNOWN_ADJUSTMENT", "PERIOD_NOT_OPEN", "PERIOD_NOT_CLOSED"].includes(code)) return 404;
  if (["OVER_REVERSAL", "RULE_PERIOD_NOT_FUTURE", "PERIOD_EXISTS", "WORK_EXISTS", "GROUP_EXISTS", "ANOMALY_EXISTS", "APPEAL_DECIDED"].includes(code)) return 409;
  return 400;
}

function match(method, pathname) {
  const routes = [
    ["GET", "/health", "health"],
    ["POST", "/works", "registerWork"],
    ["POST", "/rules", "publishRule"],
    ["POST", "/periods/open", "openPeriod"],
    ["POST", "/signals", "ingestSignal"],
    ["POST", "/control-relations", "declareControl"],
    ["POST", "/anomalies", "markAnomaly"],
    ["POST", "/periods/:period/close", "closePeriod"],
    ["POST", "/periods/:period/finalize", "finalize"],
    ["GET", "/periods/:period/reverify", "reverify"],
    ["GET", "/statements", "statement"],
    ["POST", "/appeals", "fileAppeal"],
    ["POST", "/appeals/:id/review", "reviewAppeal"],
    ["POST", "/adjustments", "requestAdjustment"],
    ["POST", "/adjustments/:id/approve", "approveAdjustment"],
    ["GET", "/ledger", "ledger"],
    ["GET", "/events", "events"],
  ];
  for (const [m, pattern, name] of routes) {
    if (m !== method) continue;
    const parts = pattern.split("/").filter(Boolean);
    const got = pathname.split("/").filter(Boolean);
    if (parts.length !== got.length) continue;
    const p = {};
    let ok = true;
    parts.forEach((seg, i) => {
      if (seg.startsWith(":")) p[seg.slice(1)] = decodeURIComponent(got[i]);
      else if (seg !== got[i]) ok = false;
    });
    if (ok) return { name, p };
  }
  return null;
}

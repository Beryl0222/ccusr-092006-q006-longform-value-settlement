// 去标识化：观众标识在入库前一律做带盐 HMAC，原始 token 不落盘。
// 盐值按部署环境注入，事件日志中只出现 viewer_h。
import { createHmac, createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { DomainError } from "./time.js";

export function pseudonymizeViewer(viewerToken, pepper) {
  if (typeof viewerToken !== "string" || viewerToken.length < 1) {
    throw new DomainError("viewer_token 缺失", "BAD_VIEWER_TOKEN");
  }
  return "vh_" + createHmac("sha256", pepper).update(`viewer:${viewerToken}`).digest("hex").slice(0, 32);
}

export function stableHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/infra/event_store.js";
import { SettlementService } from "../src/application/services.js";

export const PEPPER = "test-pepper-0123456789abcdef";

export async function makeService({ start = "2026-09-15T12:00:00+08:00" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "lvs-"));
  const path = join(dir, "events.jsonl");
  const store = await new EventStore(path).load();
  let t = new Date(start).getTime();
  const clock = {
    now: () => new Date(t),
    set(iso) { t = new Date(iso).getTime(); },
    advance(ms) { t += ms; },
  };
  const service = new SettlementService({ store, pepper: PEPPER, now: clock.now });
  return {
    service, store, clock, path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export async function openSeptember(service, fund_cents = 100000) {
  await service.openPeriod({ period: "2026-09", fund_cents });
}

export function classicWork(overrides = {}) {
  return {
    work_id: "w-baicaiyuan",
    title: "经典课文影像：从百草园到三味书屋",
    creator_id: "c-laoshe",
    version: "v1.0.0",
    duration_sec: 1500,
    ...overrides,
  };
}

export const signals = {
  play: (overrides = {}) => ({
    work_id: "w-baicaiyuan",
    signal_type: "PLAY_PROGRESS",
    occurred_at: "2026-09-02T21:00:00+08:00",
    payload: {
      viewer_token: "viewer-A", progress: 0.35, duration_sec: 1500,
      session_id: "sess-A-1", play_id: "play-A-1",
    },
    ...overrides,
  }),
  favorite: (overrides = {}) => ({
    work_id: "w-baicaiyuan",
    signal_type: "FAVORITED",
    occurred_at: "2026-09-02T21:10:00+08:00",
    payload: { viewer_token: "viewer-A", session_id: "sess-A-1", fav_id: "fav-A-1" },
    ...overrides,
  }),
  favoriteOpen: (overrides = {}) => ({
    work_id: "w-baicaiyuan",
    signal_type: "FAVORITE_OPEN",
    occurred_at: "2026-09-05T20:00:00+08:00",
    payload: {
      viewer_token: "viewer-A", session_id: "sess-A-2",
      open_id: "open-A-1", seconds_after_favorite: 260000,
    },
    ...overrides,
  }),
  discussion: (overrides = {}) => ({
    work_id: "w-baicaiyuan",
    signal_type: "VALID_DISCUSSION",
    occurred_at: "2026-09-06T09:00:00+08:00",
    payload: {
      viewer_token: "viewer-B", discussion_id: "disc-B-1", chars: 420, quality: "high",
    },
    ...overrides,
  }),
  refund: (overrides = {}) => ({
    work_id: "w-baicaiyuan",
    signal_type: "REFUND",
    occurred_at: "2026-09-07T10:00:00+08:00",
    payload: { viewer_token: "viewer-C", order_id: "ord-C-1", reason_code: "MISCLICK" },
    ...overrides,
  }),
  revisit: (overrides = {}) => ({
    work_id: "w-baicaiyuan",
    signal_type: "CROSS_DAY_REVISIT",
    occurred_at: "2026-09-10T20:00:00+08:00",
    payload: {
      viewer_token: "viewer-A", session_id: "sess-A-3",
      first_seen: "2026-09-02T21:00:00+08:00",
      revisit_at: "2026-09-10T20:00:00+08:00",
    },
    ...overrides,
  }),
};

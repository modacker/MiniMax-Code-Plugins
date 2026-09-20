// webui/server/cleanup.js
// Background timers / startup hooks.
//
// Lease B03 (per-request authorize, AP6 fix):
//   The pre-B03 behavior called cleanupEmptyDefaultSessions() directly
//   at boot — silent deletion of "New session" / "Untitled" / 对话 N
//   entries older than 24h, no user confirmation, no audit trail beyond
//   the mcode-internal sqlite delete itself. ANTI-PATTERNS-FIX-PLAN
//   §AP6 named this as the root cause of "I rebooted and lost my
//   sessions" user reports.
//
// New behavior (B03):
//   1. dryRun: read SESSIONS_DB, compute how many orphans WOULD be
//      deleted, write one `kind:"cleanup.dry_run"` audit event with
//      the count + ids, and — if any orphans exist — fire a
//      `startup.cleanup` authorize request via the SSE channel.
//      The function returns immediately (startup does not block).
//   2. When the user confirms (via the UI listening on
//      `needs_authorization`), authorize() resolves with
//      {approved:true, decidedBy:'user'}. The actual cleanup runs in
//      the resolve handler below.
//   3. Decline / 5-min timeout leaves the disk untouched. kind:
//      "auth.reject" / "auth.timeout" is appended to events.ndjson.
//
// Note: the actual `cleanupEmptyDefaultSessions()` import is kept as
// the real-mode deleter — it owns the saveSessions / fs-side effect.
// This file (cleanup.js) owns the authorize gate.

import { existsSync, readFileSync } from "node:fs";
import { cleanupEmptyDefaultSessions } from "./lib/sessions.js";
import { ensureMcodeCommands } from "./lib/acp-client.js";
import { authorize } from "./lib/authorize.js";
import { SESSIONS_DB } from "./lib/config.js";

const ORPHAN_STALE_MS = 24 * 60 * 60 * 1000;

// Dry-run predicate: same rules as cleanupEmptyDefaultSessions, but
// read-only (does NOT call saveSessions). Returns the array of
// webui session ids that would be deleted right now.
function _dryRunOrphanIds() {
  if (!existsSync(SESSIONS_DB)) return [];
  let all;
  try {
    let raw = readFileSync(SESSIONS_DB, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 剥 BOM
    all = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(all) || all.length === 0) return [];
  const now = Date.now();
  return all
    .filter((s) => {
      if (!s || !s.id) return false;
      const hasChat = Array.isArray(s.chat) && s.chat.length > 0;
      if (hasChat) return false;
      const t = (s.title || "").trim();
      const isDefault =
        t === "New session" || t === "Untitled" || /^对话 \d+$/.test(t);
      if (!isDefault) return false;
      if (s.updatedAt && now - s.updatedAt < ORPHAN_STALE_MS) return false;
      return true;
    })
    .map((s) => s.id);
}

// Best-effort audit write — events.js may not be present in earlier
// rounds (B01 dependency). Dynamic import + try/catch keeps cleanup
// resilient.
let _eventsMod = null;
let _eventsModTried = false;
async function _tryAppendEvent(evt) {
  if (_eventsModTried && !_eventsMod) return;
  if (!_eventsMod) {
    _eventsModTried = true;
    try {
      const url = new URL("./lib/events.js", import.meta.url);
      _eventsMod = await import(url.href);
    } catch {
      _eventsMod = null;
      return;
    }
  }
  if (!_eventsMod || typeof _eventsMod.append !== "function") return;
  try {
    _eventsMod.append(evt);
  } catch {}
}

// 启动时一次性清理：默认名 session（24h 以上未用的）
//   旧实现直接 cleanupEmptyDefaultSessions()，无确认。
//   新实现：dryRun 算 count + ids → 写 audit → 推 auth request，
//   返回。real delete 在 authorize() resolve 后异步触发。
export function runStartupCleanup() {
  let orphanIds = [];
  try {
    orphanIds = _dryRunOrphanIds();
  } catch (e) {
    if (process.env.MCODE_USAGE_DEBUG) {
      console.warn(`[startup.cleanup] dry-run failed: ${e.message}`);
    }
  }

  // 启动后 5 秒触发 mcode commands cache（lazy init，第一次 /help 时会再触发）
  setTimeout(() => {
    ensureMcodeCommands().catch(() => {});
  }, 5000);

  if (!orphanIds || orphanIds.length === 0) {
    // Nothing to clean — silent exit, no audit, no authorize request.
    return;
  }

  // Write the dry-run audit (kind:"cleanup.dry_run" via events.js)
  //   and then push the authorize request. Do NOT await — startup
  //   returns immediately; the real delete runs when the user
  //   confirms or auto-timeout fires.
  _tryAppendEvent({
    kind: "cleanup.dry_run",
    target: "startup.cleanup",
    cid: null,
    actor: "startup",
    data: {
      orphanCount: orphanIds.length,
      orphanIds: orphanIds.slice(0, 32), // truncated for log hygiene
    },
  });

  authorize("startup.cleanup", {
    cid: "", // broadcast — any connected tab can decide
    orphanCount: orphanIds.length,
    orphanIds: orphanIds.slice(0, 32),
  }).then((result) => {
    if (!result.approved) {
      // Decline / timeout / cancel — disk untouched.
      _tryAppendEvent({
        kind: "cleanup.declined",
        target: "startup.cleanup",
        cid: null,
        actor: "user",
        data: {
          orphanCount: orphanIds.length,
          decidedBy: result.decidedBy,
          decidedAt: result.decidedAt,
        },
      });
      console.log(
        `[startup.cleanup] not run — authorize ${result.decidedBy} (orphanCount=${orphanIds.length})`,
      );
      return;
    }
    // Approved: real delete. cleanupEmptyDefaultSessions walks the
    //   same predicate; we trust it to remove exactly the same set
    //   (or fewer, if the user typed in a chat in the meantime).
    try {
      cleanupEmptyDefaultSessions();
      _tryAppendEvent({
        kind: "cleanup.commit",
        target: "startup.cleanup",
        cid: null,
        actor: "user",
        data: {
          orphanCount: orphanIds.length,
          decidedBy: result.decidedBy,
          decidedAt: result.decidedAt,
        },
      });
      console.log(
        `[startup.cleanup] user-approved — orphan cleanup ran (declared=${orphanIds.length})`,
      );
    } catch (e) {
      _tryAppendEvent({
        kind: "cleanup.error",
        target: "startup.cleanup",
        cid: null,
        actor: "system",
        data: { error: e && e.message ? e.message : String(e) },
      });
      console.warn(`[startup.cleanup] commit failed: ${e.message}`);
    }
  });
}
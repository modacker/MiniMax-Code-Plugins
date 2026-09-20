// webui/test/lib-db-resolver-c01.test.js
// Lease D01 — Coverage gap fillers for server/lib/db.js (C01 round 7).
//
// What's covered here vs the existing lib-db-resolver.test.js:
//   - Existing tests focused on the 4-tier candidate list shape
//     (env / MCODE_CMD / user-resolver / built-in).
//   - This file drills into the install-layout boundaries that the
//     existing tests do not assert:
//       1. MCODE_CMD=/usr/local/bin/mcode → npm-style + flat candidates
//       2. MCODE_CMD=<none> → "mcode" placeholder → no MCODE_CMD tier
//       3. MCODE_BETTER_SQLITE3 env overrides ALL others (priority pin)
//       4. db-resolver.json valid → applies, ordered between MCODE_CMD tier
//          and the home layout tier
//       5. db-resolver.json malformed → fail-open to []
//       6. db-resolver.json missing → fail-open to []
//       7. MCODE_WEBUI_RESOLVER_JSON env override (used by tests in some
//          hosts) directs the loader to a temp file outside home
//
// We do NOT exercise the actual better-sqlite3 native loading — that
// requires a real binary + sqlite3 fixture, which is covered in the
// integration suite. We DO exercise _probeCandidate / _loadUserResolverConfig
// / _getBetterSqlite3Candidates, which together cover most of db.js's
// resolver code (lines 56-217).

import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const SERVER_DIR = join(import.meta.dirname, "..", "server");
const absPath = (rel) => pathToFileURL(join(SERVER_DIR, rel)).href;
const dbUrl = absPath("lib/db.js");

let db;

before(async () => {
  db = await import(dbUrl);
});
after(() => {
  // Best-effort: clean up any leftover env overrides
  for (const k of [
    "MCODE_BETTER_SQLITE3",
    "MCODE_WEBUI_RESOLVER_JSON",
  ]) delete process.env[k];
});

// ---------------------------------------------------------------------------
// Tier 1 — env override (MCODE_BETTER_SQLITE3) — priority pinned ahead of
// every other tier regardless of MCODE_CMD shape or user resolver config.
// ---------------------------------------------------------------------------
describe("db.js — C01 MCODE_BETTER_SQLITE3 env priority", () => {
  test("env override is always the FIRST candidate (regardless of MCODE_CMD)", () => {
    const saved = process.env.MCODE_BETTER_SQLITE3;
    process.env.MCODE_BETTER_SQLITE3 = "/explicit/env-wins";
    try {
      const a = db._getBetterSqlite3Candidates({
        mcodeCmd: "/usr/local/bin/mcode",
        home: "/Users/example",
      });
      const b = db._getBetterSqlite3Candidates({
        mcodeCmd: "mcode",
        home: "/Users/example",
      });
      const c = db._getBetterSqlite3Candidates({
        mcodeCmd: "/opt/mcode/bin/mcode",
        home: "/Users/example",
      });
      assert.equal(a[0], "/explicit/env-wins", "env must lead (npm-global mcodeCmd)");
      assert.equal(b[0], "/explicit/env-wins", "env must lead (PATH placeholder mcodeCmd)");
      assert.equal(c[0], "/explicit/env-wins", "env must lead (custom layout mcodeCmd)");
    } finally {
      if (saved === undefined) delete process.env.MCODE_BETTER_SQLITE3;
      else process.env.MCODE_BETTER_SQLITE3 = saved;
    }
  });

  test("env override is appended once, NOT duplicated by home / dev layout", () => {
    const saved = process.env.MCODE_BETTER_SQLITE3;
    process.env.MCODE_BETTER_SQLITE3 = "/once/please";
    try {
      const list = db._getBetterSqlite3Candidates({
        mcodeCmd: "mcode",
        home: "/Users/example",
      });
      const count = list.filter((c) => c === "/once/please").length;
      assert.equal(count, 1, `env override should appear exactly once, got ${count}`);
    } finally {
      if (saved === undefined) delete process.env.MCODE_BETTER_SQLITE3;
      else process.env.MCODE_BETTER_SQLITE3 = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — MCODE_CMD reverse-derived candidates
// ---------------------------------------------------------------------------
describe("db.js — C01 MCODE_CMD path reverse", () => {
  test("/usr/local/bin/mcode produces BOTH npm-style and flat candidates", () => {
    const saved = process.env.MCODE_BETTER_SQLITE3;
    delete process.env.MCODE_BETTER_SQLITE3;
    try {
      const list = db._getBetterSqlite3Candidates({
        mcodeCmd: "/usr/local/bin/mcode",
        home: "/Users/example",
      });
      const npmStyle = "/usr/local/lib/node_modules/@minimax-ai/code/node_modules/better-sqlite3";
      const flat = "/usr/local/bin/node_modules/@minimax-ai/code/node_modules/better-sqlite3";
      assert.ok(
        list.includes(npmStyle),
        `npm-style missing — list: ${JSON.stringify(list)}`,
      );
      assert.ok(
        list.includes(flat),
        `flat missing — list: ${JSON.stringify(list)}`,
      );
    } finally {
      if (saved !== undefined) process.env.MCODE_BETTER_SQLITE3 = saved;
    }
  });

  test("/opt/mcode/bin/mcode produces BOTH candidates (slash-relative paths)", () => {
    const saved = process.env.MCODE_BETTER_SQLITE3;
    delete process.env.MCODE_BETTER_SQLITE3;
    try {
      const list = db._getBetterSqlite3Candidates({
        mcodeCmd: "/opt/mcode/bin/mcode",
        home: "/Users/example",
      });
      const npmStyle = "/opt/mcode/lib/node_modules/@minimax-ai/code/node_modules/better-sqlite3";
      const flat = "/opt/mcode/bin/node_modules/@minimax-ai/code/node_modules/better-sqlite3";
      assert.ok(list.includes(npmStyle));
      assert.ok(list.includes(flat));
    } finally {
      if (saved !== undefined) process.env.MCODE_BETTER_SQLITE3 = saved;
    }
  });

  test("Windows-style C:\\path\\to\\mcode.cmd forwards segments verbatim", () => {
    // No normalization — the candidate builder just joins(dirname(...), "lib", "node_modules", ...).
    // We assert that the segments ending in lib/ and bin/node_modules/ are produced as-is.
    const saved = process.env.MCODE_BETTER_SQLITE3;
    delete process.env.MCODE_BETTER_SQLITE3;
    try {
      const list = db._getBetterSqlite3Candidates({
        mcodeCmd: "C:\\Users\\dev\\AppData\\Roaming\\npm\\mcode.cmd",
        home: "C:\\Users\\dev",
      });
      // npm-style entry should contain "lib\\node_modules\\...\\better-sqlite3"
      const hasLib = list.some((c) => c.includes("lib") && c.endsWith("better-sqlite3"));
      assert.ok(hasLib, `lib-based candidate missing — list: ${JSON.stringify(list)}`);
    } finally {
      if (saved !== undefined) process.env.MCODE_BETTER_SQLITE3 = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Tier 3 — db-resolver.json — valid / missing / malformed
// ---------------------------------------------------------------------------
describe("db.js — C01 db-resolver.json 3-state semantics", () => {
  let tmpHome;
  before(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mcode-d01-resolver-"));
  });
  after(() => {
    if (tmpHome) {
      try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
      tmpHome = null;
    }
    delete process.env.MCODE_WEBUI_RESOLVER_JSON;
  });

  test("missing db-resolver.json → loadUserResolverConfig returns []", () => {
    // home has no .mcode-webui/ directory at all
    const cfgHome = mkdtempSync(join(tmpdir(), "mcode-d01-empty-"));
    try {
      const out = db._loadUserResolverConfig({ home: cfgHome });
      assert.deepEqual(out, [], "no .mcode-webui/ → empty array");
    } finally {
      try { rmSync(cfgHome, { recursive: true, force: true }); } catch {}
    }
  });

  test("malformed JSON → loadUserResolverConfig returns [] (fail-open)", () => {
    const cfgHome = mkdtempSync(join(tmpdir(), "mcode-d01-malformed-"));
    try {
      mkdirSync(join(cfgHome, ".mcode-webui"), { recursive: true });
      writeFileSync(
        join(cfgHome, ".mcode-webui", "db-resolver.json"),
        "{ this is not valid JSON ::",
      );
      const out = db._loadUserResolverConfig({ home: cfgHome });
      assert.deepEqual(out, [], "garbage JSON must yield []");
    } finally {
      try { rmSync(cfgHome, { recursive: true, force: true }); } catch {}
    }
  });

  test("missing `better_sqlite3_candidates` field → returns []", () => {
    const cfgHome = mkdtempSync(join(tmpdir(), "mcode-d01-no-field-"));
    try {
      mkdirSync(join(cfgHome, ".mcode-webui"), { recursive: true });
      writeFileSync(
        join(cfgHome, ".mcode-webui", "db-resolver.json"),
        JSON.stringify({ something_else: ["x"] }),
      );
      const out = db._loadUserResolverConfig({ home: cfgHome });
      assert.deepEqual(out, [], "missing field must yield []");
    } finally {
      try { rmSync(cfgHome, { recursive: true, force: true }); } catch {}
    }
  });

  test("non-array `better_sqlite3_candidates` field → returns []", () => {
    const cfgHome = mkdtempSync(join(tmpdir(), "mcode-d01-noarray-"));
    try {
      mkdirSync(join(cfgHome, ".mcode-webui"), { recursive: true });
      writeFileSync(
        join(cfgHome, ".mcode-webui", "db-resolver.json"),
        JSON.stringify({ better_sqlite3_candidates: "single path" }),
      );
      const out = db._loadUserResolverConfig({ home: cfgHome });
      assert.deepEqual(out, [], "non-array field must yield []");
    } finally {
      try { rmSync(cfgHome, { recursive: true, force: true }); } catch {}
    }
  });

  test("valid JSON with string array → returns the string array filtered", () => {
    const cfgHome = mkdtempSync(join(tmpdir(), "mcode-d01-valid-"));
    try {
      mkdirSync(join(cfgHome, ".mcode-webui"), { recursive: true });
      const userPinned = "/Users/dev/local/share/better-sqlite3/better-sqlite3";
      writeFileSync(
        join(cfgHome, ".mcode-webui", "db-resolver.json"),
        JSON.stringify({
          better_sqlite3_candidates: [userPinned, "/another/path", null, 42, ""],
        }),
      );
      const out = db._loadUserResolverConfig({ home: cfgHome });
      assert.deepEqual(out, [userPinned, "/another/path"]);
    } finally {
      try { rmSync(cfgHome, { recursive: true, force: true }); } catch {}
    }
  });

  test("valid user resolver entries are inserted into the candidate list (tier 3)", () => {
    const saved = process.env.MCODE_BETTER_SQLITE3;
    delete process.env.MCODE_BETTER_SQLITE3;
    delete process.env.MCODE_WEBUI_RESOLVER_JSON;
    try {
      // Use MCODE_WEBUI_RESOLVER_JSON env override so the loader reads
      // from a temp file rather than the real ~/.mcode-webui/.
      const cfgFile = join(tmpHome, "db-resolver.json");
      writeFileSync(
        cfgFile,
        JSON.stringify({
          better_sqlite3_candidates: ["/pinned/user/path/better-sqlite3"],
        }),
      );
      process.env.MCODE_WEBUI_RESOLVER_JSON = cfgFile;
      const list = db._getBetterSqlite3Candidates({
        mcodeCmd: "mcode",
        home: "/Users/example",
      });
      assert.ok(
        list.includes("/pinned/user/path/better-sqlite3"),
        `tier 3 entry missing from ${JSON.stringify(list)}`,
      );
      // Index ordering: tier 3 (user resolver) comes BEFORE tier 4 (home layout).
      const idx = list.indexOf("/pinned/user/path/better-sqlite3");
      const homeLayoutIdx = list.indexOf(
        "/Users/example/.minimax-code/lib/node_modules/@minimax-ai/code/node_modules/better-sqlite3",
      );
      assert.ok(idx >= 0 && homeLayoutIdx >= 0 && idx < homeLayoutIdx, "tier 3 must precede tier 4");
    } finally {
      if (saved !== undefined) process.env.MCODE_BETTER_SQLITE3 = saved;
      delete process.env.MCODE_WEBUI_RESOLVER_JSON;
    }
  });
});

// ---------------------------------------------------------------------------
// Tier 4 — built-in home + dev layout fallback
// ---------------------------------------------------------------------------
describe("db.js — C01 built-in fallback ordering", () => {
  test("~/.minimax-code/lib/... layout always present regardless of MCODE_CMD", () => {
    const saved = process.env.MCODE_BETTER_SQLITE3;
    delete process.env.MCODE_BETTER_SQLITE3;
    try {
      const a = db._getBetterSqlite3Candidates({
        mcodeCmd: "/usr/local/bin/mcode",
        home: "/Users/example",
      });
      const b = db._getBetterSqlite3Candidates({
        mcodeCmd: "mcode",
        home: "/Users/example",
      });
      const expected = "/Users/example/.minimax-code/lib/node_modules/@minimax-ai/code/node_modules/better-sqlite3";
      assert.ok(a.includes(expected), `a missing: ${JSON.stringify(a)}`);
      assert.ok(b.includes(expected), `b missing: ${JSON.stringify(b)}`);
    } finally {
      if (saved !== undefined) process.env.MCODE_BETTER_SQLITE3 = saved;
    }
  });

  test("dev layout fallback is always the LAST candidate (lowest priority)", () => {
    const saved = process.env.MCODE_BETTER_SQLITE3;
    delete process.env.MCODE_BETTER_SQLITE3;
    try {
      const list = db._getBetterSqlite3Candidates({
        mcodeCmd: "/usr/local/bin/mcode",
        home: "/Users/example",
      });
      const last = list[list.length - 1];
      const segs = last.split(/[\\/]/).slice(-5);
      assert.deepEqual(
        segs,
        ["node_modules", "@minimax-ai", "code", "node_modules", "better-sqlite3"],
        `dev layout must end in better-sqlite3 path; got ${last}`,
      );
    } finally {
      if (saved !== undefined) process.env.MCODE_BETTER_SQLITE3 = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// deleteMcodeSessionFromDb — pre-flight gates (no sqlite required)
// ---------------------------------------------------------------------------
describe("db.js — D01 deleteMcodeSessionFromDb pre-flight gates", () => {
  let realDbPath;
  before(() => {
    realDbPath = mkdtempSync(join(tmpdir(), "mcode-d01-realdb-")) + "/fixture.sqlite";
    writeFileSync(realDbPath, "");
  });

  test("invalid sid → {ok:false, reason:'not_mcode_sid'} WITHOUT touching db", () => {
    const r = db.deleteMcodeSessionFromDb("not-a-mvs-id", {
      MCODE_RUNTIME_DB: "/tmp/db.sqlite",
    });
    assert.deepEqual(r, { ok: false, reason: "not_mcode_sid" });
  });

  test("missing MCODE_RUNTIME_DB → {ok:false, reason:'mcode_db_not_found'} (db path wins over sqlite3)", () => {
    const r = db.deleteMcodeSessionFromDb("mvs_abcdef0123456789abcdef0123456789", {});
    assert.deepEqual(r, { ok: false, reason: "mcode_db_not_found" });
  });

  test("MCODE_RUNTIME_DB pointing at a non-existent file → mcode_db_not_found", () => {
    const r = db.deleteMcodeSessionFromDb("mvs_abcdef0123456789abcdef0123456789", {
      MCODE_RUNTIME_DB: "/this/path/does/not/exist/sqlite.db",
    });
    assert.deepEqual(r, { ok: false, reason: "mcode_db_not_found" });
  });

  test("MCODE_RUNTIME_DB exists but better-sqlite3 not loaded → better_sqlite3_not_loaded", () => {
    // Real file so existsSync returns true. better-sqlite3 is the next
    // gate. The function returns either {reason: "better_sqlite3_not_loaded"}
    // or {error: <string>} depending on whether the resolver short-circuits.
    const r = db.deleteMcodeSessionFromDb("mvs_abcdef0123456789abcdef0123456789", {
      MCODE_RUNTIME_DB: realDbPath,
    });
    assert.equal(r.ok, false, "delete must not succeed when sqlite isn't loadable");
    assert.ok(
      r.reason === "better_sqlite3_not_loaded" || typeof r.error === "string",
      `expected reason or error info, got ${JSON.stringify(r)}`,
    );
  });

  test("dry-run with unavailable better-sqlite3 still surfaces NOT ok", () => {
    const r = db.deleteMcodeSessionFromDb("mvs_abcdef0123456789abcdef0123456789", {
      MCODE_RUNTIME_DB: realDbPath,
      dryRun: true,
    });
    assert.equal(r.ok, false, "dryRun must not succeed without sqlite either");
  });

  test("MCODE_SESSION_DELETE_TABLES has all expected table names (regression guard)", () => {
    const names = db.MCODE_SESSION_DELETE_TABLES;
    assert.ok(Array.isArray(names));
    assert.ok(names.includes("local_runtime_sessions"));
    assert.ok(names.includes("local_runtime_messages"));
    assert.ok(names.includes("local_runtime_token_usage"));
    assert.ok(names.length >= 30, `expected ≥30 tables, got ${names.length}`);
  });
});

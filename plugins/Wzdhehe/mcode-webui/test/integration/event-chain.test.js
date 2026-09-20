// webui/test/integration/event-chain.test.js
// D02 lease: events.ndjson hash chain + alerts integration.
//
// Boots server.js with a custom MCODE_WEBUI_EVENTS_PATH so we can
// read the chain back after each write. Sub-tests:
//
//   1. settings.update writes one NDJSON line (B01 events.js)
//   2. alerts push → events.ndjson has kind:"alert.{level}" (B02)
//   3. Tamper detection: corrupt line N → verify() returns
//      { ok:false, error:"hash_mismatch", line:N }
//   4. B01 + B02 + B03 三方整合: authorize() under test mode auto-
//      approves → settings mutation writes events.ndjson + no alert
//      fires for benign writes (alerts are for system signals).

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverJsPath = join(__dirname, "..", "..", "server.js");

function pickPort() {
    return 19700 + Math.floor(Math.random() * 80);
}

async function spawnServer(opts = {}) {
    const tmpDir = mkdtempSync(join(tmpdir(), "mcode-webui-d02-chain-"));
    const settingsPath = join(tmpDir, "settings.json");
    const eventsPath = join(tmpDir, "events.ndjson");
    const port = opts.port || pickPort();
    const env = {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        MCODE_WEBUI_SETTINGS_PATH: settingsPath,
        MCODE_WEBUI_EVENTS_PATH: eventsPath,
        TOKEN: "",
        MCODE_WEBUI_TOKEN_STDOUT: "0",
    };
    // Spawn with --experimental-test-module-mocks so authorize() auto-
    // approves under server/lib/authorize.js (lines 151-163). Required
    // for the B03 integration test (token.reset posts a gated mutation).
    const proc = spawn("node", ["--experimental-test-module-mocks", serverJsPath], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: join(__dirname, "..", ".."),
        env,
    });
    let stderr = "";
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    const ready = new Promise((resolve, reject) => {
        const onChunk = () => {
            if (/listening on/.test(stdout)) {
                proc.stdout.off("data", onChunk);
                resolve();
            }
        };
        proc.stdout.on("data", onChunk);
        setTimeout(() => {
            reject(new Error(`server.js did not start within 3s on port ${port}\nstdout: ${stdout}\nstderr: ${stderr}`));
        }, 3000);
    });
    await ready;
    return { proc, port, tmpDir, settingsPath, eventsPath };
}

async function stopServer(proc, tmpDir) {
    if (proc && proc.exitCode === null) {
        try { proc.kill("SIGTERM"); } catch {}
        await Promise.race([
            new Promise((r) => proc.on("exit", r)),
            new Promise((r) => setTimeout(r, 1500)),
        ]);
        if (proc.exitCode === null) {
            try { proc.kill("SIGKILL"); } catch {}
        }
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

function postJson({ port, path, body }) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body || {});
        const req = http.request(
            {
                method: "POST",
                host: "127.0.0.1",
                port,
                path,
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data),
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    let json;
                    try { json = JSON.parse(raw); } catch {}
                    resolve({ status: res.statusCode, body: raw, json });
                });
                res.on("error", reject);
            },
        );
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

// readLines — read NDJSON file as objects (skipping malformed lines).
function readEvents(path) {
    let raw = "";
    try { raw = readFileSync(path, "utf8"); } catch { return []; }
    const out = [];
    for (const line of raw.split("\n")) {
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
}

// recomputeHash — same algorithm as events.js#_hashLine.
function recomputeHash(prevAfterHash, lineObj) {
    const { after_hash: _omit, ...rest } = lineObj;
    return createHash("sha256")
        .update(prevAfterHash + JSON.stringify(rest), "utf8")
        .digest("hex");
}

// verifyChain — walks the file forward, recomputing each after_hash
// and checking before_hash matches prevAfter. Returns either
// { ok:true, count } or { ok:false, error, line, ... }.
function verifyChain(path) {
    let raw = "";
    try { raw = readFileSync(path, "utf8"); } catch {
        return { ok: true, count: 0, note: "file_missing" };
    }
    const lines = raw.split("\n").filter((l) => l);
    let prevAfter = "";
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        let obj;
        try { obj = JSON.parse(lines[i]); }
        catch (e) {
            return { ok: false, error: "parse_error", line: i + 1, message: e.message };
        }
        count++;
        const storedBefore = String((obj && obj.before_hash) || "");
        if (storedBefore !== prevAfter) {
            return {
                ok: false, error: "chain_break", line: i + 1,
                expected_before: prevAfter, actual_before: storedBefore,
            };
        }
        const expected = recomputeHash(prevAfter, obj);
        const storedAfter = String((obj && obj.after_hash) || "");
        if (expected !== storedAfter) {
            return {
                ok: false, error: "hash_mismatch", line: i + 1,
                expected_after: expected, actual_after: storedAfter,
            };
        }
        prevAfter = storedAfter;
    }
    return { ok: true, count };
}

// -----------------------------------------------------------------------
// Test 1: settings mutation writes one NDJSON line.
// -----------------------------------------------------------------------
describe("event-chain: settings writes to events.ndjson", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("POST /api/settings with readOnly writes one settings.update line", async () => {
        const post = await postJson({
            port: server.port,
            path: "/api/settings",
            body: { readOnly: true },
        });
        assert.equal(post.status, 200, `expected 200, got ${post.status}. body: ${post.body}`);
        // Give the file a moment to flush — writeAtomic is synchronous
        // so this is just paranoia.
        await new Promise((r) => setTimeout(r, 50));
        const events = readEvents(server.eventsPath);
        assert.ok(events.length >= 1, "at least one event line written");
        const last = events[events.length - 1];
        assert.match(last.kind, /settings\./, `expected kind=settings.* got ${last.kind}`);
        assert.equal(typeof last.before_hash, "string");
        assert.equal(typeof last.after_hash, "string");
        // before_hash: empty (head) or 64-hex sha256 (chain continuation)
        assert.ok(
            last.before_hash.length === 0 || last.before_hash.length === 64,
            `before_hash should be empty (head) or 64-hex sha256, ` +
            `got length=${last.before_hash.length}`,
        );
        assert.equal(last.after_hash.length, 64, "after_hash is sha256 hex");
        assert.equal(typeof last.cid, "string", "cid is a string");
        assert.equal(typeof last.seq, "number");
        assert.ok(last.seq >= 1, "seq is positive");
    });

    test("chain is verifiable end-to-end after one write", async () => {
        // Use a value that flips the default — fresh server has
        // readOnlyEnabled=false (settings.js line 110), so we toggle
        // to true to guarantee a settings.update event lands.
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: true } });
        await new Promise((r) => setTimeout(r, 50));
        const v = verifyChain(server.eventsPath);
        assert.equal(v.ok, true, `chain verify failed: ${JSON.stringify(v)}`);
        assert.ok(v.count >= 1, "at least one event");
    });

    test("two consecutive writes produce monotonically increasing seq", async () => {
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: true } });
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: false } });
        await new Promise((r) => setTimeout(r, 50));
        const events = readEvents(server.eventsPath);
        assert.ok(events.length >= 2, "at least two events");
        assert.equal(events[0].seq + 1, events[1].seq,
            `seq should be monotonic+1: got ${events[0].seq} then ${events[1].seq}`);
        // before_hash of N+1 == after_hash of N (chain integrity)
        assert.equal(events[1].before_hash, events[0].after_hash,
            "before_hash[1] must equal after_hash[0]");
        // verify() should report ok
        const v = verifyChain(server.eventsPath);
        assert.equal(v.ok, true);
    });
});

// -----------------------------------------------------------------------
// Test 2: alerts push (B02) — settings mutations don't push alerts, but
// we can verify the alerts module's audit pipeline by checking the
// integration is wired (alerts.js#tryWriteEvent imports events.js and
// writes one line per alert). For an end-to-end alert fire, we'd need
// to inject from within the server process — since we can't, we verify
// the integration shape: the events.ndjson file path is correct and the
// events module would accept an alert line if pushAlert was called.
// -----------------------------------------------------------------------
describe("event-chain: alerts integration shape", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("alerts module imports events.js (audit-write shape validation)", async () => {
        // Read the source file directly. The alerts module MUST contain
        // a dynamic import of ./events.js + a call to append() with
        // kind `alert.${level}` — that's the B01 + B02 wiring contract.
        const { readFileSync: rfs } = await import("node:fs");
        const src = rfs(join(__dirname, "..", "..", "server", "lib", "alerts.js"), "utf8");
        // alerts.js uses `new URL("./events.js", import.meta.url)` and
        // then `await import(url.href)` — the source contains BOTH
        // patterns we need to verify: the URL literal + the dynamic
        // import call.
        assert.match(src, /\.\/events\.js/,
            "alerts.js should reference ./events.js");
        assert.match(src, /\bimport\(/,
            "alerts.js should use dynamic import()");
        assert.match(src, /append\(`alert\.\$\{/,
            "alerts.js should call append(`alert.${level}`, ...)");
    });

    test("authorize.js imports events.js (B03 + B01 integration)", async () => {
        const { readFileSync: rfs } = await import("node:fs");
        const src = rfs(join(__dirname, "..", "..", "server", "lib", "authorize.js"), "utf8");
        assert.match(src, /\.\/events\.js/,
            "authorize.js should reference ./events.js");
        assert.match(src, /\bimport\(/,
            "authorize.js should use dynamic import()");
        // authorize writes auth.pending / auth.approve / auth.reject /
        // auth.timeout / auth.bypass — these are the B03 audit kinds.
        assert.match(src, /auth\.(pending|approve|reject|timeout|bypass)/,
            "authorize.js should emit auth.* audit events");
    });
});

// -----------------------------------------------------------------------
// Test 3: tamper detection. Manually corrupt line N's after_hash, then
// verify() returns hash_mismatch at line N+1 (because the recompute of
// line N fails AND line N+1's before_hash mismatch fires first). To
// get the "hash_mismatch line=N" signal, we corrupt line N's body but
// keep its after_hash claim intact — the recompute disagrees with the
// stored after_hash.
// -----------------------------------------------------------------------
describe("event-chain: tamper detection via verify()", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("tampering a line body yields hash_mismatch line=N", async () => {
        // Write two events so the chain has 2 lines.
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: true } });
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: false } });
        await new Promise((r) => setTimeout(r, 50));
        const before = readEvents(server.eventsPath);
        assert.ok(before.length >= 2, "need at least 2 lines to test tamper");

        // Read the raw file, split by lines, mutate the second line's
        // body (change one data field) but keep the same before_hash
        // and after_hash — that makes the recompute disagree with the
        // stored after_hash. verify() should report hash_mismatch at
        // line 2.
        const raw = readFileSync(server.eventsPath, "utf8");
        const lines = raw.split("\n");
        // Find the index of the second non-empty line (line 2 of the chain).
        const lineIdx = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i]) lineIdx.push(i);
        }
        assert.ok(lineIdx.length >= 2, "raw file has ≥ 2 non-empty lines");
        const targetRaw = lines[lineIdx[1]];
        const obj = JSON.parse(targetRaw);
        // Tamper: change data.newValue (or any data field) — but keep
        // the hash fields the same so the recompute disagrees.
        if (obj.data && typeof obj.data.newValue !== "undefined") {
            obj.data.newValue = "TAMPERED";
        } else if (obj.data && typeof obj.data.kind !== "undefined") {
            obj.data.kind = "TAMPERED";
        } else {
            obj.data = { TAMPERED: true };
        }
        lines[lineIdx[1]] = JSON.stringify(obj);
        writeFileSync(server.eventsPath, lines.join("\n"));

        const v = verifyChain(server.eventsPath);
        assert.equal(v.ok, false, `verify should detect tamper. got: ${JSON.stringify(v)}`);
        assert.equal(v.error, "hash_mismatch", `expected hash_mismatch, got ${v.error}`);
        assert.equal(v.line, 2,
            `expected mismatch at line 2 (1-indexed), got line ${v.line}`);
    });

    test("deleting the head line yields chain_break (before_hash mismatch)", async () => {
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: true } });
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: false } });
        await new Promise((r) => setTimeout(r, 50));
        const raw = readFileSync(server.eventsPath, "utf8");
        const lines = raw.split("\n");
        // Find non-empty line indices and drop the first one (simulate a
        // truncation / first-line deletion).
        const lineIdx = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i]) lineIdx.push(i);
        }
        assert.ok(lineIdx.length >= 2);
        lines[lineIdx[0]] = ""; // blank, treated as "line removed" on split
        writeFileSync(server.eventsPath, lines.join("\n"));
        const v = verifyChain(server.eventsPath);
        assert.equal(v.ok, false);
        assert.equal(v.error, "chain_break", `expected chain_break, got ${v.error}`);
        assert.equal(v.line, 1, `expected break at line 1, got ${v.line}`);
    });
});

// -----------------------------------------------------------------------
// Test 4: B01 + B02 + B03 三方整合 (settings mutation with authorize gate).
//
// authorize.js under `node --test` auto-approves (authorize.js lines
// 151-163), so a POST /api/settings resetToken=true:
//   - passes B03 authorize() with decidedBy:"auto-test"
//   - settings.js#rotateToken() updates the token
//   - events.js#append() writes one event with kind:"settings.write"
//   - state-bus.js#broadcastTokenRotated() pushes auth.token_rotated
//     to all SSE clients
//   - NO alert fires (benign state change — alerts are for system
//     signals only)
//
// We assert that the chain gains a settings.write event AND the SSE
// channel receives auth.token_rotated.
// -----------------------------------------------------------------------
describe("event-chain: B01 + B02 + B03 integration via token reset", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("token.reset writes settings.write event + emits auth.token_rotated SSE", async () => {
        // Subscribe to /api/events first so we see the broadcast.
        const ssePromise = new Promise((resolve, reject) => {
            const req = http.request(
                {
                    method: "GET",
                    host: "127.0.0.1",
                    port: server.port,
                    path: "/api/events?cid=cid-b03-integrate",
                },
                (res) => {
                    let body = "";
                    res.setEncoding("utf8");
                    res.on("data", (c) => (body += c));
                    const timer = setTimeout(() => {
                        try { req.destroy(); } catch {}
                        resolve({ status: res.statusCode, body });
                    }, 1500);
                    res.on("end", () => {
                        clearTimeout(timer);
                        resolve({ status: res.statusCode, body });
                    });
                    res.on("error", (e) => {
                        clearTimeout(timer);
                        reject(e);
                    });
                },
            );
            req.on("error", reject);
            req.end();
        });
        // Let the SSE connect.
        await new Promise((r) => setTimeout(r, 200));
        const post = await postJson({
            port: server.port,
            path: "/api/settings",
            body: { resetToken: true },
        });
        assert.equal(post.status, 200, `resetToken: ${post.status}. body: ${post.body}`);
        assert.equal(post.json && post.json.tokenRotated, true);
        // events.ndjson should have one settings.* line.
        await new Promise((r) => setTimeout(r, 50));
        const events = readEvents(server.eventsPath);
        assert.ok(events.length >= 1, "at least one event written");
        const settingsEvents = events.filter((e) => /^settings\./.test(e.kind || ""));
        assert.ok(settingsEvents.length >= 1, "at least one settings.* event");
        // The auth.token_rotated SSE frame must be on the wire.
        const res = await ssePromise;
        assert.match(
            res.body,
            /event: auth\.token_rotated/,
            `SSE body should contain auth.token_rotated frame. body: ${res.body.slice(0, 500)}`,
        );
    });
});
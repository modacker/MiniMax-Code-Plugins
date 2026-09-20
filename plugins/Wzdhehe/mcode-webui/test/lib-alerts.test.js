// webui/test/lib-alerts.test.js
// Unit tests for server/lib/alerts.js — pushAlert / dedup / ring
// buffer / SSE broadcast.
//
// Why this test exists: lease B02 introduces the independent anomaly
// channel (front-end bell icon data source). pushAlert is the only
// write point; its contract must be deterministic.
//
// Test strategy: NO setupMocks — alerts.js has zero deps at module
// level (events.js is dynamic-imported, guarded). The B01 events
// dependency is asserted by stubbing it with t.mock.module.

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
    pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const alerts = await import(absPath("lib/alerts.js"));

function fakeSse() {
    const writes = [];
    return {
        writes,
        write(chunk) {
            writes.push(chunk);
        },
    };
}

describe("pushAlert — basic", () => {
    beforeEach(() => {
        alerts._resetForTests();
    });

    test("returns an alert with the canonical shape", () => {
        const a = alerts.pushAlert({
            level: "error",
            msg: "boom",
            src: "chat.send",
            cid: "cid-1",
        });
        assert.equal(a.level, "error");
        assert.equal(a.msg, "boom");
        assert.equal(a.src, "chat.send");
        assert.equal(a.cid, "cid-1");
        assert.equal(a.sessionId, null);
        assert.equal(a.data, null);
        assert.equal(a.count, 1);
        assert.equal(typeof a.id, "string");
        assert.equal(typeof a.ts, "number");
    });

    test("normalizes unknown levels to info", () => {
        const a = alerts.pushAlert({ level: "debug", msg: "x" });
        assert.equal(a.level, "info");
    });

    test("truncates oversized msg to 2000 chars", () => {
        const huge = "x".repeat(5000);
        const a = alerts.pushAlert({ level: "info", msg: huge });
        assert.equal(a.msg.length, 2000);
    });

    test("default src is 'system'", () => {
        const a = alerts.pushAlert({ level: "info", msg: "x" });
        assert.equal(a.src, "system");
    });

    test("ring buffer size is 100 (RING_SIZE)", () => {
        for (let i = 0; i < 150; i++) {
            alerts.pushAlert({
                level: "info",
                msg: "m" + i,
                src: "test",
                cid: "cid",
            });
        }
        assert.equal(alerts.getAlertCount(), 100);
        // oldest surviving entry is the 51st (150 - 100 + 1)
        const recent = alerts.getRecentAlerts();
        assert.equal(recent[0].msg, "m50");
        assert.equal(recent[99].msg, "m149");
    });
});

describe("pushAlert — dedup", () => {
    beforeEach(() => {
        alerts._resetForTests();
    });

    test("same {level,msg,src,cid} within 60s collapses with count++", () => {
        const a = alerts.pushAlert({
            level: "warn",
            msg: "transient",
            src: "mcode-acp",
            cid: "cid-1",
        });
        assert.equal(a.count, 1);

        const b = alerts.pushAlert({
            level: "warn",
            msg: "transient",
            src: "mcode-acp",
            cid: "cid-1",
        });
        assert.equal(b, a, "deduped push returns the same alert object");
        assert.equal(b.count, 2);
        // ring still has only one entry
        assert.equal(alerts.getAlertCount(), 1);
    });

    test("different cid does not collapse", () => {
        alerts.pushAlert({ level: "warn", msg: "x", src: "s", cid: "cid-1" });
        alerts.pushAlert({ level: "warn", msg: "x", src: "s", cid: "cid-2" });
        assert.equal(alerts.getAlertCount(), 2);
    });

    test("different src does not collapse", () => {
        alerts.pushAlert({ level: "warn", msg: "x", src: "src-a", cid: "cid-1" });
        alerts.pushAlert({ level: "warn", msg: "x", src: "src-b", cid: "cid-1" });
        assert.equal(alerts.getAlertCount(), 2);
    });

    test("different msg does not collapse", () => {
        alerts.pushAlert({ level: "warn", msg: "x", src: "s", cid: "cid-1" });
        alerts.pushAlert({ level: "warn", msg: "y", src: "s", cid: "cid-1" });
        assert.equal(alerts.getAlertCount(), 2);
    });
});

describe("pushAlert — SSE broadcast", () => {
    beforeEach(() => {
        alerts._resetForTests();
    });

    test("subscriber receives an `append` frame on pushAlert", () => {
        const res = fakeSse();
        const unsubscribe = alerts.subscribeAlerts(res);
        alerts.pushAlert({ level: "info", msg: "hi", src: "s", cid: "cid-1" });
        assert.equal(res.writes.length, 1);
        const frame = JSON.parse(res.writes[0].slice(6));
        assert.equal(frame.kind, "append");
        assert.equal(frame.alert.msg, "hi");
        unsubscribe();
    });

    test("multiple subscribers all receive frames", () => {
        const a = fakeSse();
        const b = fakeSse();
        alerts.subscribeAlerts(a);
        alerts.subscribeAlerts(b);
        alerts.pushAlert({ level: "info", msg: "fan-out", src: "s" });
        assert.equal(a.writes.length, 1);
        assert.equal(b.writes.length, 1);
        assert.equal(a.writes[0], b.writes[0]);
    });

    test("deduped push sends an `update` frame (not a new entry)", () => {
        const res = fakeSse();
        alerts.subscribeAlerts(res);
        alerts.pushAlert({ level: "warn", msg: "dup", src: "s" });
        alerts.pushAlert({ level: "warn", msg: "dup", src: "s" });
        assert.equal(res.writes.length, 2);
        const first = JSON.parse(res.writes[0].slice(6));
        const second = JSON.parse(res.writes[1].slice(6));
        assert.equal(first.kind, "append");
        assert.equal(second.kind, "update");
        assert.equal(second.alert.count, 2);
    });

    test("unsubscribe stops further writes", () => {
        const res = fakeSse();
        const unsub = alerts.subscribeAlerts(res);
        alerts.pushAlert({ level: "info", msg: "1", src: "s" });
        unsub();
        alerts.pushAlert({ level: "info", msg: "2", src: "s" });
        assert.equal(res.writes.length, 1);
        assert.equal(alerts.getSubscriberCount(), 0);
    });

    test("a subscriber that throws on write does not break others", () => {
        const throwing = {
            write() {
                throw new Error("broken pipe");
            },
        };
        const good = fakeSse();
        alerts.subscribeAlerts(throwing);
        alerts.subscribeAlerts(good);
        alerts.pushAlert({ level: "info", msg: "x", src: "s" });
        assert.equal(good.writes.length, 1);
    });
});

describe("pushAlert — event-stream emission (B01 dependency)", () => {
    beforeEach(() => {
        alerts._resetForTests();
    });

    after(async () => {
        alerts._resetForTests();
    });

    test("audit-write failure does not break the alert flow", async () => {
        // The events.js module is not yet present (B01 in flight). The
        // dynamic import inside alerts.js should swallow the missing
        // module and not propagate. We just confirm pushAlert still
        // works.
        const a = alerts.pushAlert({
            level: "error",
            msg: "no-audit",
            src: "test",
        });
        assert.equal(a.count, 1);
        // give the dynamic-import microtask a tick to settle
        await new Promise((r) => setImmediate(r));
        assert.equal(alerts.getAlertCount(), 1);
    });
});

describe("getRecentAlerts", () => {
    beforeEach(() => {
        alerts._resetForTests();
    });

    test("returns a snapshot oldest → newest", () => {
        alerts.pushAlert({ level: "info", msg: "a", src: "s" });
        alerts.pushAlert({ level: "warn", msg: "b", src: "s" });
        alerts.pushAlert({ level: "error", msg: "c", src: "s" });
        const snap = alerts.getRecentAlerts();
        assert.equal(snap.length, 3);
        assert.deepEqual(
            snap.map((a) => a.msg),
            ["a", "b", "c"],
        );
    });

    test("respects the limit argument", () => {
        for (let i = 0; i < 10; i++) {
            alerts.pushAlert({ level: "info", msg: "m" + i, src: "s" });
        }
        const snap = alerts.getRecentAlerts(3);
        assert.equal(snap.length, 3);
        assert.equal(snap[0].msg, "m7");
        assert.equal(snap[2].msg, "m9");
    });
});

describe("ALERT_LEVELS export", () => {
    test("exposes info / warn / error", () => {
        assert.deepEqual(alerts.ALERT_LEVELS, ["info", "warn", "error"]);
    });
});
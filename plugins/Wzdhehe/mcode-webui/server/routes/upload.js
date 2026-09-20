// webui/server/routes/upload.js
// POST /api/upload — multipart file save

import { saveMultipartUpload } from "../lib/upload.js";
// B01: append-only audit for upload events. We log the saved file's
// basename (not full path — that leaks the absolute upload dir, which
// is implementation detail), original filename, and the mtime-derived
// saved name. We never log file content (binary, large, sensitive).
import { append as _eventsAppend } from "../lib/events.js";
import { basename } from "node:path";

export async function handleUpload(req, res, _ctx) {
  const ctype = (req.headers["content-type"] || "").toLowerCase();
  if (!ctype.startsWith("multipart/form-data")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "multipart required" }));
  }
  try {
    const saved = await saveMultipartUpload(req);
    // B01: record successful upload. We use basename(saved.path) — the
    // full path is implementation detail; the basename is enough to
    // identify the file. Size is unknown here (saveMultipartUpload
    // doesn't return it) — left null for a future patch to populate
    // once we add size to the helper.
    _eventsAppend("upload.create", {
      target: saved.name,
      cid: (_ctx && _ctx.cid) || "",
      actor: "user",
      payload: {
        path: basename(saved.path),
        originalName: saved.name,
      },
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({ ok: true, path: saved.path, name: saved.name }),
    );
  } catch (e) {
    // B01: record failed upload too — the failure pattern is useful
    // diagnostic (e.g. "user keeps sending corrupted multipart" surfaces
    // as a stream of upload.fail events).
    _eventsAppend("upload.fail", {
      cid: (_ctx && _ctx.cid) || "",
      actor: "user",
      payload: { error: e.message },
    });
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

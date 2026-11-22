#!/usr/bin/env node
/**
 * Send one JSON body to an OpenAI-Responses-style endpoint and measure the stream.
 *
 *   node scripts/responses-probe.mjs --url <url> --body '{"model":"…","input":"…","stream":true}'
 *                                   [--auth <bearer>] [--out file] [--timeout seconds]
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const url = args.get("url");
const body = args.get("body");
const auth = args.get("auth");
const out = args.get("out");
if (!url || !body) {
  console.error("usage: responses-probe.mjs --url <url> --body '<json>' [--auth <key>] [--out file]");
  process.exit(2);
}

const headers = { "content-type": "application/json", accept: "text/event-stream" };
if (auth) headers.authorization = `Bearer ${auth}`;
const secret = args.get("secret");
if (secret) {
  const ed = await import("@noble/ed25519");
  const { sha512 } = await import("@noble/hashes/sha512");
  ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));
  const u = new URL(url);
  const timestamp = Date.now();
  const canonical = `POST\n${u.pathname}${u.search}\n${timestamp}`;
  const key = Uint8Array.from(Buffer.from(secret, "base64"));
  headers["x-demo-key"] = Buffer.from(ed.getPublicKey(key)).toString("hex");
  headers["x-demo-timestamp"] = String(timestamp);
  headers["x-demo-signature"] = Buffer.from(ed.sign(new TextEncoder().encode(canonical), key)).toString("base64");
}

const started = Date.now();
const rec = { url, node_ttfb_ms: null, headers_ms: null, first_byte_ms: null, duration_ms: null, chunks: 0, bytes: 0, max_gap_ms: 0, status: null, saw_done: false, usage: null, tail: "", error: null };

try {
  const res = await fetch(url, { method: "POST", headers, body });
  rec.status = res.status;
  rec.headers_ms = Date.now() - started;
  rec.node_ttfb_ms = Number(res.headers.get("x-demo-node-ttfb-ms") ?? "NaN") || null;
  const reader = res.body.getReader();
  let last = Date.now();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = Date.now();
    if (rec.first_byte_ms === null) rec.first_byte_ms = now - started;
    rec.max_gap_ms = Math.max(rec.max_gap_ms, now - last);
    last = now;
    rec.chunks += 1;
    rec.bytes += value.byteLength;
    text += new TextDecoder().decode(value);
    if (text.length > 20000) text = text.slice(-20000);
  }
  rec.duration_ms = Date.now() - started;
  rec.saw_done = text.includes("[DONE]") || text.includes('"completed"');
  const usageMatch = text.match(/"usage"\s*:\s*\{[^}]*\}/g);
  rec.usage = usageMatch ? usageMatch[usageMatch.length - 1] : null;
  rec.tail = text.slice(-400);
  rec.event_types = [...new Set([...text.matchAll(/"type"\s*:\s*"([a-z_.]+)"/g)].map((m) => m[1]))].slice(0, 12);
} catch (err) {
  rec.error = String(err?.message ?? err);
  rec.duration_ms = Date.now() - started;
}
if (out) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(rec, null, 2) + "\n");
}
const { tail, ...brief } = rec;
console.log(JSON.stringify(brief, null, 2));
console.log("tail:", JSON.stringify(tail.slice(-220)));

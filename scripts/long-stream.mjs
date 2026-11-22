#!/usr/bin/env node
/**
 * Client-side measurement of one streamed response.
 *
 * Records what actually matters for the "can a long model turn survive on
 * Workers" question: time to headers, time to first byte, the largest gap
 * between two bytes, total duration, whether the tail (`usage`, `[DONE]`)
 * arrived, and whether the stream ended cleanly or was cut.
 *
 *   node scripts/long-stream.mjs --url 'https://…/v1/responses?ttft=120&tokens=240&interval=5' --out evidence/x.json
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const url = args.get("url");
if (!url) {
  console.error("usage: long-stream.mjs --url <url> [--out <file>] [--timeout <seconds>] [--label <name>]");
  process.exit(2);
}
const out = args.get("out");
const label = args.get("label") ?? "run";
const timeoutMs = Number(args.get("timeout") ?? 3600) * 1000;

const startedAt = Date.now();
const result = {
  label,
  url,
  started_at: new Date(startedAt).toISOString(),
  headers_ms: null,
  first_byte_ms: null,
  duration_ms: null,
  chunks: 0,
  bytes: 0,
  max_gap_ms: 0,
  gaps_over_15s: 0,
  tail: null,
  saw_done: false,
  saw_usage: false,
  outcome: "running",
  error: null,
  node_ttfb_ms: null,
  upstream_ttft_s: null,
};

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("client timeout")), timeoutMs);

try {
  const res = await fetch(url, { signal: controller.signal, headers: { accept: "text/event-stream" } });
  result.headers_ms = Date.now() - startedAt;
  result.status = res.status;
  result.node_ttfb_ms = Number(res.headers.get("x-demo-node-ttfb-ms") ?? "NaN") || null;
  result.upstream_ttft_s = Number(res.headers.get("x-demo-upstream-ttft-s") ?? "NaN") || null;
  result.content_type = res.headers.get("content-type");

  if (!res.body) throw new Error("no response body");
  const reader = res.body.getReader();
  let last = Date.now();
  let tail = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = Date.now();
    if (result.first_byte_ms === null) result.first_byte_ms = now - startedAt;
    const gap = now - last;
    if (gap > result.max_gap_ms) result.max_gap_ms = gap;
    if (gap > 15000) result.gaps_over_15s += 1;
    last = now;
    result.chunks += 1;
    result.bytes += value.byteLength;
    tail = (tail + new TextDecoder().decode(value)).slice(-4096);
  }
  result.duration_ms = Date.now() - startedAt;
  result.tail = tail.slice(-200);
  result.saw_done = tail.includes("[DONE]");
  result.saw_usage = tail.includes('"usage"');
  result.outcome = result.saw_done ? "complete" : "ended_without_done";
} catch (err) {
  result.duration_ms = Date.now() - startedAt;
  result.outcome = "error";
  result.error = String(err?.message ?? err);
  if (result.chunks > 0) result.outcome = "truncated_after_bytes";
} finally {
  clearTimeout(timer);
}

if (out) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2) + "\n");
}
console.log(JSON.stringify(result, null, 2));

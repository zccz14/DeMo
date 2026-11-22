#!/usr/bin/env node
/**
 * Fire N identical streamed requests at once and summarize what came back.
 *
 *   node scripts/concurrent.mjs --url '<url>' --n 25 --out evidence/conc.json
 *
 * Per request we keep: status, time to headers, time to first byte, duration,
 * chunk count, whether the tail frame arrived, and the error if any. The summary
 * is what decides how many concurrent long turns one node can hold.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const url = args.get("url");
const n = Number(args.get("n") ?? 10);
const out = args.get("out");
if (!url) {
  console.error("usage: concurrent.mjs --url <url> --n <count> [--out file]");
  process.exit(2);
}

async function one(index) {
  const t0 = Date.now();
  const rec = { index, headers_ms: null, first_byte_ms: null, duration_ms: null, chunks: 0, bytes: 0, status: null, saw_done: false, error: null };
  try {
    const res = await fetch(url, { headers: { accept: "text/event-stream" } });
    rec.status = res.status;
    rec.headers_ms = Date.now() - t0;
    if (!res.body) throw new Error("no body");
    const reader = res.body.getReader();
    let tail = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (rec.first_byte_ms === null) rec.first_byte_ms = Date.now() - t0;
      rec.chunks += 1;
      rec.bytes += value.byteLength;
      tail = (tail + new TextDecoder().decode(value)).slice(-2048);
    }
    rec.saw_done = tail.includes("[DONE]");
  } catch (err) {
    rec.error = String(err?.message ?? err);
  }
  rec.duration_ms = Date.now() - t0;
  return rec;
}

const started = Date.now();
const results = await Promise.all(Array.from({ length: n }, (_, i) => one(i)));
const wall = Date.now() - started;

const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const done = results.filter((r) => r.saw_done);
const tfbs = results.map((r) => r.first_byte_ms).filter((v) => v !== null);
const durs = done.map((r) => r.duration_ms);
const summary = {
  n,
  wall_ms: wall,
  ok: results.filter((r) => r.status === 200).length,
  completed: done.length,
  truncated: results.filter((r) => r.status === 200 && !r.saw_done).length,
  errored: results.filter((r) => r.error).length,
  statuses: [...new Set(results.map((r) => r.status))],
  ttfb_ms: { p50: pct(tfbs, 50), p95: pct(tfbs, 95), max: tfbs.length ? Math.max(...tfbs) : null },
  duration_ms: { p50: pct(durs, 50), p95: pct(durs, 95), max: durs.length ? Math.max(...durs) : null },
  chunks_total: results.reduce((a, r) => a + r.chunks, 0),
  errors: results.filter((r) => r.error).slice(0, 5),
  results,
};
if (out) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(summary, null, 2) + "\n");
}
const { results: _drop, ...brief } = summary;
console.log(JSON.stringify(brief, null, 2));

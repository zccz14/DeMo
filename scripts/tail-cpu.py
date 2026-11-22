#!/usr/bin/env python3
"""Summarize `wrangler tail --format json` output: per-request CPU and wall time.

wrangler pretty-prints each event, so events are concatenated JSON objects; we
decode them one after another instead of line by line.
"""
import json
import sys

def events(path):
    text = open(path, encoding="utf-8", errors="replace").read()
    dec = json.JSONDecoder()
    i, n = 0, len(text)
    while i < n:
        while i < n and text[i] in " \r\n\t":
            i += 1
        if i >= n:
            break
        try:
            obj, end = dec.raw_decode(text, i)
        except json.JSONDecodeError:
            break
        i = end
        if isinstance(obj, dict) and isinstance(obj.get("event"), dict):
            yield obj

rows = []
for trace in events(sys.argv[1]):
    ev = trace.get("event") or {}
    req = ev.get("request") or {}
    rows.append({
        "url": req.get("url", "")[-70:],
        "method": req.get("method"),
        "status": (ev.get("response") or {}).get("status"),
        "outcome": ev.get("outcome"),
        "cpu_ms": trace.get("cpuTime"),
        "wall_ms": trace.get("wallTime"),
    })

print(f"{'status':>6} {'cpu_ms':>7} {'wall_ms':>8}  {'outcome':<12} url")
for r in rows:
    print(f"{str(r['status']):>6} {str(r['cpu_ms']):>7} {str(r['wall_ms']):>8}  {str(r['outcome']):<12} {r['url']}")

cpus = [r["cpu_ms"] for r in rows if isinstance(r["cpu_ms"], (int, float))]
if cpus:
    cpus.sort()
    print(f"\nrequests={len(cpus)} cpu p50={cpus[len(cpus)//2]}ms max={cpus[-1]}ms sum={sum(cpus)}ms")

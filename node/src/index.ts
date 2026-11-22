/**
 * Demo node: the thinnest possible provider node.
 *
 * Deliberate design rules, because Workers bills CPU and caps it (Free 10ms):
 *
 *  1. The byte stream is never touched. `new Response(upstream.body)` hands the
 *     stream back to the platform, so CPU cost does not grow with the length of
 *     a response, only with the number of requests.
 *  2. No metering inside the stream. Usage is read from the tail frame by the
 *     client/registry, not counted here.
 *  3. No database, no queue, no Durable Object. Config and the identity key live
 *     in KV; the account layer is Ed25519, so there is nothing to look up per
 *     request beyond the config.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

ed.etc.sha512Sync = (...m: Uint8Array[]): Uint8Array => sha512(ed.etc.concatBytes(...m));

interface Env {
  DEMO_KV: KVNamespace;
}

interface NodeConfig {
  name: string;
  base_url: string;
  api_key: string;
  price_per_mtok_usd: number;
  created_at: string;
}

const KEY_CONFIG = "config";
const KEY_SECRET = "identity:secret";
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cdn-loop",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]);

const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromB64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const enc = new TextEncoder();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>DeMo node</title>
<style>body{font:14px/1.6 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#111}
code,pre{background:#f4f4f5;padding:.15rem .35rem;border-radius:4px}pre{padding:.75rem;overflow:auto}
label{display:block;margin:.75rem 0 .25rem;font-weight:600}input{width:100%;padding:.5rem;border:1px solid #d4d4d8;border-radius:6px}
button{margin-top:1rem;padding:.55rem 1rem;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}
.muted{color:#71717a}</style></head><body>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

async function loadConfig(env: Env): Promise<NodeConfig | null> {
  return (await env.DEMO_KV.get(KEY_CONFIG, "json")) as NodeConfig | null;
}

async function identity(env: Env): Promise<{ secret: Uint8Array; publicKey: Uint8Array }> {
  const stored = await env.DEMO_KV.get(KEY_SECRET);
  if (stored) {
    const secret = fromB64(stored);
    return { secret, publicKey: ed.getPublicKey(secret) };
  }
  const secret = ed.utils.randomPrivateKey();
  await env.DEMO_KV.put(KEY_SECRET, toB64(secret));
  return { secret, publicKey: ed.getPublicKey(secret) };
}

async function manifest(env: Env): Promise<Response> {
  const [cfg, id] = await Promise.all([loadConfig(env), identity(env)]);
  const canonical = JSON.stringify({
    name: cfg?.name ?? "unconfigured",
    base_url: cfg?.base_url ?? "",
    public_key: toHex(id.publicKey),
    price_per_mtok_usd: cfg?.price_per_mtok_usd ?? 0,
    issued_at: cfg?.created_at ?? new Date().toISOString(),
  });
  const signature = ed.sign(enc.encode(canonical), id.secret);
  return json({
    algorithm: "Ed25519",
    // Verify with: ed25519.verify(signature_b64, utf8(manifest_canonical), public_key_hex)
    manifest_canonical: canonical,
    manifest: JSON.parse(canonical) as unknown,
    public_key_hex: toHex(id.publicKey),
    signature_b64: toB64(signature),
    configured: cfg !== null,
  });
}

async function proxy(req: Request, env: Env, url: URL): Promise<Response> {
  const cfg = await loadConfig(env);
  if (!cfg) return json({ error: "node not configured", hint: "open /setup" }, 503);

  const target = `${cfg.base_url.replace(/\/+$/, "")}${url.pathname}${url.search}`;
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  if (cfg.api_key) headers.set("authorization", `Bearer ${cfg.api_key}`);

  const started = Date.now();
  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    init.duplex = "half";
  }
  const upstream = await fetch(target, init);
  const ttfb = Date.now() - started;

  const out = new Headers(upstream.headers);
  out.delete("transfer-encoding");
  out.set("cache-control", "no-store");
  out.set("x-demo-node-ttfb-ms", String(ttfb));

  // The only line that matters for long streams: the body is passed through
  // untouched, so per-byte CPU is zero and duration is unbounded by us.
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      const cfg = await loadConfig(env);
      return json({ ok: true, service: "demo-node", configured: cfg !== null, now: new Date().toISOString() });
    }





    if (url.pathname === "/manifest") return manifest(env);

    if (url.pathname === "/setup") {
      if (req.method === "GET") {
        const cfg = await loadConfig(env);
        return html(`
<h1>DeMo node 配置</h1>
<p class="muted">这是实验节点：把上游地址与 key 存在本 Worker 自己的 KV 里，不经过任何中心。</p>
<form method="post" action="/setup">
  <label>节点名</label><input name="name" value="${cfg?.name ?? "demo-node"}" required>
  <label>上游 base_url（OpenAI 兼容）</label><input name="base_url" value="${cfg?.base_url ?? "https://demo-upstream.zccz14.workers.dev"}" required>
  <label>上游 API key</label><input name="api_key" value="" autocomplete="off" placeholder="${cfg?.api_key ? "已配置，留空表示不修改" : "sk-..."}">
  <label>报价 USD / 1M tokens</label><input name="price_per_mtok_usd" value="${cfg?.price_per_mtok_usd ?? 0}" type="number" step="0.01">
  <button type="submit">保存</button>
</form>
<p class="muted">保存后 <a href="/manifest">/manifest</a> 会给出用该节点 Ed25519 私钥签名的声明。</p>`);
      }
      const form = await req.formData();
      const previous = await loadConfig(env);
      const submittedKey = String(form.get("api_key") ?? "").trim();
      const cfg: NodeConfig = {
        name: String(form.get("name") ?? "demo-node"),
        base_url: String(form.get("base_url") ?? ""),
        // 留空表示沿用已有 key：key 只进本 Worker 的 KV，不回显、不出现在 HTML 里。
        api_key: submittedKey || previous?.api_key || "",
        price_per_mtok_usd: Number(form.get("price_per_mtok_usd") ?? 0),
        created_at: new Date().toISOString(),
      };
      await env.DEMO_KV.put(KEY_CONFIG, JSON.stringify(cfg));
      return Response.redirect(new URL("/manifest", url).toString(), 303);
    }

    if (url.pathname === "/") {
      const [cfg, id] = await Promise.all([loadConfig(env), identity(env)]);
      return html(`
<h1>DeMo node</h1>
<p>身份（Ed25519 公钥）：<code>${toHex(id.publicKey)}</code></p>
<p>上游：<code>${cfg?.base_url || "未配置"}</code></p>
<p>报价：<code>$${cfg?.price_per_mtok_usd ?? 0} / 1M tokens</code></p>
<p><a href="/setup">配置</a> · <a href="/manifest">签名声明</a> · 代理入口：<code>/v1/*</code></p>`);
    }

    return proxy(req, env, url);
  },
};

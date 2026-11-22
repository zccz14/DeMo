/**
 * Demo node: the thinnest possible provider node.
 *
 * Design rules, because Workers bills CPU and caps it:
 *
 *  1. The byte stream is never touched (`new Response(upstream.body)`), so CPU
 *     does not grow with the length of a response, only with the request count.
 *  2. No metering inside the stream; usage comes from the tail frame.
 *  3. No database, no queue, no Durable Object: config, identity and the
 *     consumer allowlist live in KV.
 *
 * Access control is Ed25519 all the way down: a consumer signs
 * `METHOD \n path+query \n timestamp` with its own key, the node verifies it
 * against an allowlist of public keys. The upstream key never leaves the node,
 * and no shared secret is ever transmitted.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

ed.etc.sha512Sync = (...m: Uint8Array[]): Uint8Array => sha512(ed.etc.concatBytes(...m));

interface Env {
  DEMO_KV: KVNamespace;
  /** When set, /setup requires `?token=` to match. Keep it a secret, not a var. */
  SETUP_TOKEN?: string;
}

interface NodeConfig {
  name: string;
  base_url: string;
  api_key: string;
  price_per_mtok_usd: number;
  created_at: string;
  /** Hex Ed25519 public keys allowed to call /v1/*. Empty = nobody is checked. */
  consumers: string[];
}

const KEY_CONFIG = "config";
const KEY_SECRET = "identity:secret";
const SIGNATURE_WINDOW_MS = 60_000;
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

const enc = new TextEncoder();
const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromB64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
};

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
label{display:block;margin:.75rem 0 .25rem;font-weight:600}input,textarea{width:100%;padding:.5rem;border:1px solid #d4d4d8;border-radius:6px;font:inherit}
button{margin-top:1rem;padding:.55rem 1rem;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}
.muted{color:#71717a}</style></head><body>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

async function loadConfig(env: Env): Promise<NodeConfig | null> {
  const cfg = (await env.DEMO_KV.get(KEY_CONFIG, "json")) as NodeConfig | null;
  if (cfg && !Array.isArray(cfg.consumers)) cfg.consumers = [];
  return cfg;
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
    manifest_canonical: canonical,
    manifest: JSON.parse(canonical) as unknown,
    public_key_hex: toHex(id.publicKey),
    signature_b64: toB64(signature),
    configured: cfg !== null,
    consumers: cfg?.consumers ?? [],
  });
}

/**
 * Verify a consumer's signature. Returns null when the request may proceed.
 * The canonical string is `METHOD\npath+query\ntimestamp`; the body is not
 * signed so the request stream stays zero-copy.
 */
function checkConsumer(req: Request, url: URL, cfg: NodeConfig): Response | null {
  if (cfg.consumers.length === 0) return null; // open lab mode, documented as unsafe
  const pub = (req.headers.get("x-demo-key") ?? "").trim().toLowerCase();
  const signature = req.headers.get("x-demo-signature");
  const timestamp = Number(req.headers.get("x-demo-timestamp"));
  if (!pub || !signature || !Number.isFinite(timestamp)) {
    return json({ error: "missing consumer signature", hint: "x-demo-key / x-demo-timestamp / x-demo-signature" }, 401);
  }
  if (Math.abs(Date.now() - timestamp) > SIGNATURE_WINDOW_MS) return json({ error: "timestamp outside window" }, 401);
  if (!cfg.consumers.includes(pub)) return json({ error: "unknown consumer key" }, 403);
  const canonical = `${req.method}\n${url.pathname}${url.search}\n${timestamp}`;
  try {
    const valid = ed.verify(fromB64(signature), enc.encode(canonical), fromHex(pub));
    return valid ? null : json({ error: "bad signature" }, 401);
  } catch {
    return json({ error: "malformed signature" }, 400);
  }
}

async function proxy(req: Request, env: Env, url: URL): Promise<Response> {
  const cfg = await loadConfig(env);
  if (!cfg) return json({ error: "node not configured", hint: "open /setup" }, 503);

  const denied = checkConsumer(req, url, cfg);
  if (denied) return denied;

  const target = `${cfg.base_url.replace(/\/+$/, "")}${url.pathname}${url.search}`;
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower.startsWith("x-demo-")) return;
    headers.set(key, value);
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

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const setupAllowed = !env.SETUP_TOKEN || url.searchParams.get("token") === env.SETUP_TOKEN;

    if (url.pathname === "/health") {
      const cfg = await loadConfig(env);
      return json({
        ok: true,
        service: "demo-node",
        configured: cfg !== null,
        consumers: cfg?.consumers.length ?? 0,
        now: new Date().toISOString(),
      });
    }

    if (url.pathname === "/manifest") return manifest(env);

    if (url.pathname === "/setup") {
      if (!setupAllowed) return html("<h1>需要引导令牌</h1><p>访问 <code>/setup?token=…</code></p>", 401);
      const cfg = await loadConfig(env);
      if (req.method === "GET") {
        return html(`
<h1>DeMo node 配置</h1>
<p class="muted">上游 key 只进本 Worker 自己的 KV，不回显。</p>
<form method="post" action="/setup?token=${url.searchParams.get("token") ?? ""}">
  <label>节点名</label><input name="name" value="${cfg?.name ?? "demo-node"}" required>
  <label>上游 base_url（OpenAI 兼容，不带 /v1）</label><input name="base_url" value="${cfg?.base_url ?? ""}" required>
  <label>上游 API key</label><input name="api_key" value="" autocomplete="off" placeholder="${cfg?.api_key ? "已配置，留空表示不修改" : "sk-..."}">
  <label>报价 USD / 1M tokens</label><input name="price_per_mtok_usd" value="${cfg?.price_per_mtok_usd ?? 0}" type="number" step="0.01">
  <label>允许调用的消费者公钥（Ed25519 hex，一行一个；空 = 不校验，任何人都能调用）</label>
  <textarea name="consumers" rows="3" placeholder="9b549617…">${(cfg?.consumers ?? []).join("\n")}</textarea>
  <button type="submit">保存</button>
</form>
<p class="muted">保存后 <a href="/manifest">/manifest</a> 给出本节点 Ed25519 签名声明。</p>`);
      }
      const form = await req.formData();
      const previous = cfg;
      const submittedKey = String(form.get("api_key") ?? "").trim();
      const consumers = String(form.get("consumers") ?? "")
        .split(/[\s,]+/)
        .map((k) => k.trim().toLowerCase())
        .filter((k) => /^[0-9a-f]{64}$/.test(k));
      const next: NodeConfig = {
        name: String(form.get("name") ?? "demo-node"),
        base_url: String(form.get("base_url") ?? ""),
        api_key: submittedKey || previous?.api_key || "",
        price_per_mtok_usd: Number(form.get("price_per_mtok_usd") ?? 0),
        created_at: previous?.created_at ?? new Date().toISOString(),
        consumers,
      };
      await env.DEMO_KV.put(KEY_CONFIG, JSON.stringify(next));
      return Response.redirect(new URL(`/manifest`, url).toString(), 303);
    }

    if (url.pathname === "/") {
      const [cfg, id] = await Promise.all([loadConfig(env), identity(env)]);
      return html(`
<h1>DeMo node</h1>
<p>身份（Ed25519 公钥）：<code>${toHex(id.publicKey)}</code></p>
<p>上游：<code>${cfg?.base_url || "未配置"}</code></p>
<p>报价：<code>$${cfg?.price_per_mtok_usd ?? 0} / 1M tokens</code></p>
<p>允许的消费者：<code>${(cfg?.consumers ?? []).length}</code> 个公钥</p>
<p><a href="/setup">配置</a> · <a href="/manifest">签名声明</a> · 代理入口：<code>/v1/*</code></p>`);
    }

    return proxy(req, env, url);
  },
};

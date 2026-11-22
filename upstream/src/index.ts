/**
 * Demo upstream: a fake OpenAI-compatible SSE server.
 *
 * It exists only to make the client-side timing of a long model response
 * fully controllable, so the thin node in `node/` can be measured:
 *
 *   GET|POST /v1/responses?ttft=120&interval=5&tokens=240
 *     ttft      seconds of silence before the first byte (a long "thinking" turn)
 *     interval  seconds between tokens
 *     tokens    how many delta frames to emit
 *     fail_after  emit this many frames then break the stream mid-flight
 *
 * The last frame carries `usage`, exactly like the real ones do, so a node that
 * does not parse the stream can still learn the cost by reading the tail.
 */

type Cfg = {
  ttft: number;
  interval: number;
  tokens: number;
  inTokens: number;
  failAfter: number | null;
};

const enc = new TextEncoder();
const sse = (obj: unknown): Uint8Array => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseCfg(url: URL, body: Record<string, unknown> | null): Cfg {
  const q = url.searchParams;
  const pick = (name: string, fallback: number): number => num(q.get(name) ?? body?.[name], fallback);
  return {
    ttft: Math.max(0, pick("ttft", 0)),
    interval: Math.max(0, pick("interval", 1)),
    tokens: Math.max(1, Math.min(100000, pick("tokens", 5))),
    inTokens: Math.max(0, pick("in_tokens", 1000)),
    failAfter: q.get("fail_after") === null ? null : Math.max(0, pick("fail_after", 0)),
  };
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "demo-upstream", now: new Date().toISOString() });
    }

    if (url.pathname === "/echo") {
      const started = Date.now();
      const bytes = (await req.arrayBuffer()).byteLength;
      return json({ bytes, ms: Date.now() - started });
    }

    if (url.pathname === "/v1/responses" || url.pathname === "/v1/chat/completions") {
      let body: Record<string, unknown> | null = null;
      if (req.method === "POST") {
        try {
          body = (await req.clone().json()) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }
      const cfg = parseCfg(url, body);
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const startedAt = Date.now();
      void (async () => {
        try {
          if (cfg.ttft > 0) await sleep(cfg.ttft * 1000);
          await writer.write(sse({ type: "response.created", after_ms: Date.now() - startedAt }));
          for (let i = 0; i < cfg.tokens; i++) {
            if (cfg.failAfter !== null && i >= cfg.failAfter) throw new Error("simulated upstream failure");
            await writer.write(sse({ type: "response.output_text.delta", i, delta: `tok${i} ` }));
            if (i < cfg.tokens - 1) await sleep(cfg.interval * 1000);
          }
          await writer.write(
            sse({
              type: "response.completed",
              response: {
                usage: {
                  input_tokens: cfg.inTokens,
                  output_tokens: cfg.tokens,
                  total_tokens: cfg.inTokens + cfg.tokens,
                },
              },
            }),
          );
          await writer.write(enc.encode("data: [DONE]\n\n"));
        } catch (err) {
          try {
            await writer.write(sse({ type: "error", message: String(err) }));
          } catch {
            /* client already gone */
          }
        } finally {
          try {
            await writer.close();
          } catch {
            /* already closed */
          }
        }
      })();

      return new Response(readable, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "x-demo-upstream": "1",
          "x-demo-upstream-ttft-s": String(cfg.ttft),
        },
      });
    }

    return json({ error: "not found", path: url.pathname }, 404);
  },
};

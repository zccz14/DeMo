# DeMo — 去中心化模型网络的可行性实验

DeMo 的假设是：**账户就是一对 Ed25519 密钥，节点就是一台自带模型凭据的薄代理**。
本仓是这套假设在 Cloudflare Workers 上的最小可运行实验，目的是用实测回答三个问题：

1. **长流能不能活**：模型的一次思考可能几十秒到几分钟没有输出，一整轮可能跑 20 分钟以上。Workers 有 CPU 硬上限（Free 10ms、Paid 可配到 5 分钟），但没有总时长上限。到底哪条线先断？
2. **薄节点要多少 CPU**：如果节点只做零解析透传，CPU 是否与响应长度无关？
3. **用户能不能自己部署**：一个模板 Worker + 一次网页配置，够不够？

结论与原始数据见 [`docs/experiment.md`](docs/experiment.md)。

## 两个 Worker

| 目录 | 作用 |
|---|---|
| `upstream/` | **假上游**：可编程的 OpenAI 兼容 SSE 服务（`ttft` 首字节延迟、`interval` 帧间隔、`tokens` 帧数、`fail_after` 中途断裂），让"长流"变成可控实验，而不是靠真实上游碰运气 |
| `node/` | **薄节点**：零解析透传 `/v1/*`、`/setup` 网页配置、`/manifest` 用节点自己的 Ed25519 私钥签名的声明、`/__probe` 诊断 |

节点的三条纪律（写在 `node/src/index.ts` 顶部）：

1. 字节流不碰：`new Response(upstream.body)` 直接交还平台，CPU 不随流长增长；
2. 流里不做计量：用量由中心读尾部 `usage` 或事后对账；
3. 没有数据库、队列、Durable Object：配置与身份密钥都在 KV，账户层是 Ed25519，没有需要每请求查表的东西。

## 部署

```bash
pnpm install
pnpm wrangler kv namespace create DEMO_KV   # 把返回的 id 填进 node/wrangler.jsonc
pnpm deploy:upstream
pnpm deploy:node
```

然后打开 `https://<node>/setup`，填上游 base_url 与 key，`/manifest` 会给出签名声明。

## 已知坑

- **同账号两个 Worker 不能通过 `*.workers.dev` 互调**，会直接拿到 `error code: 1042`。
  本实验里上游因此挂了自定义域名 `demo-upstream.ntnl.io`。
  DeMo 的真实拓扑是「中心 → 别人账户的节点」，跨 zone，不受这条限制；但如果想在一个账户下代持多个节点，就必须用 Service Bindings 或各自独立域名。

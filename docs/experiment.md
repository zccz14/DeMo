# Cloudflare 上跑 DeMo 节点：可行性实测（2026-11-22）

## 环境与口径

- 两个 Worker 部署在 `zccz14` 账号：节点 `demo-node.zccz14.workers.dev`，假上游 `demo-upstream.ntnl.io`（自定义域名）。
- **账户实测为 Workers Paid**：能设置 `limits.cpu_ms = 50` 即证明（Free 会以 100328 拒绝，见 CTX 试点记录）。
  因此 **Free 的 10ms 硬限本轮没有实测**，下文一律标注 Paid 口径。
- CPU 与墙钟取自 `wrangler tail --format json` 的 `cpuTime` / `wallTime`（平台侧采样，整数毫秒），不是 Worker 自测计时器。
- 客户端是 MacMini（中国大陆，经代理出口），所以带宽类数字偏悲观。

## 一、长流能不能活：能

| 实验 | 参数 | 结果 |
|---|---|---|
| A 长 TTFT | 首字节静默 120s，2 帧 | 存活。首字节 121.4s，`usage` 与 `[DONE]` 都在，`outcome=complete` |
| B 20 分钟长流 | 240 帧 × 5s | 存活。1,201,382ms 完整结束，341 chunk，最大帧间 5.5s，>15s 空档 0 次 |
| C 上游中途断裂 | `fail_after=3` | 节点如实透传 `error` 帧，流正常收尾但缺 `[DONE]`，客户端可判别不完整 |
| D 1MB 请求体 | `POST /echo` | 200，1,048,576 字节，端到端 7.2s（含中国大陆上行） |

**结论**：Workers 没有总时长上限这条在长流上成立。**两分钟的零字节静默也活了下来**，
说明"模型思考很久才吐第一个字"不是平台限制问题；真正的断点会来自客户端或中间代理的超时，
所以节点侧 `: keepalive` 心跳是产品级必要项，而不是平台妥协。

## 二、薄节点的 CPU：与流长无关

同一个 20 分钟流的两个 Worker 对照：

| | CPU | 墙钟 | 说明 |
|---|---:|---:|---|
| `demo-node`（零解析透传） | **1ms** | 18ms | `new Response(upstream.body)` 直接交还平台 |
| `demo-upstream`（逐帧写 341 帧） | **31ms** | 1,199,995ms | 每帧约 0.09ms 的注水成本 |

其余请求的节点 CPU：长 TTFT 2ms、中途断裂 1ms；p50 = 1ms，max = 2ms。

**结论**：把字节流交给平台，节点 CPU 就是常数级（1–2ms/请求），与响应长度无关；
反过来，**任何"在流里做事"的设计都要付出与帧数成正比的 CPU**——这就是"计量不要放进流里"的量化依据。
按这个数，薄节点落在 Free 的 10ms 之内也成立（但需实测确认），而带逐帧工作的上游已经越过 10ms。

## 三、代理开销与部署现实

- 节点追加的 TTFB：`x-demo-node-ttfb-ms` 实测 12–45ms（同区 Worker 互调 12ms，跨 zone 38–45ms）。
- 部署摩擦：`wrangler deploy` 两次 + 一个 KV namespace + 打开 `/setup` 填两个字段。
  `/manifest` 直接给出用节点自己 Ed25519 私钥签名的声明，可离线验签。
- 1MB 请求体端到端 7.2s，其中绝大部分是中国大陆上行，不是节点开销。

## 四、踩到的坑（都是真的、都会影响 DeMo 拓扑）

1. **同账号两个 Worker 不能通过 `*.workers.dev` 互调**：直接返回 `error code: 1042`，
   页面是 "There is nothing here yet"，极容易被误判成"部署失败"。本实验因此给上游挂了自定义域名。
   DeMo 的真实拓扑是「中心 → 别人账户的节点」，跨 zone，不受此限；但若想在一个账户下代持多个节点，
   就必须用 Service Bindings 或各自独立域名。
2. **公网节点几分钟内就会被扫描**：挂上域名后立刻收到 `.env`、`.git/config`、`actuator/env`、
   `telescope/requests`、`console/` 之类探测。节点必须假设自己是公网可扫的。
3. **`waitUntil` 只延长约 30 秒**：长流结束后写收据不能依赖它，收据必须挪到流外（事前承诺或事后对账）。

## 五、还没测的

- Free 套餐下的同一条 20 分钟长流（本轮账户是 Paid）。
- N 路并发长流的 CPU 与内存分布（128MB 是每 isolate 而非每请求）。
- 中国大陆直连 Workers 边缘的延迟与稳定性（本轮走代理出口，数字不可用）。
- KV 每请求读的 p95（本实验每请求一次 `config` 读）。

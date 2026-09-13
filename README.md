# dsh-net-proxy

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

DeepSeek Harness 网络代理插件：让 **agent 自己发起的网络请求**（`web_search` / `web_fetch` / 外部 API）走你配置的 HTTP / HTTPS-CONNECT / SOCKS5 代理，配置持久化、启动即自动生效，并提供可视化设置页。

- 服务端双通道生效：包装 agent 进程的全局 `fetch`（手写转发，无第三方代理依赖），并把策略同步安装进 `web_fetch` 实际使用的 **harness 代理层**（见[下文](#web_fetch-与-harness-代理层v040)）。
- **请求日志（v0.5.0）**：经插件转发的每条请求（含 `web_fetch`）都记录在内存日志里——发送/返回内容预览、条数、上下行流量，设置页「请求日志」标签查看（见[下文](#请求日志与本地中继v050)）。
- 配置存储在 `$DSH_HOME/net-proxy.json`，设置页经同源路由 `/_dsh/net-proxy` 读写，改动即时生效、无需重启。
- `NO_PROXY` 默认排除本地回环。

## 安装

```bash
dsh plugin --profile web add github:mafeis/dsh-net-proxy
```

安装后重启 `dsh web`，在 设置 → 网络代理 里启用并填写代理地址（如 `127.0.0.1:7890`）。

也可手动在 profile 的 `cordis.patch.yml` 加入：

```yaml
- insert:
    - id: net-proxy
      name: 'dsh-net-proxy'
```

## 配置字段（net-proxy.json）

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 是否启用代理 |
| `followSystem` | `false` | 跟随系统代理（见下） |
| `protocol` | `http` | `http`（含 CONNECT 隧道）或 `socks5` |
| `host` / `port` | `127.0.0.1` / `7890` | 代理地址 |
| `username` / `password` | 空 | 可选认证 |
| `noProxy` | `["127.0.0.1","localhost","::1"]` | 命中则直连 |
| `logEnabled` | `true` | 请求日志开关（关闭后不再记录新条目） |
| `logPreviewBytes` | `512` | 每侧内容预览的最大字节数（0–8192，0 = 不记内容） |

## 跟随系统代理（v0.3.0）

开启 `followSystem` 后，插件每 3 秒读取操作系统的系统代理设置，自动启停、自动跟随端口变化（v2rayN / Clash 切换无需改配置）：

- **系统代理开** → 自动启用，地址/端口取自系统设置（凭据仍用手动配置的用户名/密码）；
- **系统代理关** → 自动直连（解决"代理工具没开但 DSH 还挂着代理"）；
- **`ProxyOverride`**（Windows 绕过列表）自动并入 `noProxy`（支持 `192.168.*`、`*.foo.com`、`<local>`）；
- 数据源：Windows 注册表 `Internet Settings`（v2rayN/Clash 均写此处）/ macOS `scutil --proxy` / Linux `HTTP(S)_PROXY`、`ALL_PROXY`；
- **PAC 模式**（AutoConfigURL）暂不支持自动跟随，回退手动配置并在设置页提示；
- 在设置页手动修改地址/端口/协议并保存时，跟随会自动关闭（避免手动值被轮询覆盖）。

## web_fetch 与 harness 代理层（v0.4.0）

DSH ≥ 0.1.5-rc.1 起，`web_fetch` 的出口不再经过 `globalThis.fetch`：它自带 undici 传输层，每个请求先询问 harness 的代理策略模块 `@deepseek-ai/dsh-http-proxy` 的 `proxyRouteFor()` 决定走向（[#5](https://github.com/mafeis/dsh-net-proxy/issues/5)）。仅包装全局 `fetch` 覆盖不到它。

v0.4.0 起，插件把生效代理**同时安装进 harness 代理层**：定位 harness 已加载的同一模块实例（桌面端经 `process.resourcesPath` 命中 `app.asar` 内实例；CLI 布局按 argv/bare 解析顺序回退），启用、停用、热更、跟随切换全同步；停用与卸载时还原到安装前状态，不污染启动器或其他插件的策略。

限制与说明：

- harness 代理层只接受 `http://` 代理 URL（`dsh-http-proxy` 的硬性约束）。协议选 `socks5` 时该层不安装（`web_fetch` 保持直连），fetch 包装层不受影响——Clash/v2rayN 的 mixed 端口同时提供 HTTP，把协议切到 HTTP 即可覆盖 `web_fetch`。
- 两层互不替代：fetch 包装层覆盖所有直接调用 `globalThis.fetch` 的代码，harness 层覆盖 `web_fetch`。
- harness 层异常时设置页显示一行警告（自检未通过 / SOCKS 不适用 / 解析失败原因），如实展示、不假装生效；正常态不占版面，完整状态在 `GET /_dsh/net-proxy` 响应的 `harness` 字段。

## 请求日志与本地中继（v0.5.0）

**干了什么**：设置页新增「请求日志」标签——经插件代理的每条请求一条记录：方法、URL、状态码、耗时、上下行字节数，点开可看发送/返回内容预览；顶部汇总总条数、总流量、错误数。`web_fetch` 的流量从此也可见、可统计。

**怎么做的**：

- 插件在本地回环起一个中继代理（`127.0.0.1` 随机端口），harness 代理层改为指向中继——`web_fetch` 的每条请求都过插件之手。中继把流量桥接到真正的上游代理（HTTP 或 SOCKS5），因此 **`web_fetch` 不再受 SOCKS5 限制**，`socks5` 配置现在两层全覆盖。
- 两条记录路径：fetch 包装层（agent 直接调用的 `fetch`）记录完整明文请求/响应与体预览；中继层对 `CONNECT` 隧道记录目标与双向字节（TLS 内容加密不可见，如实标注），明文 http 记录完整内容。
- 全部内存环形缓冲（最近 500 条），**不落盘、不外发**；预览长度 `logPreviewBytes` 可配（0–8192 字节，0 关闭预览），`logEnabled` 可整体关闭记录。
- **资源占用有硬上限**：条目满 500 条自动淘汰最旧的（默认配置总占用 < 1MB，最大预览配置 < 5MB）；进行中记录超 2000 条自动熔断（防挂死连接积累，转发不受影响）；中继转发的请求体缓冲上限 1MB。
- 字节口径为真实网络字节数；HTTP/2 的头为 HPACK 估算值（约 32 字节/头 + 字段长度），主体字节数精确。

**有什么效果**：不装抓包工具就能看到 agent 发了什么、收了什么、用了多少流量；配合跟随系统代理，代理切到哪日志就记到哪。

## 流量图表（v0.6.0）

**干了什么**：设置页新增「流量图表」标签——把请求日志聚合成五张图：请求时间线（按时间分桶，错误段红色标出）、状态分布（2xx/3xx/4xx/5xx/连接错误/进行中堆叠条）、耗时分布（五档直方图 + 平均/中位）、通道分布（agent fetch / CONNECT 隧道 / relay 明文）、目标主机 TOP 8（按请求数排序，条长按占比、有错误记录的主机标红）。每 5 秒自动刷新。

**怎么做的**：

- 数据源就是请求日志的同一份内存环形缓冲（`GET /_dsh/net-proxy/log`，最多 500 条），**不新增任何存储**；清空日志图表同步归零。
- 聚合在前端完成（时间分桶、主机/状态/耗时/通道分组均为纯函数，有独立单测），服务端零改动、零开销。
- 图表全部自绘 SVG / HTML 条图，不引入任何图表库；配色沿用设置页既有语义色（成功绿、警告黄、错误红）。

**有什么效果**：一眼看清流量的时间分布、都连了哪些主机、成功率与耗时水位，不用逐条翻日志。

## 许可证

MIT

## 变更记录

### v0.6.2
- **地址过滤**：请求日志新增过滤框——按 URL / 主机 / 方法关键词实时筛选（客户端侧过滤，不增加服务端开销）。
- **消除双滚动条**：日志列表与展开的预览不再内部滚动（与宿主页面滚动叠加），列表先显示 80 条、按需「显示更早日志」加载全部；图表页垂直间距整体压紧一档。
- **修复中继徽标显示 `:null`**：本地中继未运行（代理停用 / 回退直装）时改显「未运行」状态，不再渲染空端口。

### v0.6.1
- **流量图表视觉重制**：时间线改为渐变面积图（网格线 / max 标注 / 错误红点 / 悬浮热区），耗时直方图渐变柱 + 数值标签，状态分布光泽堆叠条 + 百分比图例，横条渐变填充 + mono 主机名，统计卡彩色缘条 + 大号数字；卡片渐变底色与 hover 高亮，配色仍全部走宿主主题变量。

### v0.6.0
- **新功能：流量图表**——设置页新增「流量图表」标签，把请求日志实时聚合为时间线 / 状态分布 / 耗时分布 / 通道分布 / 主机 TOP 8 五张自绘图表，5 秒刷新；详见上文[「流量图表」](#流量图表v060)一节。聚合逻辑为纯函数并新增 6 项单测。
- **二进制内容嗅探**：请求/响应体为图片、压缩包、PDF 等二进制时，预览只存占位符（类型 + 原始大小，如 `‹PNG 5.2MB，不存内容›`）——不存乱码、不复制大块内存；纯文本预览不受影响（新增测试）。
- **修复中继明文转发在客户端提前断开时的泄漏**：此前 `writeChunk` 等待背压排空会永久挂起（上游连接与日志记录双双泄漏）；现客户端断开立即销毁上游并收尾（新增回归测试）。
- 超长 URL 截断至 2048 字符（防巨型 query 撑大条目）；合计 107 项测试全绿。

### v0.5.1
- **资源占用加固**：日志内存全部有硬上限——环形条目 500 条自动淘汰（< 1MB，最大预览配置 < 5MB）；进行中记录超 2000 条熔断（防挂死连接无限积累，超限期间只停记录不停转发）；中继请求体缓冲 32MB → 1MB。`GET /log` 的 summary 新增 `live` 字段。

### v0.5.0
- **新功能：请求日志**——详见上文[「请求日志与本地中继」](#请求日志与本地中继v050)一节：内存环形日志（条数/流量/预览）+ 设置页「请求日志」标签 + `/_dsh/net-proxy/log` 同源路由（Host 校验/自定义头/同源校验与设置路由同规则）。
- **`web_fetch` 的 SOCKS5 限制解除**：harness 层改经本地回环中继桥接，`socks5` 配置现在 fetch 包装层与 `web_fetch` 全覆盖；真代理变化由中继实时读取，不再触发 harness 层重装卸载。
- 新增配置字段 `logEnabled`（默认开）/ `logPreviewBytes`（默认 512，0–8192）；协议栈与中继全路径接入日志埋点（每个流只 finalize 一次）。
- 新增 16 项测试（日志器单测、真实 CONNECT+TLS 插桩端到端、中继桥接/半关闭/停用 507/stop 生命周期、日志路由安全），合计 96 项全绿。

### v0.4.0
- **修复（[#5](https://github.com/mafeis/dsh-net-proxy/issues/5)）：`web_fetch` 现在真正走代理**——把生效策略同步装进 harness 代理层，详见上文[「web_fetch 与 harness 代理层」](#web_fetch-与-harness-代理层v040)一节。
- 设置页仅在 harness 层异常时显示警告行；`GET /_dsh/net-proxy` 响应新增 `harness` 字段（`mode` / `via` / `proxy` / `verified`）。
- `@deepseek-ai/dsh-http-proxy` 声明为可选 peerDependency；新增 12 项测试（含对真实 `dsh-http-proxy` 的「安装→路由可见→还原」端到端验证），合计 80 项全绿。

### v0.3.0
- **新功能：跟随系统代理**（[#4](https://github.com/mafeis/dsh-net-proxy/issues/4)）：新增 `followSystem` 配置与设置页开关，自动跟随系统代理的开关与端口变化，系统关闭时自动直连——详见上文[「跟随系统代理」](#跟随系统代理v030)一节。
- 附带 v0.2.7 的全部安全与健壮性修复（见下方 v0.2.7 条目）；新增 14 项测试，合计 68 项全绿。

### v0.2.7
- **安全（设置路由）**：
  - `/_dsh/net-proxy` 增加 Host 白名单校验（回环 + 本机网卡地址，防 DNS rebinding）、POST 必需自定义头 `X-DSH-Net-Proxy: 1`（跨站「简单请求」无法携带，阻断 CSRF 改写代理配置）、带 Origin 时要求与 Host 同源；
  - `action:"probe"` 不再把已保存的代理凭据回填给任意第三方代理（仅当探测目标与当前配置为同一 host+port+protocol 时才回填），防止凭据外泄；probe 的密码 `***` 打码哨兵与写路径同规则还原（修复「测试连接」对有密码代理必失败）。
- **协议栈健壮性**：
  - HTTP CONNECT / SOCKS5 握手阶段（TCP 连上之后）接入 `timeoutMs` 超时与 AbortSignal——此前半开代理可让 fetch 无限挂死且不可取消；
  - TLS 握手同样接入 abort。
- **响应体生命周期**：
  - HTTP/1.1 与 HTTP/2 的 body 读取期间 abort 现在立即生效（以 `AbortError` 拒绝），`resp.body.cancel()` 立即销毁 socket / 关闭 Http2Session（修复 SSE/大 body 场景的连接与 session 泄漏，含重定向跟随时的内部 cancel）；
  - 声明了 `Content-Length` 却提前断流的响应改为报 `ERESP_END`，不再静默当作完整 body。
- **fetch 契约**：`proxiedFetch(Request)` 现继承 Request 的 `method/headers/body/signal`（此前只继承 method，整个 agent 进程的 `fetch(new Request(...))` 都在静默丢 header/body）。
- **noProxy**：修复前导点条目（`.example.com`）永不匹配的问题——现等价于 `example.com`（本域 + 全部子域）。
- **工程**：
  - 配置热改用 watch 父目录实现（原 watch 文件在 tmp+rename 原子写后失效，外部编辑器保存一次热更即静默失联）；
  - `refreshProxy` 只在 wrap 状态翻转时才赋值 `globalThis.fetch`，卸载时校验仍是自己装的包装器才还原——不再踩掉/误拆其他插件的后装 fetch 包装；
  - `toCfg` 写入前校验 `port`（1–65535）与 `protocol`（http/socks5/socks），脏配置 400 拒收不再落盘；
  - 日志分级：常规信息走 `logger.info`，仅异常走 `logger.error`。
- **测试**：新增 `tests/hardening.test.mjs` 16 项（路由安全校验、probe 哨兵、noProxy 前导点、握手超时/中止、body abort/cancel、CL 截断、Request 入参），合计 54 项全绿。

### v0.2.6
- **兼容性修复**：`peerDependencies` 改为与 harness 实际版本匹配的显式范围——`@deepseek-ai/schemastery` 实为 3.x 线（原 `<0.2.0` 上限完全错位，改 `^3.18.1`）；`@deepseek-ai/dsh-client-ui-primitives` 按预发布规则补显式分支（`^0.1.0-rc.6 || ^0.1.1-rc.1`），消除安装期 ERESOLVE/兼容告警。
- **协议栈加固**：
  - `proxiedOnce`：socks5 + 明文 http 目标此前完全未走 SOCKS 隧道（裸发 HTTP 到 SOCKS 端口），已修复（隧道 + origin-form）；
  - `httpConnect`：读完状态行即 detach 会把分包到达的代理响应头漏进 TLS 流，现消费至空行（带行数上限）；
  - 流式请求体改用 `Transfer-Encoding: chunked`（RFC 7230：请求体不能以连接关闭定界，原实现必 400）；
  - SOCKS5 CONNECT：IPv4 字面量改用 ATYP=0x01 二进制；
  - `connectProxy`/TLS 握手/HTTP/2 全链路接入超时（默认 60s，防 TCP 黑洞挂死）。
- **输入健壮性**：`proxiedFetch` 支持 URL 实例入参（原抛 Invalid URL）；body 支持 URLSearchParams/Blob/TypedArray，Node 流走 chunked，`ReadableStream` 等不支持类型明确报 `EBODY`；noProxy 修复 IPv6 回环（`[::1]` 带括号不匹配、`::1` 条目被 `:\d+$` 误拆为 host:port）。
- **安全**：设置路由 GET 回传密码打码（`***`），POST 收到 `***` 保留原值；POST 体积上限 64KB；跨源重定向剥 `Authorization`（对齐标准 fetch）。
- **工程**：服务端日志接入 `ctx.logger`（无则退回 console）；probe 支持自定义 target（`action:"probe"` 新增 `target` 字段）；`package.json` 补 `engines.node >=18`。
- **测试**：新增 HTTPS CONNECT（自签证书真实 TLS）与 SOCKS5（无认证/RFC1929 正误认证）端到端、CONNECT 分包响应头残留回归、noProxy IPv6 回归、入参/body 类型共 7 个测试文件，合计 35 项全绿。

### v0.2.5
- `index.js` 的设置路由 handler 抽到 `lib/routes.js`（纯函数，新增 4 项单测，共 24 项全绿）。
- `client.js` 拆组件：把 `NetProxySection` 的巨型 return 拆为 `Header`/`StatusBadge`/`StatusToggle`/`ProbeResult` 纯展示子组件（渲染等价、不动 UMD 结构）。
- 新增 eslint 门禁（`eslint.config.js` + `npm run lint`，接入 CI；`--legacy-peer-deps` 适配私有 `@deepseek-ai/*` peer）；加 `.gitignore`。

### v0.2.4
- 继续工程化拆分：`proxy-fetch.js` 拆为 `lib/proxy/{conn,http11,http2,request}.js`（连接/隧道与 ByteStream、HTTP/1.1 请求、HTTP/2 请求、入口与协议分发），`proxy-fetch.js` 变为纯 re-export 聚合入口；行为不变，20/20 全绿。

### v0.2.3
- 抽取 `lib/proxy/body.js` 的公共响应体解码 sink（`makeBodyController`），去重 HTTP/1.1 与 HTTP/2 的「按编码建解码器 → dec data/end/error → 收尾」逻辑；行为不变，新增 3 项单测（共 20 项全绿）。

### v0.2.1
- `ByteStream` 分帧读取加固（修复 SOCKS5 CONNECT 头+BND 同帧时 BND 被吞的 bug），新增 `bytes`/`config` 单元测试（共 17 项全绿）。
- `lib/config.js` 拆为纯配置函数（无 schemastery 依赖，可在无 peer 的本地直接测试）；`Config` schema 移回 `index.js`。

### v0.2.0
- 工程化重构：`proxy-fetch.js` 拆分叶子模块 `lib/proxy/{errors,no-proxy,parse}.js`；删除死代码（顶层 `readExactly`/`readHead`）；抽取 `createDecoder` 消除 HTTP/1.1 与 HTTP/2 解压重复；新增 `@typedef NetProxyConfig` 类型契约；修复 probe CLI 的 `--proxy http://...` 解析。
- 新增 CI（GitHub Actions）与单元测试覆盖（HTTP/SOCKS5 真实连通验证）。

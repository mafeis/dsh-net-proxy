# dsh-net-proxy

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

DeepSeek Harness 网络代理插件：让 **agent 自己发起的网络请求**（`web_search` / `web_fetch` / 外部 API）走你配置的 HTTP / HTTPS-CONNECT / SOCKS5 代理，配置持久化、启动即自动生效，并提供可视化设置页。

- 服务端双通道生效：包装 agent 进程的全局 `fetch`（手写转发，无第三方代理依赖），并把策略同步安装进 `web_fetch` 实际使用的 **harness 代理层**（见[下文](#web_fetch-与-harness-代理层v040)）。
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

## 许可证

MIT

## 变更记录

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

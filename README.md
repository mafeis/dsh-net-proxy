# dsh-net-proxy

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

DeepSeek Harness 网络代理插件：让 **agent 自己发起的网络请求**（`web_search` / `web_fetch` / 外部 API）走你配置的 HTTP / HTTPS-CONNECT / SOCKS5 代理，配置持久化、启动即自动生效，并提供可视化设置页。

## 安装

```bash
dsh plugin --profile web add dsh-net-proxy
```

安装后重启 `dsh web`，在 设置 → 网络代理 里启用并填写代理地址（如 `127.0.0.1:7890`）。

或从 GitHub 直装（始终取最新 `main`，未经 npm 版本校验）：

```bash
dsh plugin --profile web add github:mafeis/dsh-net-proxy
```

也可手动在 profile 的 `cordis.patch.yml` 加入：

```yaml
- insert:
    - id: net-proxy
      name: 'dsh-net-proxy'
```

## 兼容的 DSH 版本

| DSH 运行时 | 状态 |
|---|---|
| 0.1 线（如 0.1.7-rc.2） | 兼容 |
| 0.2 线（0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.x） | 兼容（0.8.0 起） |

## 主要功能

**双通道代理生效**：包装 agent 进程的全局 `fetch`（手写 HTTP/SOCKS5 转发，零运行时依赖），同时把生效策略同步安装进 `web_fetch` 实际使用的 harness 代理层——两类请求全覆盖，停用/卸载完整还原。

**跟随系统代理**：每 3 秒读取系统代理设置，自动启停、自动跟随端口变化（v2rayN / Clash 切换无需改配置）；系统关闭时回退手填地址；Windows `ProxyOverride` 绕过列表自动并入 `NO_PROXY`。

**请求日志**：经插件代理的每条请求一条记录——方法、URL、状态码、耗时、上下行流量、发送/返回内容预览；全部内存环形缓冲（最近 500 条），不落盘、不外发，占用有硬上限（< 1MB，可熔断）。

**本地中继**：`web_fetch` 流量经本地回环中继过插件之手——可观测、可统计，同时解除 harness 层的 SOCKS5 限制（`socks5` 配置现在全覆盖）。中继端口在插件进程内终身不变，第三方单例代理组件的地址引用不会过期；中继意外停止时 5 秒内自动重装策略。

**流量图表**：请求日志实时聚合为时间线 / 状态分布 / 耗时分布 / 通道分布 / 目标主机 TOP 10 五张自绘图表，前端纯函数聚合、零新增存储、5 秒刷新。

**JSON 详情**：日志条目展开关键信息，「详情」弹窗内查看完整请求/响应内容；JSON 体自动渲染为可折叠树视图，完整内容按需加载（单条 ≤256KB / 总池 ≤4MB 硬上限）。

**设置页**：一级菜单 + 页内二级标签（代理设置 / 请求日志 / 流量图表），连通性探测、地址过滤、渐进加载；配色全部走宿主主题变量，视觉与宿主一致。

### 不代理的范围

**Desktop 侧边栏浏览器**：右侧「浏览器」页面由 Electron `<webview>` guest 实现，代理策略在 Electron 主进程的 session 上，而插件宿主是主进程拉起的子 Node 进程、够不到 session——**在插件里做的任何配置（启停、改端口、改协议）对侧边栏都不生效**，其流量不经过插件，**请求日志里也不会有它的记录**。侧边栏始终跟随 Windows 系统代理（Chromium 默认行为）：跟随系统时两者出口一致；插件配置偏离系统代理时，侧边栏仍按系统代理走。属 DSH 架构限制，需主进程侧桥接（[#6](https://github.com/mafeis/dsh-net-proxy/issues/6)），`lib/desktop-session.js` 已保留为就绪桩，未来宿主在主进程内加载插件时自动激活。

**TLS 隧道内容**：隧道内加密不可见，只记目标与字节数。

## 配置字段（net-proxy.json）

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 是否启用代理 |
| `followSystem` | `false` | 跟随系统代理 |
| `protocol` | `http` | `http`（含 CONNECT 隧道）或 `socks5` |
| `host` / `port` | `127.0.0.1` / `7890` | 代理地址 |
| `timeout` | `60000` | 插件 fetch 转发的超时，单位毫秒，整数 1–2147483647；设置页以秒编辑 |
| `username` / `password` | 空 | 可选认证 |
| `noProxy` | `["127.0.0.1","localhost","::1"]` | 命中则直连 |
| `logEnabled` | `true` | 请求日志开关（关闭后不再记录新条目） |
| `logPreviewBytes` | `512` | 每侧内容预览的最大字节数（0–8192，0 = 不记内容） |

## 技术说明

- **harness 代理层**：DSH ≥ 0.1.5-rc.1 起 `web_fetch` 的出口不经过 `globalThis.fetch`，由 harness 的代理策略模块 `@deepseek-ai/dsh-http-proxy` 决定走向（[#5](https://github.com/mafeis/dsh-net-proxy/issues/5)）。插件定位 harness 已加载的同一模块实例（桌面端命中 `app.asar` 内实例，CLI 布局按 argv/bare 顺序回退）同步安装策略，停用与卸载还原到安装前状态。
- **协议限制**：harness 代理层只接受 `http://` 代理 URL。协议选 `socks5` 时由本地中继桥接，`socks5` 两层全覆盖；PAC 模式暂不支持自动跟随，回退手动配置并提示。
- **隐私边界**：日志与完整内容只存内存、不落盘、不外发；TLS 隧道内容不可见；二进制内容不存（只记类型与大小）；清空日志即彻底消失。
- **零运行时依赖**：代理栈、中继、日志、图表全部 Node 原生模块 + 自绘实现。
- **宿主兼容自检**：`node tools/dsh-compat-probe.mjs <含 node_modules/@deepseek-ai 的目录>`（通常是 `~/.dsh/profiles`）用真实 cordis + `dsh-host-webserver` 挂载本插件，再直接请求 `/_dsh/net-proxy` 与 `/_dsh/net-proxy/log`，打出激活期与请求期的每条错误。排查「换了 DSH 版本后插件还灵不灵」时先跑它；退出码非 0 即存在硬错误。

## 许可证

MIT

变更历史见 [GitHub Releases](https://github.com/mafeis/dsh-net-proxy/releases)。

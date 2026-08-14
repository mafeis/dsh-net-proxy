# dsh-net-proxy

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

DeepSeek Harness 网络代理插件：让 **agent 自己发起的网络请求**（`web_search` / `web_fetch` / 外部 API）走你配置的 HTTP / HTTPS-CONNECT / SOCKS5 代理，配置持久化、启动即自动生效，并提供可视化设置页。

- 服务端：包装 agent 进程的全局 `fetch`，让所有请求走代理（手写转发，无第三方代理依赖）。
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
| `protocol` | `http` | `http`（含 CONNECT 隧道）或 `socks5` |
| `host` / `port` | `127.0.0.1` / `7890` | 代理地址 |
| `username` / `password` | 空 | 可选认证 |
| `noProxy` | `["127.0.0.1","localhost","::1"]` | 命中则直连 |

## 许可证

MIT

## 变更记录

### v0.2.3
- 抽取 `lib/proxy/body.js` 的公共响应体解码 sink（`makeBodyController`），去重 HTTP/1.1 与 HTTP/2 的「按编码建解码器 → dec data/end/error → 收尾」逻辑；行为不变，新增 3 项单测（共 20 项全绿）。

### v0.2.1
- `ByteStream` 分帧读取加固（修复 SOCKS5 CONNECT 头+BND 同帧时 BND 被吞的 bug），新增 `bytes`/`config` 单元测试（共 17 项全绿）。
- `lib/config.js` 拆为纯配置函数（无 schemastery 依赖，可在无 peer 的本地直接测试）；`Config` schema 移回 `index.js`。

### v0.2.0
- 工程化重构：`proxy-fetch.js` 拆分叶子模块 `lib/proxy/{errors,no-proxy,parse}.js`；删除死代码（顶层 `readExactly`/`readHead`）；抽取 `createDecoder` 消除 HTTP/1.1 与 HTTP/2 解压重复；新增 `@typedef NetProxyConfig` 类型契约；修复 probe CLI 的 `--proxy http://...` 解析。
- 新增 CI（GitHub Actions）与单元测试覆盖（HTTP/SOCKS5 真实连通验证）。

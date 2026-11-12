# PROGRESS

最后更新：2026-11-12 · 当前状态：已部署上线，公网可用 · 下一步：配客户端 / 视情况加引擎 key

## 线上环境

| 项 | 值 |
|---|---|
| 服务器 | `109.66.112.52:40032`（恒创香港 2C4G，Debian 12，Node 24.22） |
| 目录 | `/root/free-search-mcp` |
| 地址 | `https://freesearch.259952.xyz/mcp` |
| 监听 | `127.0.0.1:8787`，Caddy 反代（CF 灰云 A 记录） |
| 服务 | `systemctl status free-search-mcp`，`.env` mode 600 |

## 目标

把 Cindy 的 free-search 插件引擎做成可远程部署的 MCP 服务（方案 A：自己加 HTTP 入口）。

## 结构

- `core.mjs`：JSON-RPC 主体 + worker 进程管理，两入口共用；worker 模块级共享，会话状态用 `createSession()`
- `mcp-server.mjs`：stdio 入口（本地宿主）
- `http-server.mjs`：Streamable HTTP 入口（远程）
- `node/`：引擎，从 `../free-search/` 原样复制，**git 外的唯一上游**，升级时重新复制
- `ghost.json`：工具清单来源，`core.mjs` 读它生成 MCP tools

## 已做

- POST /mcp 收发 JSON-RPC；GET /mcp 405；DELETE /mcp 结束会话；GET /health 探活
- Bearer token 常量时间比较；无 token 拒绝启动（`FREE_SEARCH_ALLOW_ANONYMOUS=1` 可关）
- 并发闸门 4 + 队列 16，满了 429
- 空闲会话 1h 回收
- `test/http.test.mjs` 8 项：鉴权、会话、tools/list、通知 202、ping、DELETE
- 实测：HTTP 侧 `weather` / `web_search` 均返回正常结果，与 stdio 版输出一致

## 待办

- 用户按需配客户端（Cursor / Cline / Cindy 填 URL + Bearer；Claude Desktop 走 mcp-remote）
- 视限流情况配 key 引擎（exa / tavily）。目前 exa 无 key 也能返回结果
- 未做：多副本、CORS、服务端 SSE 推送

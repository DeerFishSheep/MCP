# PROGRESS

最后更新：2026-11-12 · 当前状态：HTTP 版已在本机跑通，未部署 · 下一步：等用户指定服务器，按 README「部署」四步上线

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

- 服务器选定后部署（`deploy/free-search-mcp.service` + Caddy 自动 HTTPS）
- 配至少一个 key 引擎（exa/tavily），否则机房 IP 抓 bing/ddg 会被限流

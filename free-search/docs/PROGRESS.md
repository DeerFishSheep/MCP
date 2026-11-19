# PROGRESS

最后更新：2026-11-20 · 当前状态：已上线；本次加多 key 轮换 + 配 key 引擎并行合并（待部署） · 下一步：weather 的 open-meteo 出口连不通，待换源

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
- 2026-11-18 过期/未知 `mcp-session-id` 不再回 404：改用常驻兜底会话执行并回带新 id。dsh-go 0.2.x 收到 404 不会重新 initialize，会永久卡死（现象：空闲 1h 后 tools/call 一直 `-32000 unknown or expired session`，重启引擎才恢复）

## 2026-11-20 多 key / 多引擎并行

- 新增 `node/lib/key_pool.js`：同一引擎多把 key（逗号/分号/换行分隔），按 key 独立冷却与轮转；`keys/list` 只回尾 4 位 + 数量
- 新增 `node/lib/multi_merge.js`：并行结果按归一化 URL 去重、域名轮转排序，记录 `corroboration`（几个引擎同时给出）
- `worker.cjs`：`searchChain` 拆成「单引擎显式点名」与「多引擎并行 + 不足补跑」两条；重试时换 key
- 新环境变量：`FREE_SEARCH_MULTI_ENGINE` / `ENGINE_FANOUT` / `MIN_SOURCES` / `KEY_COOLDOWN_MS`
- 单测 `test/key_pool.test.mjs`、`test/multi_merge.test.mjs`（10 项全过）；本地 HTTP 冒烟通过
- 未部署到线上

## 待办

- 用户按需配客户端（Cursor / Cline / Cindy 填 URL + Bearer；Claude Desktop 走 mcp-remote）
- 视限流情况配 key 引擎（exa / tavily）。目前 exa 无 key 也能返回结果
- 未做：多副本、CORS、服务端 SSE 推送

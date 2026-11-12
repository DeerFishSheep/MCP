# free-search MCP

把 Cindy 的「免费联网搜索」插件引擎，包装成一个可以部署到服务器、被任何 MCP 客户端连的远程搜索服务。

引擎本身（`node/`）是原样复制过来的，没有改动。本目录只加了传输层。

## 文件

| 文件 | 作用 |
|---|---|
| `core.mjs` | JSON-RPC 主体、worker 进程管理（从原 `mcp-server.mjs` 抽出，两入口共用） |
| `mcp-server.mjs` | stdio 入口，本地宿主用 |
| `http-server.mjs` | Streamable HTTP 入口，远程用 |
| `node/` | 搜索引擎引擎（原样） |
| `ghost.json` | 工具清单来源，`core.mjs` 读它的 `tools` 生成 MCP tool 列表 |
| `test/http.test.mjs` | 传输层自检 |

## 本地跑（stdio）

```bash
node mcp-server.mjs
```

宿主里配置：命令 `node`，参数 `/绝对路径/mcp-server.mjs`。

## 服务器跑（HTTP）

```bash
export FREE_SEARCH_TOKEN=$(openssl rand -hex 24)   # 不给 token 就拒绝启动
export FREE_SEARCH_PORT=8787
node http-server.mjs
```

端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/mcp` | JSON-RPC 收发，需 `Authorization: Bearer <token>` |
| DELETE | `/mcp` | 结束会话 |
| GET | `/mcp` | 405（本服务不主动推送） |
| GET | `/health` | 探活，无需鉴权 |

客户端要先用 `initialize` 拿到 `Mcp-Session-Id`，后续请求带上。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `FREE_SEARCH_TOKEN` | 无 | Bearer 口令，**不设就拒绝启动** |
| `FREE_SEARCH_ALLOW_ANONYMOUS` | 无 | 设 `1` 才允许无鉴权启动 |
| `FREE_SEARCH_PORT` / `FREE_SEARCH_HOST` | `8787` / `0.0.0.0` | 监听 |
| `FREE_SEARCH_MAX_CONCURRENCY` | `4` | 同时在跑的搜索数，超出排队 |
| `FREE_SEARCH_MAX_QUEUE` | `16` | 排队上限，满了返回 429 |
| `FREE_SEARCH_SESSION_TTL_MS` | `3600000` | 空闲会话回收时间 |
| `FREE_SEARCH_CALL_TIMEOUT_MS` | `25000` | 单次工具调用总时限 |
| `FREE_SEARCH_FALLBACK_ORDER` | 内置 | 逗号分隔的引擎顺序 |
| `EXA_API_KEY` 等 | 无 | 各引擎 key，见 `node/worker.cjs` 的 `ENV` 表 |

也可以放一个 `settings.json` 在本目录（`provider` / `maxResults` / `lang` / `timeoutMs` / `fallbackOrder`），环境变量覆盖它。

## 客户端配置

支持「远程 URL + 自定义 header」的（Cursor / Cline / Cindy / Windsurf / Claude Code）：

```
URL:    https://你的域名/mcp
Header: Authorization: Bearer <token>
```

只有 stdio 的（Claude Desktop）用 mcp-remote 桥：

```json
{ "mcpServers": { "free-search": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://你的域名/mcp", "--header", "Authorization: Bearer <token>"]
}}}
```

手机原生 App（ChatGPT / Claude 手机版）不支持填任意远程 MCP，这条走不通。

## 部署

1. 拷本目录到服务器，装 Node 20+。
2. 写 `/opt/free-search-mcp/.env`（`chmod 600`），放 token 和引擎 key。
3. `cp deploy/free-search-mcp.service /etc/systemd/system/ && systemctl enable --now free-search-mcp`
4. 前面套 Caddy 自动 HTTPS：
   ```
   mcp.example.com { reverse_proxy 127.0.0.1:8787 }
   ```

不带 key、只靠 bing/ddg 抓取的话，机房 IP 很容易被限流，建议至少配一个 `EXA_API_KEY` 或 `TAVILY_API_KEY`。

## 自检

```bash
node test/http.test.mjs
```

## 已知限制

- 单 worker 进程：所有客户端共用一个引擎池，靠并发闸门排队。
- 没有 CORS：浏览器端直连会失败，需要时再加。
- 不支持服务端主动推送（MCP 的 SSE 流），工具都是请求-响应型，够用。

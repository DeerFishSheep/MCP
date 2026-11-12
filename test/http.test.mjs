// 传输层自检：node test/http.test.mjs
// 只验协议与鉴权，不碰搜索引擎（不依赖网络）。

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token-abc";

const child = spawn(process.execPath, [join(HERE, "http-server.mjs")], {
  cwd: HERE,
  env: { ...process.env, FREE_SEARCH_PORT: String(PORT), FREE_SEARCH_HOST: "127.0.0.1", FREE_SEARCH_TOKEN: TOKEN },
  stdio: ["ignore", "ignore", "pipe"],
});
child.stderr.resume();

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function rpc(body, headers = {}, method = "POST") {
  const res = await fetch(`${BASE}/mcp`, { method, headers: { ...auth, ...headers }, body: method === "POST" ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

test.before(waitReady);
test.after(() => child.kill("SIGKILL"));

test("health 不需要鉴权", async () => {
  const r = await fetch(`${BASE}/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).tools, 6);
});

test("缺 token 返回 401", async () => {
  const res = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
});

test("没有会话的请求返回 404", async () => {
  const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(r.status, 404);
});

let sessionId;

test("initialize 返回 session id", async () => {
  const r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.protocolVersion, "2025-06-18");
  assert.equal(r.json.result.serverInfo.name, "free-search");
  sessionId = r.headers.get("mcp-session-id");
  assert.ok(sessionId);
});

test("带会话能列工具", async () => {
  const r = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sessionId });
  assert.equal(r.status, 200);
  const names = r.json.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["web_search", "web_fetch", "platform_search", "video_search", "weather", "free_search_test"]);
});

test("通知返回 202", async () => {
  const r = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sessionId });
  assert.equal(r.status, 202);
});

test("ping 有响应", async () => {
  const r = await rpc({ jsonrpc: "2.0", id: 3, method: "ping" }, { "mcp-session-id": sessionId });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.result, {});
});

test("DELETE 结束会话，之后 404", async () => {
  const r = await rpc(null, { "mcp-session-id": sessionId }, "DELETE");
  assert.equal(r.status, 204);
  const after = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { "mcp-session-id": sessionId });
  assert.equal(after.status, 404);
});

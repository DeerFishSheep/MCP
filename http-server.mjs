// Streamable HTTP 入口（MCP 2025-03-26 / 2025-06-18）：给远程客户端连。
//   POST   /mcp     收发 JSON-RPC（请求返回 application/json，通知返回 202）
//   GET    /mcp     405 —— 本服务不主动推送，没有服务端 SSE 流
//   DELETE /mcp     结束会话
//   GET    /health  探活（不需要鉴权）
// 鉴权：Authorization: Bearer $FREE_SEARCH_TOKEN，常量时间比较。

import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createSession, closeWorker, log, TOOLS } from "./core.mjs";

const PORT = Number(process.env.FREE_SEARCH_PORT ?? 8787);
const HOST = process.env.FREE_SEARCH_HOST ?? "0.0.0.0";
const TOKEN = (process.env.FREE_SEARCH_TOKEN ?? "").trim();
const ALLOW_ANON = process.env.FREE_SEARCH_ALLOW_ANONYMOUS === "1";
const MAX_BODY_BYTES = 1 << 20;
// 单 worker 进程 + 网页抓取型引擎：并发必须掐住，否则多客户端互相拖死。
const MAX_TOOL_CALLS = Number(process.env.FREE_SEARCH_MAX_CONCURRENCY ?? 4);
const MAX_QUEUE = Number(process.env.FREE_SEARCH_MAX_QUEUE ?? 16);
const SESSION_TTL_MS = Number(process.env.FREE_SEARCH_SESSION_TTL_MS ?? 3_600_000);

if (!TOKEN && !ALLOW_ANON) {
  log("FREE_SEARCH_TOKEN 未设置，拒绝启动（确实要无鉴权请设 FREE_SEARCH_ALLOW_ANONYMOUS=1）");
  process.exit(1);
}

// ── 会话 ────────────────────────────────────────────────────────────────────

const sessions = new Map();

function newSession() {
  const entry = { id: randomUUID(), lastSeen: Date.now(), waiting: new Map(), session: null };
  entry.session = createSession((message) => {
    const resolve = entry.waiting.get(String(message.id));
    if (resolve) {
      entry.waiting.delete(String(message.id));
      resolve(message);
      return;
    }
    log(`session ${entry.id}: 服务端消息 ${message.id} 没有接收方（本服务不主动推送）`);
  });
  return entry;
}

/** 跑一条消息，返回要回给客户端的 JSON-RPC 响应（通知/无需回复时返回 undefined）。 */
async function runOnce(entry, msg) {
  const key = String(msg.id);
  let answered;
  if (msg.id !== undefined && msg.id !== null) {
    entry.waiting.set(key, (message) => {
      answered = message;
    });
  }
  try {
    await entry.session.handle(msg);
  } finally {
    entry.waiting.delete(key);
  }
  return answered;
}

// 空闲会话不会自己消失，否则 sessions 只增不减。
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastSeen > SESSION_TTL_MS) {
      log(`session ${id} 空闲超时，回收`);
      sessions.delete(id);
    }
  }
}, 60_000).unref();

// ── 并发闸门 ────────────────────────────────────────────────────────────────

let activeToolCalls = 0;
const waiters = [];

/** true = 拿到槽位（用完要 releaseSlot）；false = 队列满，直接拒。 */
function acquireSlot() {
  if (activeToolCalls < MAX_TOOL_CALLS) {
    activeToolCalls += 1;
    return Promise.resolve(true);
  }
  if (waiters.length >= MAX_QUEUE) return Promise.resolve(false);
  return new Promise((resolve) => waiters.push(() => resolve(true)));
}

function releaseSlot() {
  const next = waiters.shift();
  if (next) next();
  else activeToolCalls -= 1;
}

// ── HTTP 工具函数 ───────────────────────────────────────────────────────────

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function authorized(req) {
  if (!TOKEN) return true;
  const raw = req.headers.authorization ?? "";
  const given = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { code: "TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── 请求处理 ────────────────────────────────────────────────────────────────

async function handlePost(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (error?.code === "TOO_LARGE") return sendJson(res, 413, { error: "body too large" });
    return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error?.message ?? error) } });
  }

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  }

  // 客户端回给我们「响应」：本服务不发请求，收下即可。
  if (msg.id !== undefined && msg.id !== null && typeof msg.method !== "string") {
    res.writeHead(202).end();
    return;
  }

  let entry;
  if (msg.method === "initialize") {
    entry = newSession();
    sessions.set(entry.id, entry);
  } else {
    entry = sessions.get(String(req.headers["mcp-session-id"] ?? ""));
    if (!entry) {
      return sendJson(res, 404, {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: -32000, message: "unknown or expired session, call initialize first" },
      });
    }
  }
  entry.lastSeen = Date.now();

  const isToolCall = msg.method === "tools/call";
  if (isToolCall) {
    const slot = await acquireSlot();
    if (!slot) {
      return sendJson(res, 429, {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "服务繁忙（并发已满），请稍后重试" },
      });
    }
  }

  try {
    const answer = await runOnce(entry, msg);
    if (!answer) {
      res.writeHead(202).end();
      return;
    }
    const headers = msg.method === "initialize" ? { "mcp-session-id": entry.id } : {};
    sendJson(res, 200, answer, headers);
  } finally {
    if (isToolCall) releaseSlot();
  }
}

function handleDelete(req, res) {
  const id = String(req.headers["mcp-session-id"] ?? "");
  const entry = sessions.get(id);
  if (!entry) {
    return sendJson(res, 404, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "unknown session" } });
  }
  sessions.delete(id);
  log(`session ${id} 主动结束`);
  res.writeHead(204).end();
}

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;

  if (path === "/health") {
    return sendJson(res, 200, {
      ok: true,
      tools: TOOLS.length,
      sessions: sessions.size,
      inflightToolCalls: activeToolCalls,
      queuedToolCalls: waiters.length,
    });
  }

  if (path !== "/mcp") return sendJson(res, 404, { error: "not found" });

  if (!authorized(req)) {
    return sendJson(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } }, {
      "www-authenticate": 'Bearer realm="free-search-mcp"',
    });
  }

  switch (req.method) {
    case "POST":
      return void handlePost(req, res).catch((error) => {
        log(`POST 处理失败: ${error?.stack ?? error}`);
        if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: String(error?.message ?? error) } });
        else res.end();
      });
    case "DELETE":
      return handleDelete(req, res);
    case "GET":
      // 没有服务端主动推送，按规范允许回 405。
      res.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    default:
      res.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
  }
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}/mcp  (auth=${TOKEN ? "bearer" : "DISABLED"}, concurrency=${MAX_TOOL_CALLS}+${MAX_QUEUE})`);
});

function shutdown(reason) {
  log(`shutdown: ${reason}`);
  server.close(() => {
    closeWorker();
    process.exit(0);
  });
  setTimeout(() => {
    closeWorker();
    process.exit(0);
  }, 3000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (error) => log(`uncaught exception: ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => log(`unhandled rejection: ${error?.stack ?? error}`));

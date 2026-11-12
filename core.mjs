// MCP JSON-RPC 主体：stdio 入口（mcp-server.mjs）和 HTTP 入口（http-server.mjs）共用。
// worker 引擎进程模块级共享（一个引擎池）；会话状态（取消表、在飞请求）在 createSession 里。

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "node", "worker.cjs");

export const MANIFEST = JSON.parse(readFileSync(join(HERE, "ghost.json"), "utf8"));

// ghost.json 的 tools 已经是 {name, description, parameters}，MCP 直接可用。
export const TOOLS = MANIFEST.tools.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.parameters ?? { type: "object", properties: {} },
}));

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const SERVER_INFO = {
  name: MANIFEST.id ?? "free-search",
  version: MANIFEST.version ?? "1.0.0",
};

export function log(message) {
  process.stderr.write(`[free-search] ${message}\n`);
}

// ── worker 子进程 ───────────────────────────────────────────────────────────

let worker = null;
let workerGen = 0;
let nextId = 1;
const pending = new Map(); // worker request id -> { gen, settle }
let workerBuf = "";

/**
 * 掐掉某一代 worker。只让这一代的在飞请求失败：生成号不同的请求属于新起的
 * worker，不能被上一代的退出/超时连坐（以前 exit 里无条件 pending.clear()，
 * 一次超时把同一进程里所有在飞调用一起变「worker exited」）。
 */
function killWorker(gen) {
  const dead = worker;
  if (!dead) return;
  if (gen !== undefined && dead.gen !== gen) return;
  worker = null;
  workerBuf = "";
  try {
    dead.kill("SIGKILL");
  } catch {
    /* 已经退出了 */
  }
  for (const [, slot] of [...pending]) {
    if (slot.gen !== dead.gen) continue;
    slot.settle(null);
  }
}

/** 让 worker 中止某条请求；worker 已经换代会话就直接判失败，由调用方 reject。 */
function cancelWorkerRequest(id, gen) {
  if (!worker || worker.gen !== gen) return;
  try {
    worker.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "search/cancel", params: { id } }) + "\n");
  } catch {
    killWorker(gen);
  }
}

function ensureWorker() {
  if (worker) return worker;
  const gen = ++workerGen;
  const child = spawn(process.execPath, [WORKER], {
    cwd: HERE,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.gen = gen;
  worker = child;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (worker !== child) return;
    workerBuf += chunk;
    let idx;
    while ((idx = workerBuf.indexOf("\n")) >= 0) {
      const line = workerBuf.slice(0, idx).trim();
      workerBuf = workerBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const slot = pending.get(msg.id);
      if (!slot) continue;
      slot.settle(msg);
    }
  });
  child.stdout.on("error", (error) => {
    log(`worker stdout error: ${error?.message ?? error}`);
    killWorker(gen);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => {}); // 引擎的噪声日志不进 MCP 通道
  child.stdin.on("error", (error) => {
    log(`worker stdin error: ${error?.message ?? error}`);
    killWorker(gen);
  });
  child.on("error", (error) => {
    log(`worker spawn error: ${error?.message ?? error}`);
    killWorker(gen);
  });
  child.on("exit", (code, signal) => {
    if (worker === child) {
      worker = null;
      workerBuf = "";
    }
    log(`worker exit code=${code} signal=${signal}`);
    for (const [, slot] of [...pending]) {
      if (slot.gen !== gen) continue;
      slot.settle(null);
    }
  });
  return child;
}

export function callWorker(method, params, timeoutMs, clientCalls, clientId) {
  const child = ensureWorker();
  const gen = child.gen;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(id);
      if (clientId !== undefined) clientCalls.delete(String(clientId));
      fn();
    };
    const slot = {
      gen,
      settle(message) {
        finish(() => {
          if (!message) return reject(new Error("worker exited"));
          if (message.error) return reject(new Error(message.error.message ?? "worker error"));
          resolve(message.result);
        });
      },
    };
    timer = setTimeout(() => {
      finish(() => {
        cancelWorkerRequest(id, gen);
        const error = new Error(`worker call timed out after ${timeoutMs}ms`);
        error.code = "TIMEOUT";
        reject(error);
      });
    }, timeoutMs);
    if (clientId !== undefined) {
      clientCalls.set(String(clientId), {
        cancel() {
          finish(() => {
            cancelWorkerRequest(id, gen);
            const error = new Error("request cancelled by client");
            error.code = "CANCELLED";
            reject(error);
          });
        },
      });
    }
    pending.set(id, slot);
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

// ── 设置 ────────────────────────────────────────────────────────────────────

/**
 * MCP 协议本身不传设置，worker 以前永远吃 DEFAULTS，用户在设置页改的引擎链路
 * 在 MCP 侧完全不生效。这里读插件目录的 settings.json（可选，没有就算了），
 * 再用环境变量覆盖；每次调用都重读，改完不用重启进程。
 */
function loadSettings() {
  let fromFile = {};
  try {
    const parsed = JSON.parse(readFileSync(join(HERE, "settings.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fromFile = parsed;
  } catch {
    /* 没有 settings.json 就用默认设置 */
  }
  const env = process.env;
  const settings = { ...fromFile };
  if (env.FREE_SEARCH_PROVIDER) settings.provider = env.FREE_SEARCH_PROVIDER;
  if (env.FREE_SEARCH_MAX_RESULTS) settings.maxResults = Number(env.FREE_SEARCH_MAX_RESULTS);
  if (env.FREE_SEARCH_FALLBACK_ORDER) {
    settings.fallbackOrder = env.FREE_SEARCH_FALLBACK_ORDER.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (env.FREE_SEARCH_LANG) settings.lang = env.FREE_SEARCH_LANG;
  return settings;
}

const DEFAULT_CALL_TIMEOUT_MS = 25000;
const MAX_CALL_TIMEOUT_MS = 120000;

/** 单次 tools/call 总时限：默认 25 秒，settings.timeoutMs 或环境变量可调，下限 5 秒。 */
function callTimeoutMs(settings) {
  const raw = Number(process.env.FREE_SEARCH_CALL_TIMEOUT_MS ?? settings.timeoutMs);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CALL_TIMEOUT_MS;
  return Math.min(Math.max(raw, 5000), MAX_CALL_TIMEOUT_MS);
}

// ── 会话 ────────────────────────────────────────────────────────────────────

/**
 * 一个 MCP 会话。send(message) 由入口提供（stdio 写 stdout，HTTP 写当前请求的响应）。
 * 取消表按会话隔离：HTTP 下多个客户端各行其是，requestId 会撞车。
 */
export function createSession(send) {
  const clientCalls = new Map(); // MCP 请求 id -> { cancel }
  const inflight = new Set();

  function ok(id, result) {
    send({ jsonrpc: "2.0", id, result });
  }

  function fail(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async function handleToolCall(id, params) {
    const name = params?.name;
    if (!TOOLS.some((t) => t.name === name)) {
      return fail(id, -32602, `unknown tool: ${name}`);
    }
    const settings = loadSettings();
    const timeoutMs = callTimeoutMs(settings);
    // worker 先按 timeoutMs 自己中止并回错误，MCP 这一层多留 1 秒做兜底，
    // 免得两边同时开火时客户端拿到的是一个空回复。
    const task = callWorker(
      "search/run",
      { tool: name, args: params.arguments ?? {}, settings, timeoutMs },
      timeoutMs + 1000,
      clientCalls,
      id,
    );
    inflight.add(task);
    try {
      const result = await task;
      const text = typeof result?.content === "string" ? result.content : JSON.stringify(result);
      ok(id, {
        content: [{ type: "text", text }],
        isError: result?.ok === false,
      });
    } finally {
      inflight.delete(task);
    }
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    // 通知没有 id，不需要响应
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case "initialize": {
          const asked = params?.protocolVersion;
          return ok(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          });
        }
        case "notifications/initialized":
          return;
        case "notifications/cancelled": {
          // 按 MCP requestId 中止对应搜索：取消的请求立即停，不给它继续跑的机会。
          const target = params?.requestId;
          const entry = clientCalls.get(String(target));
          if (!entry) return;
          log(`client cancelled request ${target}`);
          entry.cancel();
          return;
        }
        case "ping":
          return isNotification ? undefined : ok(id, {});
        case "tools/list":
          return ok(id, { tools: TOOLS });
        case "tools/call":
          return await handleToolCall(id, params);
        default:
          if (isNotification) return;
          return fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      if (isNotification) return;
      // 客户端主动取消：按 JSON-RPC 惯例不回复，回一条反而会被当成新结果。
      if (error?.code === "CANCELLED") {
        log(`request ${id} cancelled`);
        return;
      }
      if (error?.code === "TIMEOUT") {
        return fail(id, -32001, `搜索超时：${error.message}`);
      }
      fail(id, -32603, String(error?.message ?? error));
    }
  }

  /** 处理 notifications/cancelled 之外的入口也可以直接取消：成功返回 true。 */
  function cancel(requestId) {
    const entry = clientCalls.get(String(requestId));
    if (!entry) return false;
    entry.cancel();
    return true;
  }

  return { handle, cancel, inflight, clientCalls };
}

/** 进程退出前收掉 worker，避免留下孤儿进程。 */
export function closeWorker() {
  killWorker();
}

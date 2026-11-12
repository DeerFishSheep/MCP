// Cindy Node worker for the free-search engine layer.
//
// Ported from DDDMUC/dsh-free-search via the PI-Desktop port. The 27 engine
// implementations in ./extensions/free-search/engine.mjs are upstream code with
// no host dependency: they only use fetch, node:fs and node:child_process. What
// lives here is the registration layer, rewritten for Cindy's JSON-RPC worker
// protocol (one JSON object per line on stdin/stdout).
//
// Deliberate reductions against the PI port, because Cindy's host has no
// equivalent:
//   - no settings window / bridge routes (Cindy settings live in /kv and are
//     passed in per call by main.js)
//   - no `web.searchProvider` takeover
//   - no runtime self-update (Cindy rejects plugins that fetch code at runtime)
//   - no research / domain_search / multi_search wrappers
//
// engine.mjs is ESM and this file is CJS (the manifest only accepts .js/.cjs),
// so the engine loads through a one-time dynamic import.

const readline = require("node:readline");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let enginePromise = null;
function loadEngine() {
  if (enginePromise === null) enginePromise = import("./extensions/free-search/engine.mjs");
  return enginePromise;
}

// 给模型看的正文上限。web_search 默认 8 条、每条摘 300 字，正常不会超；
// 但 platform_search 最多 30 条、web_fetch 正文 20k，撞上就是几十万 token
// 塞进上下文。超了截断并明说，别让模型以为自己看全了。
const MAX_CONTENT_CHARS = 60000;

function clampContent(text) {
  const value = String(text ?? "");
  if (value.length <= MAX_CONTENT_CHARS) return value;
  return (
    value.slice(0, MAX_CONTENT_CHARS) +
    `\n\n…（内容过长，已截断；完整长度 ${value.length} 字符。需要更多就缩小 count 或换更具体的关键词）`
  );
}

let weatherPromise = null;
function loadWeather() {
  if (weatherPromise === null) weatherPromise = import("./lib/weather.js");
  return weatherPromise;
}

// ── Settings ───────────────────────────────────────────────────────────────

// Mirrors store.js DEFAULTS from the PI port. main.js hands these over from
// /kv on every call, so a settings change takes effect on the next search with
// no worker restart.
const DEFAULTS = {
  provider: "exa",
  disabledEngines: [],
  fallbackOrder: [],
  maxResults: 8,
  safeSearch: "off",
  bingMarket: "zh-CN",
  lang: "zh",
};

function settingsOf(raw) {
  if (raw === null || typeof raw !== "object") return { ...DEFAULTS };
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

// The built-in chain: exa first (keyless MCP endpoint), then keyless fallbacks.
const DEFAULT_FALLBACK_ORDER = [
  "exa",
  "tavily",
  "keenable",
  "firecrawl",
  "parallel",
  "bing",
  "anysearch",
  "ddg",
  "ddg-lite",
  "searxng",
];

// Engines whose key is optional: they run keyless and use a key only for a
// higher quota. Engines that scrape HTML never need one.
const KEY_OPTIONAL = ["exa", "tavily", "keenable", "firecrawl", "parallel", "you", "anysearch"];
const KEYLESS = ["ddg", "ddg-lite", "bing", "searxng"];

// Engines that cannot run at all without a key.
const KEY_REQUIRED = [
  "perplexity",
  "serpbase",
  "serply",
  "deepseek-official",
  "deepseek-tools",
  "baidu",
  "kimi",
  "aliyun",
  "doubao",
  "tinyfish",
  "jina",
  "zhihu_global",
  "zhihu_site",
  "openai",
  "gemini",
  "claude",
];

/** Engine ids that only run when named explicitly; never in the chain. */
const EXPLICIT_ONLY = ["openai", "gemini", "claude"];

/**
 * Every engine id the manifest/docsi list. Kept in sync with the engine module
 * at load time (see loadEngine), because that is the source of truth — this is
 * only the fallback for the keys/* handlers, which run before the engine module
 * is necessarily loaded.
 */
const ALL_ENGINE_IDS = [
  "ddg", "ddg-lite", "bing", "searxng", "anysearch", "exa", "tavily",
  "keenable", "firecrawl", "parallel", "perplexity", "serpbase", "serply",
  "deepseek-official", "deepseek-tools", "you", "baidu", "kimi", "aliyun",
  "doubao", "tinyfish", "jina", "zhihu_global", "zhihu_site",
  "openai", "gemini", "claude",
];

// ── Per-engine key storage ─────────────────────────────────────────────────
//
// Why a file instead of the host vault: Cindy's /secrets channel is write-only.
// It can tell you a key exists and show its last 4 characters, but it can never
// read the value back. With 27 engines behind one credential that makes a
// per-engine settings UI impossible — you cannot show, edit or clear one engine
// without rewriting the whole blob. So the keys live in this plugin's own data
// directory instead, one entry per engine, exactly as the upstream PI plugin did.
//
// The host vault is still used (see the manifest's secretBindings) and still
// wins over this file when present, so a user who pastes a JSON blob into the
// host's setup card keeps working. This file is what the settings page edits.
//
// Mode 0600: only the current user can read it.

function keysFile() {
  // Per-platform data dir. macOS is the common case but not assumed.
  const base =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Cindy", "plugin-data", "free-search")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Cindy", "plugin-data", "free-search")
        : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "cindy", "plugin-data", "free-search");
  return path.join(base, "api-keys.json");
}

/** Read the per-engine key file. Missing or corrupt reads as empty. */
function readStoredKeys() {
  try {
    const parsed = JSON.parse(fs.readFileSync(keysFile(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [engine, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) out[engine] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** Write the whole per-engine map atomically, mode 0600. */
function writeStoredKeys(next) {
  const file = keysFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  // rename() keeps the tmp file's mode, but be explicit in case the target
  // already existed with looser permissions from an older version.
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return next;
}

/**
 * Engine keys, merged from two sources, last one wins:
 *   1. process environment (fleet-wide default, set in the shell)
 *   2. the plugin's own per-engine file (what the settings page edits)
 */
function keysOf() {
  const keys = {};
  // Environment first, so a saved key can override it.
  const ENV = {
    exa: ["EXA_API_KEY"],
    tavily: ["TAVILY_API_KEY"],
    keenable: ["KEENABLE_API_KEY"],
    firecrawl: ["FIRECRAWL_API_KEY"],
    parallel: ["PARALLEL_API_KEY"],
    anysearch: ["ANYSEARCH_API_KEY"],
    you: ["YDC_API_KEY", "YOUCOM_API_KEY"],
    perplexity: ["PERPLEXITY_API_KEY"],
    serpbase: ["SERPBASE_API_KEY"],
    serply: ["SERPLY_API_KEY"],
    baidu: ["BAIDU_API_KEY"],
    kimi: ["MOONSHOT_API_KEY"],
    aliyun: ["DASHSCOPE_API_KEY"],
    doubao: ["DOUBAO_SEARCH_API_KEY"],
    tinyfish: ["TINYFISH_API_KEY"],
    jina: ["JINA_API_KEY"],
    zhihu_global: ["ZHIHU_API_KEY"],
    zhihu_site: ["ZHIHU_API_KEY"],
    "deepseek-official": ["DEEPSEEK_API_KEY"],
    "deepseek-tools": ["DEEPSEEK_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    gemini: ["GEMINI_API_KEY"],
    claude: ["ANTHROPIC_API_KEY"],
  };
  for (const [engine, names] of Object.entries(ENV)) {
    for (const name of names) {
      const value = process.env[name];
      if (value && String(value).trim()) {
        keys[engine] = String(value).trim();
        break;
      }
    }
  }

  // The settings-page file overrides the environment.
  Object.assign(keys, readStoredKeys());

  return keys;
}

function keyOf(keys, engine) {
  return typeof keys[engine] === "string" ? keys[engine] : "";
}

/** Engines that can run right now: enabled, and no missing required key. */
function runnableChain(settings, keys, wanted) {
  const base =
    Array.isArray(wanted) && wanted.length
      ? wanted
      : Array.isArray(settings.fallbackOrder) && settings.fallbackOrder.length
        ? settings.fallbackOrder
        : DEFAULT_FALLBACK_ORDER;
  const preferred = settings.provider || DEFAULTS.provider;
  const ordered =
    preferred === "auto" ? base : [preferred, ...base.filter((engine) => engine !== preferred)];
  const disabled = Array.isArray(settings.disabledEngines) ? settings.disabledEngines : [];
  return ordered.filter((engine) => {
    if (disabled.includes(engine)) return false;
    if (EXPLICIT_ONLY.includes(engine)) return false;
    if (KEY_REQUIRED.includes(engine)) return Boolean(keyOf(keys, engine));
    if (KEY_OPTIONAL.includes(engine) || KEYLESS.includes(engine)) return true;
    return Boolean(keyOf(keys, engine));
  });
}

// ── Engine dispatch ────────────────────────────────────────────────────────

/**
 * Dispatch one engine call. Signatures differ upstream; this is the adapter.
 * `pt` is the parsed time range (a predicate upstream uses to filter results).
 */
async function runEngine(engine, query, maxResults, options, signal, ctx) {
  const { m, keys } = ctx;
  const key = keyOf(keys, engine);
  const timeRange = options?.timeRange;
  switch (engine) {
    case "bing":
      return m.searchBing(query, maxResults, options, signal);
    case "ddg":
      return m.searchDdgHtml(query, maxResults, options, signal);
    case "ddg-lite":
      return m.searchDdgLite(query, maxResults, options, signal);
    case "searxng":
      return m.searchSearxng(query, maxResults, options, signal);
    case "anysearch":
      return m.searchAnysearch(query, maxResults, signal, key);
    case "exa":
      return key
        ? m.searchExa(query, maxResults, key, timeRange, signal)
        : m.searchExaMCP(query, maxResults, signal);
    case "tavily":
      return m.searchTavily(query, maxResults, key, timeRange, signal);
    case "keenable":
      return m.searchKeenable(query, maxResults, key, timeRange, signal);
    case "firecrawl":
      return m.searchFirecrawl(query, maxResults, key, timeRange, signal);
    case "parallel":
      return key
        ? m.searchParallel(query, maxResults, key, timeRange, signal)
        : m.searchParallelMCP(query, maxResults, timeRange, signal);
    case "perplexity":
      return m.searchPerplexity(query, maxResults, key, signal);
    case "deepseek-official":
      return m.searchDeepSeekOfficial(query, maxResults, key, signal);
    case "deepseek-tools":
      return m.searchDeepSeekTools(query, maxResults, key, timeRange, signal);
    case "serpbase":
      return m.searchSerpbase(query, maxResults, key, options, signal);
    case "serply":
      return m.searchSerply(query, maxResults, key, options, signal);
    case "you":
      return m.searchYoucom(query, maxResults, key, signal);
    case "tinyfish":
      return m.searchTinyfish(query, maxResults, key, timeRange, signal);
    case "jina":
      return m.searchJina(query, maxResults, key, signal);
    case "baidu":
      return m.searchBaidu(query, maxResults, key, timeRange, signal);
    case "kimi":
      return m.searchKimi(query, maxResults, key, timeRange, signal);
    case "aliyun":
      return m.searchAliyun(query, maxResults, key, timeRange, signal);
    case "doubao":
      return m.searchDoubao(query, maxResults, key, timeRange, signal);
    case "zhihu_global":
      return m.searchZhihuGlobal(query, maxResults, key, timeRange, signal);
    case "zhihu_site":
      return m.searchZhihuSite(query, maxResults, key, signal);
    case "openai":
      return m.searchOpenai(query, maxResults, key, options, signal);
    case "gemini":
      return m.searchGemini(query, maxResults, key, options, signal);
    case "claude":
      return m.searchClaude(query, maxResults, key, options, signal);
    default:
      throw new Error(`unsupported engine "${engine}"`);
  }
}

// 单次尝试硬上限。所有引擎（有 key / 无 key、API / 免费端点）统一走这一套策略：
// 5 秒没结果 → 同一引擎重试一次 → 还不行才回退下一个。
const ENGINE_TIMEOUT_MS = 5000;
const ENGINE_RETRY = 1;
const RETRYABLE_CLASSES = new Set(["transient", "unknown"]);

function withTimeout(promise, ms, label, controller) {
  let timer;
  // 超时后原 promise 可能才 reject，先挂个空 catch 免得变成 unhandled
  promise.catch(() => {});
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // 只 race 不 abort 的话，底层 fetch 还挂在网络上，一个卡住的引擎会一直占资源。
      const error = new Error(`${label} timed out after ${ms}ms`);
      try {
        controller?.abort(error);
      } catch {
        /* 已经 abort 过 */
      }
      reject(error);
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** 单次操作的中止作用域：请求级 signal 一断（取消或超时），子操作跟着断。 */
function abortScope(parent) {
  const controller = new AbortController();
  const relay = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) relay();
    else parent.addEventListener("abort", relay, { once: true });
  }
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    done: () => parent?.removeEventListener("abort", relay),
  };
}

/** 请求级取消/超时的说明文字，用来在链路上立刻停下而不是继续回退。 */
function abortMessage(signal) {
  const reason = signal?.reason;
  return reason instanceof Error ? reason.message : String(reason ?? "搜索已取消");
}

/**
 * Run the chain: the preferred engine first, then every other runnable engine.
 * Cooling engines are skipped; a failure sets the upstream cooldown policy.
 */
async function searchChain(query, params, ctx) {
  const { m } = ctx;
  const settings = ctx.settings;
  const requested = String(params.engine ?? "").trim();
  const runnable = runnableChain(settings, ctx.keys);

  // 首选引擎：显式点名的优先，其次是设置里的 provider，最后回落到默认。
  // provider 可能已被用户停用（设置页允许这么做），那就退回链路第一个可跑的，
  // 不然会把一个被停用的引擎又强行塞到队首。
  let preferred;
  if (requested && requested !== "auto") {
    preferred = requested;
  } else {
    const saved = settings.provider || DEFAULTS.provider;
    const disabled = Array.isArray(settings.disabledEngines) ? settings.disabledEngines : [];
    preferred = disabled.includes(saved) ? runnable[0] || saved : saved;
  }

  const limit = Math.min(Math.max(Number(params.count) || Number(settings.maxResults) || 8, 1), 20);
  const timeRange = m.parseTimeRange(params.timeRange);

  // 显式点名的引擎即使不在可运行链路里也要试一次——用户既然点名了，
  // 就让真实的失败原因（缺 key、连不上）传回去，比静默换成别的引擎好。
  const chain = [preferred, ...runnable.filter((engine) => engine !== preferred)];

  const failures = [];
  for (const current of chain) {
    if (!m.ALL_ENGINES.includes(current)) {
      failures.push(`${current}: unknown engine`);
      continue;
    }
    // 请求已取消/超时：立刻停，别把剩下的引擎再跑一遍。
    if (ctx.signal?.aborted) throw new Error(abortMessage(ctx.signal));
    if (m.isCoolingDown(current)) {
      failures.push(`${current}: cooling down`);
      continue;
    }
    for (let attempt = 0; attempt <= ENGINE_RETRY; attempt += 1) {
      if (ctx.signal?.aborted) throw new Error(abortMessage(ctx.signal));
      const tag = attempt === 0 ? current : `${current}#retry${attempt}`;
      const scope = abortScope(ctx.signal);
      try {
        const result = await withTimeout(
          runEngine(
            current,
            query,
            limit,
            {
              timeRange,
              safeSearch: settings.safeSearch,
              bingMarket: settings.bingMarket,
              lang: settings.lang,
            },
            scope.signal,
            ctx,
          ),
          ENGINE_TIMEOUT_MS,
          tag,
          scope,
        );
        if (result?.sources?.length) {
          return { ...result, engineUsed: current, failures };
        }
        // 0 结果不是故障，重试没有意义，直接换下一个
        failures.push(`${current}: 0 results`);
        m.applyFailureCooldown(current, "invalid-response", false);
        break;
      } catch (error) {
        if (ctx.signal?.aborted) throw new Error(abortMessage(ctx.signal));
        const failure = m.classifyFailure(error);
        // 只有瞬时故障值得重试；key 错、额度用完、被反爬挡住，重试只是白等
        if (attempt < ENGINE_RETRY && RETRYABLE_CLASSES.has(failure.class)) {
          failures.push(`${current} [${failure.class}]: ${failure.message} → 重试`);
          continue;
        }
        failures.push(`${current} [${failure.class}]: ${failure.message}`);
        m.applyFailureCooldown(current, failure.class, failure.rateLimited);
        break;
      } finally {
        scope.done();
      }
    }
  }
  throw new Error(`所有搜索引擎都失败了：\n${failures.join("\n")}`);
}

// ── Tool implementations ───────────────────────────────────────────────────

function renderSources(sources, wrap) {
  const lines = sources.map((item, index) => {
    const title = item.title || "(无标题)";
    const url = item.url || "";
    const snippet = String(item.snippet || "").replace(/\s+/g, " ").trim();
    const date = item.publishedAt ? ` (${item.publishedAt})` : "";
    return `${index + 1}. ${title}${date}\n   ${url}${snippet ? `\n   ${snippet.slice(0, 300)}` : ""}`;
  });
  return wrap(lines.join("\n\n"));
}

async function toolWebSearch(params, ctx) {
  const { m } = ctx;
  const query = String(params.query ?? "").trim();
  if (!query) throw new Error("query is required");
  const result = await searchChain(query, params, ctx);

  let body =
    `引擎: ${result.engineUsed} · ${result.sources.length} 条结果\n\n` +
    renderSources(result.sources, m.wrapUntrustedBlock);

  // 走了回退链就把跳过原因带上——模型需要知道「为什么不是首选引擎」，
  // 最常见的是某个引擎的 key 没配，或某引擎临时挂了。只带前 4 条，
  // 免得冷却提示把正文淹了。
  if (result.failures.length) {
    const shown = result.failures.slice(0, 4).join("\n");
    const rest = result.failures.length > 4 ? `\n…另 ${result.failures.length - 4} 个引擎已跳过` : "";
    body += `\n\n已跳过：\n${shown}${rest}`;
  }

  return {
    content: body,
    detail: { engine: result.engineUsed, query, sources: result.sources, failures: result.failures },
  };
}

const FETCH_TIMEOUT_MS = 15000;

async function toolWebFetch(params, ctx) {
  const { m } = ctx;
  const url = String(params.url ?? "").trim();
  if (!/^https:\/\//i.test(url)) throw new Error(`only https URLs are supported (got "${url.slice(0, 60)}")`);
  const scope = abortScope(ctx.signal);
  try {
    const response = await withTimeout(
      fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; Cindy free-search)" },
        signal: scope.signal,
        redirect: "follow",
      }),
      FETCH_TIMEOUT_MS,
      "web_fetch",
      scope,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    const html = await withTimeout(response.text(), FETCH_TIMEOUT_MS, "web_fetch body", scope);
    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    return {
      content: m.wrapUntrustedBlock(body.slice(0, 20000) || "(页面正文为空)"),
      detail: { url, charCount: body.length },
    };
  } finally {
    scope.done();
  }
}

const PLATFORMS = [
  "github",
  "v2ex",
  "bilibili",
  "reddit",
  "hn",
  "stackoverflow",
  "wikipedia",
  "npm",
  "juejin",
  "douban",
  "qiita",
];

async function toolPlatformSearch(params, ctx) {
  const { m } = ctx;
  const platform = String(params.platform ?? "").toLowerCase().trim();
  const query = String(params.query ?? "").trim();
  if (!query) throw new Error("query is required");
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`unknown platform "${platform}"; one of: ${PLATFORMS.join(", ")}`);
  }
  const count = Math.min(Math.max(Number(params.count) || 10, 1), 30);
  const result = await m.searchPlatform(platform, query, count, ctx.signal, "zh");
  if (!result?.sources?.length) {
    return { content: `「${query}」在 ${platform} 没有结果。`, detail: { platform, query, sources: [] } };
  }
  return {
    content: renderSources(result.sources, m.wrapUntrustedBlock),
    detail: { platform, query, sources: result.sources },
  };
}

async function toolVideoSearch(params, ctx) {
  const { m } = ctx;
  const query = String(params.query ?? "").trim();
  if (!query) throw new Error("query is required");
  const count = Math.min(Math.max(Number(params.count) || 10, 1), 20);
  // 两个实现的签名不一样：Bing 收 options 再收 signal，DDG 直接收 signal。
  // 上游 PI 移植版把它们当同签名调用的，DDG 路径因此一直是坏的
  // （signal 位置拿到的是普通对象，报 signal?.addEventListener is not a function）。
  const result =
    params.source === "ddg"
      ? await m.searchDdgVideos(query, count, ctx.signal)
      : await m.searchBingVideos(query, count, { lang: "zh" }, ctx.signal);
  if (!result?.sources?.length) {
    return { content: `「${query}」没有找到视频。`, detail: { query, sources: [] } };
  }
  return {
    content: renderSources(result.sources, m.wrapUntrustedBlock),
    detail: { query, sources: result.sources },
  };
}

async function toolWeather(params, ctx) {
  const w = await loadWeather();
  const location = String(params.location ?? "").trim();
  if (!location) throw new Error("location is required");
  const days = Math.min(Math.max(Number(params.days) || 3, 1), 7);
  const raw = await w.fetchWeather(location, days, "zh", ctx.signal);
  return { content: w.formatWeather(raw, "zh"), detail: { location, days, raw } };
}

async function toolTest(params, ctx) {
  const { m } = ctx;

  // 显式点名了引擎却一个都不认识时直接说清楚。不这样的话 wanted 会是空数组、
  // 循环不跑、lines 为空，调用方只能拿到一句「没有结果」，看不出是名字打错了。
  if (Array.isArray(params.engines) && params.engines.length) {
    const unknown = params.engines.filter((engine) => !m.ALL_ENGINES.includes(engine));
    if (unknown.length === params.engines.length) {
      return {
        content: `未知引擎：${unknown.join(", ")}。可选的是：${m.ALL_ENGINES.join(", ")}`,
        detail: { query: params.query, tested: [], lines: [], skipped: m.ALL_ENGINES, unknown },
      };
    }
  }

  const query = String(params.query ?? "").trim() || "DeepSeek";
  const wanted = Array.isArray(params.engines) && params.engines.length
    ? params.engines.filter((engine) => m.ALL_ENGINES.includes(engine))
    : runnableChain(ctx.settings, ctx.keys);
  const lines = [];
  for (const engine of wanted) {
    if (ctx.signal?.aborted) {
      lines.push(`- (已取消：${abortMessage(ctx.signal)})`);
      break;
    }
    if (m.isCoolingDown(engine)) {
      lines.push(`- ${engine}: 冷却中`);
      continue;
    }
    const started = Date.now();
    const scope = abortScope(ctx.signal);
    try {
      const result = await withTimeout(
        runEngine(engine, query, 2, {}, scope.signal, ctx),
        ENGINE_TIMEOUT_MS,
        engine,
        scope,
      );
      const elapsed = Date.now() - started;
      const sample = result?.sources?.[0]?.title;
      lines.push(
        result?.sources?.length
          ? `- ${engine}: OK (${result.sources.length} 条, ${elapsed}ms${sample ? `, 例: "${String(sample).slice(0, 40)}"` : ""})`
          : `- ${engine}: FAIL - 0 results (${elapsed}ms)`,
      );
    } catch (error) {
      lines.push(`- ${engine}: FAIL - ${String(error?.message ?? error).slice(0, 160)}`);
    } finally {
      scope.done();
    }
  }
  // 被取消/超时时不能装作「测完了」只交回半截结果，必须让调用方看到明确的中止原因。
  if (ctx.signal?.aborted) throw new Error(abortMessage(ctx.signal));
  const skipped = m.ALL_ENGINES.filter((engine) => !wanted.includes(engine));
  return {
    content: m.wrapUntrustedBlock(`搜索引擎测试 (${query}):\n${lines.join("\n")}`),
    detail: { query, tested: wanted, lines, skipped },
  };
}

const TOOLS = {
  web_search: toolWebSearch,
  web_fetch: toolWebFetch,
  platform_search: toolPlatformSearch,
  video_search: toolVideoSearch,
  weather: toolWeather,
  free_search_test: toolTest,
};

// ── Protocol ───────────────────────────────────────────────────────────────

// 宿主断开管道时不许未捕获崩溃：这个进程一没了，调用方就永远等不到回复。
process.stdout.on("error", (error) => {
  process.stderr.write(`[free-search worker] stdout closed: ${error?.code ?? error}\n`);
  process.exit(0);
});

const activeRequests = new Map(); // request id -> AbortController
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const MAX_REQUEST_TIMEOUT_MS = 120000;

function reply(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

readline
  .createInterface({ input: process.stdin })
  .on("line", async (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    // MCP 侧超时或用户取消时发的通知：立刻中止这条请求，不让它继续跑。
    if (request.method === "search/cancel") {
      activeRequests.get(request.params?.id)?.abort(new Error("request cancelled"));
      return;
    }

    // 设置页逐引擎管理 key 的三个方法。它们不碰宿主凭证库，只读写插件自己的
    // 数据目录（见 keysFile）。设置页没有 callId，这些操作也不需要凭证。
    if (request.method === "keys/list") {
      const stored = readStoredKeys();
      const env = keysOf("");
      const engines = {};
      for (const engine of ALL_ENGINE_IDS) {
        const storedValue = stored[engine];
        const effective = env[engine];
        engines[engine] = {
          // 尾 4 位指纹：够用户回忆填的是哪个 key，不够重建出值。
          tail: typeof effective === "string" && effective.length >= 12 ? effective.slice(-4) : null,
          source: storedValue ? "settings" : effective ? "env" : "none",
        };
      }
      reply({ jsonrpc: "2.0", id: request.id, result: { ok: true, engines } });
      return;
    }

    if (request.method === "keys/set") {
      const engine = String(request.params?.engine ?? "").trim();
      const value = String(request.params?.value ?? "").trim();
      if (!ALL_ENGINE_IDS.includes(engine)) {
        reply({ jsonrpc: "2.0", id: request.id, result: { ok: false, content: `未知引擎 "${engine}"` } });
        return;
      }
      try {
        const next = readStoredKeys();
        if (value) next[engine] = value;
        else delete next[engine];
        writeStoredKeys(next);
        reply({ jsonrpc: "2.0", id: request.id, result: { ok: true, engine, cleared: !value } });
      } catch (error) {
        reply({ jsonrpc: "2.0", id: request.id, result: { ok: false, content: `写不进去：${String(error?.message ?? error)}` } });
      }
      return;
    }

    if (request.method !== "search/run") {
      reply({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
      return;
    }

    const params = request.params ?? {};

    const handler = TOOLS[params.tool];
    if (!handler) {
      reply({
        jsonrpc: "2.0",
        id: request.id,
        result: { ok: false, content: `未知工具 "${params.tool}"` },
      });
      return;
    }

    // 每条请求一个 AbortController：客户端取消或总时限到了都能真的把搜索掐掉，
    // 而不是只 race 掉 Promise、让底层请求继续跑。
    const controller = new AbortController();
    const timeoutMs = Math.min(
      Math.max(Number(params.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS, 1000),
      MAX_REQUEST_TIMEOUT_MS,
    );
    const timer = setTimeout(
      () => controller.abort(new Error(`搜索超时（${Math.round(timeoutMs / 1000)} 秒）已中止`)),
      timeoutMs,
    );
    activeRequests.set(request.id, controller);
    try {
      const m = await loadEngine();
      const ctx = {
        m,
        signal: controller.signal,
        settings: settingsOf(params.settings),
        keys: keysOf(),
      };
      const out = await handler(params.args ?? {}, ctx);
      if (typeof out?.content === "string") out.content = clampContent(out.content);
      reply({ jsonrpc: "2.0", id: request.id, result: { ok: true, ...out } });
    } catch (error) {
      reply({
        jsonrpc: "2.0",
        id: request.id,
        result: { ok: false, content: String(error?.message ?? error) },
      });
    } finally {
      clearTimeout(timer);
      activeRequests.delete(request.id);
    }
  });

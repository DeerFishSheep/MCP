import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { mcpCall, mcpContentText, parseMcpResponseText } from "../../lib/mcp_adapter.js";
import { fetchWeather, formatWeather, sanitizeWeatherResult, WEATHER_OUTPUT_SCHEMA } from "../../lib/weather.js";
import { setActiveBlockedDomains, getActiveBlockedDomains, isDomainBlocked, applyBlockedFilterToResult } from "../../lib/domain_filter.js";
import { stripTrackingParams, normalizeUrlForDedupe } from "../../lib/url_norm.js";
import { selectEngines, planTopUp, resolveMinSources, describeTarget, credentialRequirement, partitionByCredentials, rankMergedResults, domainOf } from "../../lib/multi_policy.js";


const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const DDG_LITE_URL = "https://lite.duckduckgo.com/lite/";
const BING_URL = "https://www.bing.com/search";
const TAVILY_URL = "https://api.tavily.com/search";
const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/search";
// Firecrawl 的 keyless 档按出口 IP 判定：VPN/代理出口会被 403 拒绝。
// 这个判定不随请求变化，遇到一次就冷却 6 小时，避免回退链每次都白等一次往返。
// 冷却按「代理指纹」记账：换一套代理配置就视为换了出口，旧冷却自动失效。
const FIRECRAWL_KEYLESS_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let firecrawlKeylessBlock = null; // { proxy, until }

function proxyFingerprint() {
  const names = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
  return names.map((name) => String(process.env[name] ?? "")).join("|");
}

/** 该错误是不是 Firecrawl 对 keyless 档的出口 IP 拒绝（而非 key 失效/限流）。 */
export function isFirecrawlKeylessRefusal(status, body) {
  if (status !== 403) return false;
  return /vpn|proxy|without an api key|api key from here/i.test(String(body || ""));
}

/** 当前代理配置是否仍处于冷却中；代理配置变了就清掉旧记录。 */
export function isFirecrawlKeylessBlocked(now = Date.now(), proxy = proxyFingerprint()) {
  if (firecrawlKeylessBlock === null) return false;
  if (firecrawlKeylessBlock.proxy !== proxy) {
    firecrawlKeylessBlock = null;
    return false;
  }
  if (now >= firecrawlKeylessBlock.until) {
    firecrawlKeylessBlock = null;
    return false;
  }
  return true;
}

// 输出契约（小步版）：给 advanced_search / multi_search 增加 meta.uncertainty。
// 只做启发式提示，不改变结果本身；agent 可以据此决定是否二次核对。
const UNCERTAINTY_AGGREGATORS = /(^|\.)(zhihu|sohu|sina|163|qq|toutiao|baijiahao|csdn|jianshu|medium|substack|reddit|quora|stackexchange)\./i;

// 置信度说明的文案表：只有 zh / en 两套，其它语言回退 en（#92）。
const UNCERTAINTY_NOTES = {
  empty: { zh: "没有返回结果", en: "no results returned" },
  single: { zh: "只有 1 个来源", en: "only one source" },
  sameSite: { zh: "所有结果来自同一站点", en: "all results come from a single site" },
  two: { zh: "只有 2 个来源", en: "only two sources" },
  noDates: { zh: "带时间过滤但结果没有发布时间", en: "time filter applied but the results carry no publish dates" },
  partial: { zh: "部分引擎失败，结果可能不完整", en: "some engines failed; the result may be incomplete" },
  aggregator: { zh: "包含聚合站内容，建议二次核对", en: "includes aggregator content; worth a second look" },
};

export function assessUncertainty({ sources = [], timeRange = false, note: rawNote = "", lang } = {}) {
  const note = (key) => UNCERTAINTY_NOTES[key][outputLanguage(lang) === "zh" ? "zh" : "en"];
  const list = Array.isArray(sources) ? sources : [];
  const notes = [];
  const domains = new Set();
  for (const source of list) {
    try {
      domains.add(new URL(String(source.url ?? "")).hostname.replace(/^www\./i, "").toLowerCase());
    } catch {}
  }
  let level = "high";
  if (list.length === 0) {
    level = "low";
    notes.push(note("empty"));
  } else if (list.length === 1) {
    level = "low";
    notes.push(note("single"));
  } else if (domains.size === 1) {
    level = "medium";
    notes.push(note("sameSite"));
  } else if (list.length === 2) {
    level = "medium";
    notes.push(note("two"));
  }
  if (timeRange && list.every((source) => !source.publishedAt)) {
    if (level === "high") level = "medium";
    notes.push(note("noDates"));
  }
  if (rawNote && /fail|error|fallback|skipped|failed/i.test(rawNote)) {
    level = "low";
    notes.push(note("partial"));
  }
  if ([...domains].some((domain) => UNCERTAINTY_AGGREGATORS.test(domain))) {
    notes.push(note("aggregator"));
    if (level === "high") level = "medium";
  }
  return { level, notes };
}

// advanced_search / multi_search 的输出 schema 片段：只新增可选字段，不改既有结构。
const UNCERTAINTY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    uncertainty: {
      type: "object",
      additionalProperties: false,
      properties: {
        level: { type: "string" },
        notes: { type: "array", items: { type: "string" } },
      },
    },
  },
};
/** 一个字段/环境变量里可以放多把 key：逗号、分号或换行分隔。 */
export function splitApiKeys(raw) {
  return String(raw ?? "").split(/[\n,;]+/).map((key) => key.trim()).filter(Boolean);
}
export function markFirecrawlKeylessBlocked(proxy = proxyFingerprint()) {
  firecrawlKeylessBlock = { proxy, until: Date.now() + FIRECRAWL_KEYLESS_COOLDOWN_MS };
}
const PARALLEL_URL = "https://api.parallel.ai/v1/search";
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const KEENABLE_URL = "https://api.keenable.ai/v1/search";
const KEENABLE_MCP_URL = "https://api.keenable.ai/mcp";
const SERPBASE_URL = "https://api.serpbase.dev/google/search";
const SERPLY_URL = "https://api.serply.io/v1/search";
const YOUCOM_URL = "https://ydc-index.io/v1/search";
// You.com 免 key 档：同样的 query / count 参数与 results.web[] 响应，每天 100 次免费搜索
const YOUCOM_FREE_URL = "https://api.you.com/v1/agents/search";
const YOUCOM_KEYS_LINK = "https://you.com/platform/api-keys";
const TINYFISH_URL = "https://api.search.tinyfish.ai";
const JINA_URL = "https://s.jina.ai/";
const DOUBAO_SEARCH_URL = "https://open.feedcoopapi.com/search_api/web_search";
const ZHIHU_MCP_URL = "https://developer.zhihu.com/api/mcp/v1";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ACCEPT_LANG = "zh-CN,zh;q=0.9,en;q=0.8";
// 当前请求生效的 Accept-Language：由 lang（或显式 bingMarket）决定，搜索前设置（#92）。
let activeAcceptLanguage = ACCEPT_LANG;
/** 由配置推导 Accept-Language：显式 bingMarket 优先，否则跟随 lang（未知回退 en）。 */
export function acceptLanguageFor(cfg) {
  const market = cfg?.bingMarket;
  if (market && MARKET_TO_LANG[market]) return MARKET_TO_LANG[market];
  return LANG_PROFILES[searchLanguage(configLanguage(cfg))].acceptLang;
}

export function setActiveAcceptLanguage(value) {
  if (typeof value === "string" && value.trim() !== "") activeAcceptLanguage = value.trim();
}

// 语言 → Bing 本地化档案：{ market, acceptLang }。
// lang 字段（设置页可切换）驱动 Bing 的 mkt + Accept-Language，让非中文用户
// 也能拿到本地化结果（俄语搜俄文等）。bingMarket 显式设置时优先于映射。
// #92：区分「搜索语言」与「输出语言」。
// - searchLanguage：交给 provider 的参数（Wikipedia 主机、geocoding、Accept-Language）——支持的语言原样透传，未知回退 en；
// - outputLanguage：我们自己渲染的文案（天气、置信度说明）——只有 zh/en 两套文案，其它语言回退 en，
//   否则日语/俄语用户会在回答前拿到一整段中文。
export function searchLanguage(lang) {
  const tag = String(lang ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LANG_PROFILES, tag) ? tag : "en";
}

/**
 * 配置里生效的语言标签：未设置时按 schema 默认 zh（#92）。
 * searchLanguage() 只负责「未知值回退 en」，两者不要混用。
 */
export function configLanguage(cfg) {
  const value = cfg?.lang;
  if (value === undefined || value === null) return "zh";
  const tag = String(value).trim().toLowerCase();
  return tag === "" ? "zh" : tag;
}


export function outputLanguage(lang) {
  return searchLanguage(lang) === "zh" ? "zh" : "en";
}
const LANG_PROFILES = {
  zh: { market: "zh-CN", acceptLang: "zh-CN,zh;q=0.9,en;q=0.8" },
  en: { market: "en-US", acceptLang: "en-US,en;q=0.9" },
  ru: { market: "ru-RU", acceptLang: "ru-RU,ru;q=0.9,en;q=0.8" },
  ja: { market: "ja-JP", acceptLang: "ja-JP,ja;q=0.9,en;q=0.8" },
  de: { market: "de-DE", acceptLang: "de-DE,de;q=0.9,en;q=0.8" },
  fr: { market: "fr-FR", acceptLang: "fr-FR,fr;q=0.9,en;q=0.8" },
  es: { market: "es-ES", acceptLang: "es-ES,es;q=0.9,en;q=0.8" },
  ko: { market: "ko-KR", acceptLang: "ko-KR,ko;q=0.9,en;q=0.8" },
};
// market → 语言（bingMarket 显式设置时反推 accept-language，避免中文优先 header 污染）
const MARKET_TO_LANG = {
  "zh-CN": "zh-CN,zh;q=0.9,en;q=0.8",
  "zh-TW": "zh-TW,zh;q=0.9,en;q=0.8",
  "en-US": "en-US,en;q=0.9",
  "en-GB": "en-GB,en;q=0.9",
  "ru-RU": "ru-RU,ru;q=0.9,en;q=0.8",
  "ja-JP": "ja-JP,ja;q=0.9,en;q=0.8",
  "de-DE": "de-DE,de;q=0.9,en;q=0.8",
  "fr-FR": "fr-FR,fr;q=0.9,en;q=0.8",
  "es-ES": "es-ES,es;q=0.9,en;q=0.8",
  "ko-KR": "ko-KR,ko;q=0.9,en;q=0.8",
};

// rc.1: settings moved into the profile-owned plugin Config. The namespace is the
// composition entry id (the `web-search-free` row the bundle's cordis.patch.yml
// declares), not the old `$DSH_HOME/settings.yaml` section name.
const FREE_SEARCH_NS = "web-search-free";
const BRIDGE_PREFIX = "/api/dsh-free-search-settings";
// apply() 重入保护：见 apply 顶部的注释。
const appliedContexts = new WeakSet();
// 同一条接管/冲突日志在一个进程里只打一次：rc.2 的启动重入会把同样的 warn 刷到 65ms 一条，
// 日志噪音会盖住真正的问题（#82）。
const loggedOnce = new Set();
const logOnce = (log, level, message) => {
  if (loggedOnce.has(message)) return;
  loggedOnce.add(message);
  const sink = level === "warn" ? log?.warn : log?.info;
  if (typeof sink === "function") sink.call(log, message);
};
// 意见 A：zhihu_global / zhihu_site 需要 ZHIHU_API_KEY，不属于免 key 引擎（不得进入 FREE_ENGINES）
const FREE_ENGINES = ["ddg", "ddg-lite", "bing", "searxng", "anysearch"];
const ALL_ENGINES = ["ddg", "ddg-lite", "bing", "searxng", "anysearch", "exa", "tavily", "keenable", "firecrawl", "parallel", "perplexity", "serpbase", "serply", "deepseek-official", "deepseek-tools", "you", "baidu", "kimi", "aliyun", "doubao", "tinyfish", "jina", "zhihu_global", "zhihu_site", "openai", "gemini", "claude"];

// 模型内置搜索（按次计费）：只在你显式选中该引擎时使用；自动回退链与 auto 路由都不会兜底到它们。
const EXPLICIT_ONLY_ENGINES = ["openai", "gemini", "claude"];

// ---- Failure-aware fallback (issue #36) ----
// Not every failure means the same thing. quota/auth are usually recoverable without
// user action (top up quota, transient key rejection), so they back off for a finite
// window instead of the whole worker lifetime; bot-wall backs off for a while;
// transient is retried once on the same engine before advancing; invalid-response is
// our own/upstream schema change and is surfaced as such.
// 以前是 Infinity：一次 429/401 就把引擎钉死在冷却里，直到 worker 重启才可能恢复。
const SESSION_COOLDOWN_MS = (() => {
  const raw = Number(process.env.FREE_SEARCH_AUTH_COOLDOWN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
})();
const BOT_WALL_COOLDOWN_MS = 60_000;
const engineCooldowns = new Map(); // engine -> expiresAt (ms)

// fallbackOn: the set of failure classes that are acceptable reasons to advance to the
// next engine. A class absent from this list aborts the search and surfaces that engine's
// error instead of silently falling back (default: every class, i.e. always fall back).
const FAILURE_CLASSES = ["quota", "auth", "bot-wall", "transient", "invalid-response", "unknown"];
const DEFAULT_FALLBACK_ON = [...FAILURE_CLASSES];
const normalizeFallbackOn = (value) => {
  if (!Array.isArray(value)) return [...DEFAULT_FALLBACK_ON];
  return [...new Set(value.filter((cls) => FAILURE_CLASSES.includes(cls)))];
};

const isCoolingDown = (engine, now = Date.now()) => {
  const until = engineCooldowns.get(engine);
  if (until === undefined) return false;
  if (until > now) return true;
  engineCooldowns.delete(engine);
  return false;
};
const clearCooldown = (engine) => engineCooldowns.delete(engine);
const setCooldown = (engine, ms) => {
  engineCooldowns.set(engine, Date.now() + ms);
};
const applyFailureCooldown = (engine, cls, rateLimited = false) => {
  if (cls === "quota" || cls === "auth") setCooldown(engine, SESSION_COOLDOWN_MS);
  else if (cls === "bot-wall") setCooldown(engine, BOT_WALL_COOLDOWN_MS);
  // 短窗限流（429/rate limit）：60 秒退避，避免下一次搜索立刻再撞（知乎 MCP 等实测存在 RPM 级限流）
  else if (rateLimited) setCooldown(engine, BOT_WALL_COOLDOWN_MS);
};

const classifyFailure = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const m = message.toLowerCase();
  const rateLimited = /\b429\b|rate limit|too many requests|overloaded|slow down/.test(m);
  if (!rateLimited && /no_more_credits|quota\/billing|quota exceeded|out of quota|free quota exhausted|insufficient (credits|balance|quota)|\bbudget\b|\b402\b|payment required/.test(m)) {
    return { class: "quota", message };
  }
  if (/api key is invalid|invalid api key|key is invalid|invalid.*key.*\(http (401|403)\)|unauthorized|\b401\b|\b403\b|not configured|requires [a-z0-9_]+_api_key/.test(m)) {
    return { class: "auth", message };
  }
  if (/anti-bot|captcha|unusual traffic|robot check|rate-limited right now|bot wall|bot-wall/.test(m)) {
    return { class: "bot-wall", message };
  }
  if (rateLimited || /http 5\d\d|timeout|timed out|aborted|abort|fetch failed|econn|network|socket/.test(m)) {
    return { class: "transient", message, rateLimited };
  }
  if (/invalid json|unexpected|parse|empty response|returned 0 results|schema|missing .*field|malformed/.test(m)) {
    return { class: "invalid-response", message };
  }
  return { class: "unknown", message };
};

const FAILURE_CLASS_LABELS = {
  quota: "is out of quota",
  auth: "is misconfigured (API key rejected)",
  "bot-wall": "is rate-limited (anti-bot)",
  transient: "failed (transient)",
  "invalid-response": "returned an invalid response",
  cooldown: "is cooling down",
  unknown: "unavailable or failed",
};


// 支持 time_range 过滤的引擎（zhihu_global：global_search 的 filter 支持 publish_time>=unix秒，已实测；zhihu_site 未验证，不加）
// deepseek-tools：原生搜索端点没有独立时间字段，但 query 语法支持 after:/before:，由 deepseekToolsQuery 注入。
const TIME_ENGINES = ["tavily", "exa", "keenable", "firecrawl", "parallel", "searxng", "ddg", "ddg-lite", "baidu", "doubao", "tinyfish", "deepseek-tools", "zhihu_global"];

// 虚拟搜索模式：不是单个引擎，而是 provider.search 内部的路由/并发策略
const SEARCH_MODES = ["auto", "multi"];

const DEFAULT_FALLBACK_ORDER = ["exa", "tavily", "keenable", "firecrawl", "parallel", "perplexity", "serpbase", "serply", "deepseek-tools", "deepseek-official", "you", "baidu", "kimi", "aliyun", "doubao", "tinyfish", "jina", "bing", "anysearch", "ddg", "ddg-lite", "searxng", "zhihu_global", "zhihu_site"];

function normalizeDisabledEngines(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((engine) => ALL_ENGINES.includes(engine)))];
}

function normalizeFallbackOrder(value) {
  const configured = Array.isArray(value)
    ? value.filter((engine) => ALL_ENGINES.includes(engine))
    : [];
  return [...new Set([...configured, ...DEFAULT_FALLBACK_ORDER, ...ALL_ENGINES.filter((engine) => !EXPLICIT_ONLY_ENGINES.includes(engine))])].filter((engine) => !EXPLICIT_ONLY_ENGINES.includes(engine));
}

function hasCustomFallbackOrder(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  const normalized = normalizeFallbackOrder(value);
  return normalized.length !== DEFAULT_FALLBACK_ORDER.length
    || normalized.some((engine, index) => engine !== DEFAULT_FALLBACK_ORDER[index]);
}

function enabledEngines(disabledEngines, fallbackOrder = []) {
  const disabled = new Set(normalizeDisabledEngines(disabledEngines));
  return normalizeFallbackOrder(fallbackOrder).filter((engine) => !disabled.has(engine));
}

// 智能路由（provider=auto 时启用）：语言/时间规则决定分组；配置了 fallbackOrder 后，分组内按全局优先级排序。
// 语言分池（评审意见 B 恢复）：auto 的 routeHead 与 multi 的并发池按查询语言二选一；
// config.zhPool / config.enPool 分别覆盖两组默认池；设置页各池最低 2 个引擎、不设上限。
const DEFAULT_ZH_POOL = ["bing", "baidu", "aliyun", "anysearch"];
const DEFAULT_EN_POOL = ["bing", "exa", "tavily"];
const isCjkQuery = (query) => /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(String(query ?? ""));

function normalizeLanguagePool(value, fallback) {
  // 显式-only 引擎（openai/gemini/claude，按次计费）永不入池：全池并发会绕过
  // 「只在显式选中时运行」的约定，把这三个的账单变成自动触发（评审意见）。
  const configured = [...new Set((Array.isArray(value) ? value : []).filter((engine) => ALL_ENGINES.includes(engine) && !EXPLICIT_ONLY_ENGINES.includes(engine)))];
  return configured.length > 0 ? configured : [...fallback];
}

function languagePool(query, { zhPool, enPool } = {}) {
  return isCjkQuery(query)
    ? normalizeLanguagePool(zhPool, DEFAULT_ZH_POOL)
    : normalizeLanguagePool(enPool, DEFAULT_EN_POOL);
}

function routeEngines(query, { timeRange, disabledEngines = [], fallbackOrder = [], zhPool, enPool } = {}) {
  const disabled = new Set(normalizeDisabledEngines(disabledEngines));
  const hasCustomOrder = hasCustomFallbackOrder(fallbackOrder);
  const enabled = hasCustomOrder
    ? enabledEngines(disabledEngines, fallbackOrder)
    : ALL_ENGINES.filter((engine) => !disabled.has(engine));
  const enabledSet = new Set(enabled);
  const routeHead = languagePool(query, { zhPool, enPool });
  const head = hasCustomOrder
    ? enabled.filter((engine) => routeHead.includes(engine))
    : routeHead.filter((engine) => enabledSet.has(engine));

  let ordered;
  if (timeRange) {
    const timeHead = head.filter((engine) => TIME_ENGINES.includes(engine));
    const timeOthers = enabled.filter((engine) => TIME_ENGINES.includes(engine) && !head.includes(engine));
    const nonTimeHead = head.filter((engine) => !TIME_ENGINES.includes(engine));
    ordered = [...timeHead, ...timeOthers, ...nonTimeHead];
  } else {
    ordered = [...head];
  }

  const remaining = enabled.filter((engine) => !ordered.includes(engine) && !EXPLICIT_ONLY_ENGINES.includes(engine));
  return [...ordered, ...remaining];
}

// 当前插件版本（发布时与 package.json 同步；跟随上游 v0.7.5，不在 PR 里 bump）
const PLUGIN_VERSION = "0.9.15";
// 检查更新的 npm registry 元数据地址（dsh-free-search 是 npmjs 上的公开包）
const NPM_REGISTRY_URL = "https://registry.npmjs.org/dsh-free-search/latest";
const PLUGIN_NPM_URL = "https://www.npmjs.com/package/dsh-free-search";
const PLUGIN_REPO_URL = "https://github.com/DDDMUC/dsh-free-search";

// 查询 npm registry 的最新版本；失败时返回 null（网络/代理问题不阻塞设置页）
async function fetchLatestVersion(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      headers: { accept: "application/json", "user-agent": "deepseek-harness/free-search" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// 简单的 semver 比较（仅处理 x.y.z 主/次/补丁，忽略预发布标签）；a>b 返回 1, a<b 返回 -1, 相等返回 0
function compareVersions(a, b) {
  const na = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const nb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((na[i] ?? 0) > (nb[i] ?? 0)) return 1;
    if ((na[i] ?? 0) < (nb[i] ?? 0)) return -1;
  }
  return 0;
}

// 检测插件的安装模式：遍历 profiles/*/node_modules/dsh-free-search，
// symlink（link: 本地开发）→ isLink=true；npm 真安装 → isLink=false；找不到 → null
function detectInstallMode() {
  const profilesDir = path.join(process.cwd(), "profiles");
  let found = null;
  try {
    for (const name of fs.readdirSync(profilesDir)) {
      const pkgPath = path.join(profilesDir, name, "node_modules", "dsh-free-search");
      if (!fs.existsSync(pkgPath)) continue;
      let isLink = false;
      try {
        isLink = fs.lstatSync(pkgPath).isSymbolicLink();
      } catch {}
      found = { profileDir: path.join(profilesDir, name), isLink };
      break;
    }
  } catch {}
  return found;
}

// time_range 支持：固定档 day/week/month/year，或自定义（相对 12h/3d/2mo/1y、绝对 YYYY-MM-DD）
const TIME_RANGES = ["day", "week", "month", "year"];
const DAYS_BY_RANGE = { day: 1, week: 7, month: 30, year: 365 };
const KEENABLE_REL = { day: "1d", week: "7d", month: "1mo", year: "1y" };
const SEARXNG_TIME = { day: "day", week: "week", month: "month", year: "year" };

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

// 把用户/agent 给的 timeRange 解析成统一对象：{ days } 相对天数，或 { after } 绝对日期。
// 输入支持：day/week/month/year、12h/3d/2mo/1y、2026-07-01，或已解析的 {days}/{after} 对象。
// 无效返回 undefined。
function parseTimeRange(input) {
  if (input === undefined || input === null) return undefined;
  // 已解析对象：直接透传
  if (typeof input === "object") {
    if (typeof input.after === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.after)) return { after: input.after };
    if (typeof input.days === "number" && Number.isFinite(input.days) && input.days > 0) return { days: input.days };
    return undefined;
  }
  const s = String(input).trim().toLowerCase();
  if (s.length === 0) return undefined;
  if (TIME_RANGES.includes(s)) return { days: DAYS_BY_RANGE[s] };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { after: s };
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(h|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|year|years)$/);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2][0];
    const days =
      unit === "h" ? n / 24 : unit === "d" ? n : unit === "w" ? n * 7 : unit === "m" ? n * 30 : n * 365;
    return { days };
  }
  return undefined;
}

// 把自定义天数映射到只支持固定档的引擎（Tavily / SearXNG / DDG）的最近似档位
function approximateTimeRange(days) {
  if (days <= 2) return "day";
  if (days <= 14) return "week";
  if (days <= 90) return "month";
  return "year";
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

//#region 结果缓存（防限流/省额度，LRU 50 条，TTL 可配置 0-5 分钟）
const CACHE_MAX_ENTRIES = 50;
// #69 §3：整次搜索的总预算（毫秒）。串行回退链与并发 multi 共用同一个数——
// 单引擎各自的超时会累加（8~25s × N），没有这个上限时一次搜索可能拖到分钟级。
const SEARCH_BUDGET_MS = 30000;
// fallback 条目（实际引擎 ≠ 首选引擎时）TTL = 配置 TTL 的 1/5（默认 5 分钟 → 60s）：
// 首选引擎恢复后最多 1 分钟即可拿到新结果，避免回退结果被完整 TTL 钉死；首选成功条目仍用完整 TTL。

function buildCacheKey(query, maxResults, timeRangeLabel, preferred, disabledEngines = [], fallbackOrder = [], blockedDomains = [], multiMaxEngines = 0, multiMinSources = 1) {
  const disabledKey = normalizeDisabledEngines(disabledEngines).slice().sort().join(",");
  const orderKey = normalizeFallbackOrder(fallbackOrder).join(",");
  // #72：黑名单参与 key——改动 blockedDomains 后旧缓存自然失效，不会 5 分钟内仍命中旧结果
  const blockedKey = (Array.isArray(blockedDomains) ? blockedDomains : []).map((d) => String(d).toLowerCase().trim().replace(/^www\./, "")).slice().sort().join(",");
  // #69：multi 上限/目标成功数直接改变跑哪些引擎、结果长什么样，必须进 key
  // （reporter 验收标准明确列了这一条：缓存 key 要考虑任何改变结果语义的新设置）
  const multiKey = [Number(multiMaxEngines) || 0, Number(multiMinSources) || 1].join(":");
  return [query ?? "", maxResults ?? 5, timeRangeLabel ?? "", preferred, disabledKey, orderKey, blockedKey, multiKey].join("\u0000");
}
//#endregion

// 统一的 snippet 清洗：剔除登录/付费墙/订阅等噪音短语，折叠空白，限制长度。
// 只在回退链出口统一应用，各引擎内部不做，避免重复处理。
const SNIPPET_NOISE =
  /\b(sign up|sign in|log in|login|subscribe( to| for)?|member[- ]?only|become a member|create (a )?free account|read more|continue reading|story continues|get started|install (the )?app|view on|medium membership|join \w+ for free|get updates from this writer|stories in your inbox|remember me for|unlock this|free to read|become a patron)\b/gi;

function cleanSnippet(text, max = 300) {
  if (!text) return text;
  return String(text)
    .replace(SNIPPET_NOISE, " ")
    .replace(/^\s*(#{1,6}\s*|\[\s*x?\s*\]\s*|-\s*\[\s*x?\s*\]\s*|>\s*)/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// 各引擎的摘要展示上限：豆包搜索返回的是千字级 Summary（实测 1300-1800 字），放宽到 2000；
// deepseek-tools 的 summary 官方文档写 600~800 字（实测 530），按 300 截断会把摘要拦腰砍断，
// 放宽到 2000 与豆包同理；其余引擎维持 300。
// 该上限同时用于 provider 成功后的清洗与 runEngineTest（喂 multi_search）。
const SNIPPET_MAX_BY_ENGINE = { doubao: 2000, "deepseek-tools": 2000 };
function snippetCap(engine) {
  return SNIPPET_MAX_BY_ENGINE[engine] ?? 300;
}

// 提示注入防护：插件自有工具（advanced_search / platform_search / free_search_test）的
// 网页来源文本统一包进显式「不可信数据」边界，配合系统提示词里的同名说明使用。
// 核心 web_search / web_fetch 由 DSH 核心自带 EXTERNAL_WEB_CONTENT_NOTICE，不在此重复；
// 也不给 source.snippet 本体加标记——同一字符串会原样显示在 DSH 前端的结果卡片里。
const UNTRUSTED_BOUNDARY_OPEN = "<untrusted-web-content>";
const UNTRUSTED_BOUNDARY_CLOSE = "</untrusted-web-content>";
const UNTRUSTED_BOUNDARY_TAG = /<\/?untrusted-web-content>/gi;

// 防伪造：剥掉网页文本里自带的同名边界标记，避免提前闭合边界
function stripBoundaryTags(text) {
  return typeof text === "string" ? text.replace(UNTRUSTED_BOUNDARY_TAG, "") : text;
}

function wrapUntrustedBlock(text) {
  return `${UNTRUSTED_BOUNDARY_OPEN}\n${stripBoundaryTags(text)}\n${UNTRUSTED_BOUNDARY_CLOSE}`;
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function extractDdgUrl(rel) {
  if (!rel) return null;
  const m = rel.match(/uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  if (rel.startsWith("//")) return `https:${rel}`;
  return rel;
}

// #72：收敛前过滤域名黑名单——先剔除被屏蔽条目，再去重 + 截断，
// 因此后面的候选会自动补位（用户得到的是"满员的好结果"，而不是变短的结果）。
function uniqueSources(sources, limit) {
  const blocked = getActiveBlockedDomains();
  const kept = blocked.length ? sources.filter((s) => !isDomainBlocked(s.url, blocked)) : sources;
  const seen = new Set();
  const out = [];
  for (const s of kept) {
    if (s.url && !seen.has(s.url)) {
      seen.add(s.url);
      out.push(s);
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchHtml(url, signal, acceptLang) {
  // 单次请求超时 12s，避免挂起被当成 Connection error
  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, "accept-language": acceptLang ?? activeAcceptLanguage },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`connection error: ${error?.message ?? String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url.split("?")[0]}`);
  }
  const html = await response.text();
  // DuckDuckGo 反爬验证页检测（HTTP 202 或验证关键字）
  if (response.status === 202 || /anomaly|captcha|unusual traffic|robot check/i.test(html.slice(0, 4000))) {
    throw new Error("DuckDuckGo is rate-limited right now (anti-bot challenge, usually temporary) - Bing works");
  }
  return html;
}

// 带重试的抓取：网络错误/空结果时重试，间隔 1.5s，最多 3 次
async function fetchHtmlWithRetry(url, signal, acceptLang) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const html = await fetchHtml(url, signal, acceptLang);
      if (html.length > 500) return html;
      lastError = new Error(`empty response (${html.length} bytes)`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw lastError ?? new Error("fetch failed");
}

async function searchDdgHtml(query, maxResults, options, signal) {
  const params = new URLSearchParams({ q: query });
  if (options?.region) params.set("kl", options.region);
  // DDG 安全搜索：off(adlt=-1) / moderate(adlt=0) / strict(adlt=1)
  const adlt = options?.safeSearch ?? "off";
  params.set("adlt", adlt === "strict" ? "1" : adlt === "moderate" ? "0" : "-1");
  // DDG 时间过滤：df=d/w/m/y（只支持固定档，自定义取近似档）
  if (options?.timeRange) {
    const df = { day: "d", week: "w", month: "m", year: "y" }[approximateTimeRange(options.timeRange.days ?? 7)];
    if (df) params.set("df", df);
  }
  const html = await fetchHtmlWithRetry(`${DDG_HTML_URL}?${params}`, signal);
  const blocks = html.match(/<div class="result results_links[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g) ?? [];
  const sources = [];
  for (const block of blocks) {
    const urlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"/);
    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/);
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/);
    const dateMatch = block.match(/<span[^>]*>\s*([\dT:.+-]+)\s*<\/span>/);
    const url = extractDdgUrl(urlMatch?.[1]);
    if (!url) continue;
    sources.push({
      url,
      ...(titleMatch ? { title: stripTags(titleMatch[1]) } : {}),
      ...(snippetMatch ? { snippet: stripTags(snippetMatch[1]) } : {}),
      ...(dateMatch ? { publishedAt: dateMatch[1] } : {}),
    });
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

async function searchDdgLite(query, maxResults, options, signal) {
  const params = new URLSearchParams({ q: query });
  const adlt = options?.safeSearch ?? "off";
  params.set("adlt", adlt === "strict" ? "1" : adlt === "moderate" ? "0" : "-1");
  // DDG Lite 同样支持 df 时间过滤
  if (options?.timeRange) {
    const df = { day: "d", week: "w", month: "m", year: "y" }[approximateTimeRange(options.timeRange.days ?? 7)];
    if (df) params.set("df", df);
  }
  const html = await fetchHtmlWithRetry(`${DDG_LITE_URL}?${params}`, signal);
  const linkMatches = html.match(/<a[^>]*class=['"]result-link['"][^>]*>[\s\S]*?<\/a>/g) ?? [];
  const snippetMatches = html.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g) ?? [];
  const sources = [];
  for (let i = 0; i < linkMatches.length; i++) {
    const tag = linkMatches[i];
    const hrefMatch = tag.match(/href="([^"]*)"/);
    const titleMatch = tag.match(/class=['"]result-link['"][^>]*>(.*?)<\/a>/);
    if (!hrefMatch) continue;
    const url = extractDdgUrl(hrefMatch[1]);
    if (!url) continue;
    const snippet = snippetMatches[i]?.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/)?.[1];
    sources.push({
      url,
      ...(titleMatch ? { title: stripTags(titleMatch[1]) } : {}),
      ...(snippet ? { snippet: stripTags(snippet) } : {}),
    });
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Bing 在「查询无结果」时会返回一张完全无关的缓存 SERP（<li class="b_algo"> 照常存在，
// 但内容是别的查询/热门页的内容），直接返回等于把垃圾结果喂给模型（issue #38：YouTube、
// 法语微软文档、瑞士基金等都复现过）。这里用「查询 token 与结果文本是否重叠」识别这种页面。
// token 规则：CJK 取 1-2 字组合（二元组），拉丁/数字取长度 >=2 的词。
function queryOverlapTokens(query) {
  const tokens = new Set();
  for (const run of String(query).match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length <= 2) tokens.add(run);
    for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2));
  }
  for (const word of String(query).toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 2) tokens.add(word);
  }
  return [...tokens];
}

function looksRelevant(query, sources) {
  const tokens = queryOverlapTokens(query);
  if (tokens.length === 0) return true; // 纯符号查询无法判定，不拦截
  return sources.some((s) => {
    const hay = `${s.title ?? ""} ${s.snippet ?? ""} ${s.url ?? ""}`.toLowerCase();
    return tokens.some((t) => hay.includes(t.toLowerCase()));
  });
}

// Bing 会把结果 URL 包成 bing.com/ck/a 跳转链接：真实地址在 u 参数（base64url，a1 前缀）
function extractBingUrl(href) {
  if (!href) return href;
  const url = decodeEntities(href); // &amp; -> &
  if (!/^https?:\/\/(www\.)?bing\.com\/ck\/a/i.test(url)) return href;
  try {
    const u = new URL(url).searchParams.get("u");
    if (!u) return href;
    const b64 = u.startsWith("a1") ? u.slice(2) : u;
    const decoded = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

async function searchBing(query, maxResults, options, signal) {
  // mkt：仅显式 bingMarket 才发。默认不发——mkt=zh-CN 在部分地区/线路会返回空 SERP 容器
  // （#71：海外 IP + mkt=zh-CN → b_algo=0），Bing 会按 Accept-Language 自行本地化。
  const profile = LANG_PROFILES[searchLanguage(configLanguage(options))];
  const params = new URLSearchParams({ q: query });
  if (options?.bingMarket) params.set("mkt", options.bingMarket);
  // Accept-Language：显式 bingMarket 时按 market 反推（避免中文 header 污染），否则用 lang 档案
  const acceptLang = options?.bingMarket
    ? (MARKET_TO_LANG[options.bingMarket] ?? activeAcceptLanguage)
    : (profile.acceptLang ?? activeAcceptLanguage);
  const adlt = options?.safeSearch ?? "off";
  if (adlt === "off") params.set("adlt", "off");
  else if (adlt === "moderate") params.set("adlt", "moderate");
  else if (adlt === "strict") params.set("adlt", "strict");
  // 注意（2026-10-13 实测）：Bing 会对可疑出口 IP 间歇性返回约 91KB 的「空 SERP」（b_algo 块数 0），
  // 表现为按请求频率收紧、减少请求后又自行恢复。曾加过「空 SERP 时多试一次」的兜底，但实测
  // 请求数翻倍反而更容易被压死，且根因在出口 IP 而非解析，故撤掉——修法应让 bing 不走可疑代理
  // （启动脚本的 NO_PROXY 排除 .bing.com 即可恢复）。
  const html = await fetchHtmlWithRetry(`${BING_URL}?${params}`, signal, acceptLang);
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  const sources = [];
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/);
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a>[\s\S]*?<\/h2>/);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (!hrefMatch) continue;
    sources.push({
      url: extractBingUrl(hrefMatch[1]),
      ...(titleMatch ? { title: stripTags(titleMatch[1]) } : {}),
      ...(snippetMatch ? { snippet: stripTags(snippetMatch[1]) } : {}),
    });
  }
  // Bing 无结果时会返回无关的缓存页：判为 0 结果，交给统一回退链换下一个引擎
  if (sources.length > 0 && !looksRelevant(query, sources)) {
    return { sources: [], truncated: false };
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

//#region searxng (meta-search, free instances, auto-failover)
const SEARXNG_INSTANCES = [
  "https://opnxng.com",
  "https://priv.au",
  "https://searx.be",
  "https://searx.tiekoetter.com",
  "https://search.inetol.net",
  "https://paulgo.io",
];

async function searchSearxng(query, maxResults, options, signal) {
  const instances = options?.searxngInstances?.length
    ? options.searxngInstances
    : SEARXNG_INSTANCES;
  // 聚合所有实例的失败原因，避免只显示最后一个实例的错误
  const errors = [];
  for (const base of instances) {
    try {
      const params = new URLSearchParams({ q: query, format: "json" });
      // SearXNG 原生支持 time_range 过滤（只支持固定档，自定义取近似档）
      if (options?.timeRange) {
        const tr = SEARXNG_TIME[approximateTimeRange(options.timeRange.days ?? 7)];
        if (tr) params.set("time_range", tr);
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const onAbort = () => ctrl.abort();
      signal?.addEventListener("abort", onAbort);
      const response = await fetch(`${base}/search?${params}`, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json",
          ...(options?.searxngBearerToken ? { authorization: `Bearer ${options.searxngBearerToken}` } : {}),
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!response.ok) {
        errors.push(`${base}: HTTP ${response.status}`);
        continue;
      }
      const data = await response.json().catch(() => null);
      if (!data || !Array.isArray(data.results)) {
        errors.push(`${base}: invalid JSON`);
        continue;
      }
      const sources = data.results
        .filter((r) => r.url)
        .map((r) => ({
          url: r.url,
          ...(r.title ? { title: String(r.title) } : {}),
          ...(r.content ? { snippet: String(r.content) } : {}),
        }));
      if (sources.length > 0) {
        return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
      }
      errors.push(`${base}: 0 results`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${base}: ${message}`);
    }
  }
  // 空实例列表兜底：避免 "all SearXNG instances failed: " 尾巴悬空
  const detail = errors.length > 0 ? errors.join(", ") : "no instances configured";
  // Note 会引用这个错误消息，截断避免 6 实例全挂时刷屏
  throw new Error(`all SearXNG instances failed: ${detail.slice(0, 300)}`);
}
//#endregion

//#region keyless engines (AnySearch / Exa MCP - free, no API key)
const ANYSEARCH_URL = "https://api.anysearch.com/v1/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

// AnySearch: 免费匿名额度（无 key），可选 Bearer key 提额；结构化 JSON 结果
// 401/403：本进程忽略该 key 值（不删除存储），改回匿名免费；不自动清空用户配置
let ignoredAnysearchKey = "";
// 当前请求生效的输出语言（zh / en），由 lang 推导；只有我们自己渲染的文案用它（#92）。
let activeOutputLanguage = "zh";
export function setActiveOutputLanguage(value) {
  activeOutputLanguage = String(value ?? "").trim().toLowerCase() === "zh" ? "zh" : "en";
}
export function getActiveOutputLanguage() {
  return activeOutputLanguage;
}
const ANYSEARCH_KEY_INVALID_NOTE_ZH = "AnySearch key 无效，本次已忽略该 key，改回免费匿名档";
const ANYSEARCH_KEY_INVALID_NOTE_EN = "AnySearch key was rejected; ignored it and used the anonymous tier";
function anysearchKeyNote() {
  return activeOutputLanguage === "zh" ? ANYSEARCH_KEY_INVALID_NOTE_ZH : ANYSEARCH_KEY_INVALID_NOTE_EN;
}

async function searchAnysearch(query, maxResults, signal, apiKey) {
  const trimmedKey = typeof apiKey === "string" ? apiKey.trim() : "";
  // 本进程已判定无效的 key 不再发送；若配置里仍有该值，结果仍带忽略提示
  const keyIgnoredSticky = Boolean(trimmedKey) && trimmedKey === ignoredAnysearchKey;
  const sendKey = trimmedKey && !keyIgnoredSticky ? trimmedKey : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const doFetch = async (key) => {
    const headers = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    return await fetch(ANYSEARCH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, max_results: maxResults ?? 5 }),
      signal: controller.signal,
    });
  };
  let response;
  let keyRejected = false;
  try {
    response = await doFetch(sendKey);
    if ((response.status === 401 || response.status === 403) && sendKey) {
      ignoredAnysearchKey = sendKey;
      keyRejected = true;
      response = await doFetch("");
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`AnySearch request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(keyRejected ? `${anysearchKeyNote()} (HTTP ${response.status})` : `AnySearch API error (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(`AnySearch API error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.code !== 0) throw new Error(`AnySearch API error: ${data.message ?? data.code}`);
  const results = data.data?.results ?? [];
  return {
    sources: results
      .filter((r) => r.url)
      .map((r) => ({
        url: r.url,
        ...(r.title ? { title: String(r.title) } : {}),
        ...(r.snippet ? { snippet: String(r.snippet).slice(0, 300) } : {}),
      })),
    truncated: false,
    ...(keyRejected || keyIgnoredSticky ? { content: anysearchKeyNote() } : {}),
  };
}

// Exa MCP: 匿名公开 MCP（无 key），web_search_exa 工具
async function searchExaMCP(query, maxResults, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    response = await fetch(EXA_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: "web_search_exa", arguments: { query, numResults: maxResults ?? 5 } },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Exa MCP request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) throw new Error(`Exa MCP error (HTTP ${response.status})`);
  const text = await response.text();
  // 解析 SSE 格式：event: message\ndata: {...}
  const lines = text.split("\n");
  let json = null;
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try {
        json = JSON.parse(line.slice(6));
        break;
      } catch {}
    }
  }
  if (!json || json.error) {
    throw new Error(`Exa MCP error: ${json?.error?.message ?? "no data"}`);
  }
  const content = json.result?.content ?? [];
  const sources = [];
  const textBlocks = content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  // 解析 "Title: X\nURL: Y\nPublished: Z\nHighlights:\n..."
  const blocks = textBlocks.split(/\n(?=Title:)/);
  for (const block of blocks) {
    const title = block.match(/^Title: (.+)$/m)?.[1];
    const url = block.match(/^URL: (\S+)$/m)?.[1];
    const published = block.match(/^Published: (.+)$/m)?.[1];
    const highlights = block.split(/^Highlights:$/m)[1]?.split("\n").filter((l) => l.trim() && !l.trim().startsWith("...")).slice(0, 3).join(" ");
    if (!url) continue;
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(highlights ? { snippet: highlights.slice(0, 300) } : {}),
      // 只保留日期形态（ISO 或 YYYY-MM-DD），过滤 "N/A" 等占位符
      ...(published && /^\d{4}-\d{2}-\d{2}/.test(published) ? { publishedAt: published } : {}),
    });
  }
  return { sources, truncated: false };
}
//#endregion

//#region platform search (GitHub / V2EX / Bilibili / Reddit / HN / StackOverflow / Wikipedia / npm)
const PLATFORMS = {
  github: { name: "GitHub" },
  v2ex: { name: "V2EX" },
  bilibili: { name: "Bilibili" },
  reddit: { name: "Reddit" },
  hn: { name: "Hacker News" },
  stackoverflow: { name: "Stack Overflow" },
  wikipedia: { name: "Wikipedia" },
  npm: { name: "npm" },
  youtube: { name: "YouTube" },
  vimeo: { name: "Vimeo" },
  juejin: { name: "掘金" },
  douban: { name: "豆瓣" },
  qiita: { name: "Qiita" },
};

async function searchGithub(query, maxResults, signal) {
  const response = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/vnd.github+json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`GitHub API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.items ?? []).map((item) => ({
      url: item.html_url,
      title: item.full_name ?? item.name,
      snippet: `${item.description ?? ""}${item.stargazers_count ? ` ⭐${item.stargazers_count}` : ""}`.trim(),
    })),
    truncated: false,
  };
}

async function searchV2ex(query, maxResults, signal) {
  const response = await fetch("https://www.v2ex.com/api/topics/hot.json", {
    headers: { "user-agent": USER_AGENT },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`V2EX API error (HTTP ${response.status})`);
  const topics = await response.json();
  const q = query.toLowerCase();
  const matched = Array.isArray(topics)
    ? topics.filter((t) => (t.title ?? "").toLowerCase().includes(q) || (t.content ?? "").toLowerCase().includes(q))
    : [];
  return {
    sources: matched.slice(0, maxResults ?? 5).map((t) => ({
      url: `https://www.v2ex.com/t/${t.id}`,
      title: t.title,
      ...(t.content ? { snippet: String(t.content).slice(0, 200) } : {}),
    })),
    truncated: false,
  };
}

async function searchBilibili(query, maxResults, signal) {
  const response = await fetch(
    `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(query)}`,
    {
      headers: { "user-agent": USER_AGENT, referer: "https://www.bilibili.com" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Bilibili API error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.code !== 0) throw new Error(`Bilibili API error: ${data.message ?? data.code}`);
  const sources = [];
  for (const section of data.data?.result ?? []) {
    for (const item of section.data ?? []) {
      if (!item.arcurl) continue;
      sources.push({
        url: item.arcurl,
        title: item.title ? String(item.title).replace(/<[^>]+>/g, "") : item.bvid,
        ...(item.desc ? { snippet: String(item.desc).slice(0, 200) } : {}),
      });
      if (sources.length >= (maxResults ?? 5)) break;
    }
    if (sources.length >= (maxResults ?? 5)) break;
  }
  return { sources, truncated: false };
}

async function searchReddit(query, maxResults, signal) {
  const response = await fetch(
    `https://old.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=${maxResults ?? 5}&sort=relevance`,
    {
      headers: {
        "user-agent": `${USER_AGENT} (dsh-free-search; contact: github.com/DDDMUC)`,
        accept: "application/json",
      },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Reddit API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.data?.children ?? [])
      .map((c) => c.data)
      .filter((p) => p && p.url)
      .map((p) => ({
        url: p.url,
        title: p.title ?? "",
        ...(p.selftext ? { snippet: String(p.selftext).slice(0, 200) } : {}),
      })),
    truncated: false,
  };
}

async function searchHackerNews(query, maxResults, signal) {
  const response = await fetch(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Hacker News API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.hits ?? [])
      .filter((h) => h.title || h.story_title)
      .map((h) => ({
        // 有外链用外链，纯讨论帖用 HN 讨论页
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        title: h.title ?? h.story_title,
        ...((h.points !== undefined && h.points !== null) || (h.num_comments !== undefined && h.num_comments !== null)
          ? { snippet: `HN discussion · ${h.points ?? 0} points · ${h.num_comments ?? 0} comments` }
          : {}),
      })),
    truncated: false,
  };
}

async function searchStackOverflow(query, maxResults, signal) {
  const response = await fetch(
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${maxResults ?? 5}&filter=!nNPvSNVZJS`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Stack Exchange API error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.error_message) throw new Error(`Stack Exchange API error: ${data.error_message}`);
  return {
    sources: (data.items ?? []).map((it) => ({
      url: it.link,
      title: it.title,
      ...(it.score !== undefined || it.answer_count !== undefined
        ? { snippet: `${it.is_answered ? "✓ answered" : "unanswered"} · score ${it.score ?? 0} · ${it.answer_count ?? 0} answers` }
        : {}),
    })),
    truncated: false,
  };
}

async function searchWikipedia(query, maxResults, signal, lang) {
  const host = `${searchLanguage(lang)}.wikipedia.org`;
  const response = await fetch(
    `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Wikipedia API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.query?.search ?? []).map((s) => ({
      url: `https://${host}/wiki/${encodeURIComponent(String(s.title).replace(/ /g, "_"))}`,
      title: s.title,
      // snippet 含 <span class="searchmatch"> 高亮标签，剥掉
      ...(s.snippet ? { snippet: stripTags(s.snippet).slice(0, 200) } : {}),
    })),
    truncated: false,
  };
}

async function searchNpm(query, maxResults, signal) {
  const response = await fetch(
    `https://registry.npmjs.com/-/v1/search?text=${encodeURIComponent(query)}&size=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`npm registry API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.objects ?? [])
      .map((o) => o.package)
      .filter((p) => p && p.name)
      .map((p) => ({
        url: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
        title: p.name,
        ...((p.description || p.version)
          ? { snippet: `v${p.version ?? "?"}${p.description ? ` — ${String(p.description).slice(0, 160)}` : ""}` }
          : {}),
      })),
    truncated: false,
  };
}

async function searchJuejin(query, maxResults, signal) {
  const response = await fetch(
    `https://api.juejin.cn/search_api/v1/search?query=${encodeURIComponent(query)}&id_type=0&cursor=0&limit=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Juejin API error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.err_no !== 0) throw new Error(`Juejin API error: ${data.err_msg ?? data.err_no}`);
  return {
    sources: (data.data ?? [])
      .map((x) => x.result_model?.article_info)
      .filter((a) => a && a.article_id)
      .map((a) => ({
        url: `https://juejin.cn/post/${a.article_id}`,
        title: a.title ?? "",
        ...(a.brief_content ? { snippet: String(a.brief_content).slice(0, 200) } : {}),
      })),
    truncated: false,
  };
}

// 豆瓣搜索是 HTML（无公开 JSON API）；结果块 `<div class="result">`，链接是 link2 跳转，需解码 url 参数。
// 页面改版即失效（返回空数组），与 so360/sogou 同款取舍。
async function searchDouban(query, maxResults, signal) {
  const response = await fetch(`https://www.douban.com/search?q=${encodeURIComponent(query)}&cat=1001`, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      "accept-language": "zh-CN,zh;q=0.9",
      accept: "text/html,*/*",
    },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`Douban error (HTTP ${response.status})`);
  const html = await response.text();
  const sources = [];
  for (const block of html.split('<div class="result">').slice(1)) {
    const h3 = block.match(/<h3>([\s\S]*?)<\/h3>/);
    if (!h3) continue;
    const a = h3[1].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, "&");
    const wrapped = url.match(/[?&]url=([^&]+)/);
    if (wrapped) { try { url = decodeURIComponent(wrapped[1]); } catch { /* keep the raw link */ } }
    const title = a[2].replace(/<[^>]+>/g, "").trim();
    const info = block.match(/<div class="info">([\s\S]*?)<\/div>/);
    const snippet = info ? info[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";
    if (!url.startsWith("http") || !title) continue;
    sources.push({ url, title, ...(snippet ? { snippet } : {}) });
    if (sources.length >= (maxResults ?? 5)) break;
  }
  return { sources, truncated: false };
}

async function searchQiita(query, maxResults, signal) {
  const response = await fetch(
    `https://qiita.com/api/v2/items?query=${encodeURIComponent(query)}&per_page=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Qiita API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (Array.isArray(data) ? data : []).map((it) => ({
      url: it.url,
      title: it.title ?? "",
      ...(it.body ? { snippet: String(it.body).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) } : {}),
    })),
    truncated: false,
  };
}

async function searchPlatform(platform, query, maxResults, signal, lang) {
  switch (platform) {
    case "github":
      return searchGithub(query, maxResults, signal);
    case "v2ex":
      return searchV2ex(query, maxResults, signal);
    case "bilibili":
      return searchBilibili(query, maxResults, signal);
    case "reddit":
      return searchReddit(query, maxResults, signal);
    case "hn":
      return searchHackerNews(query, maxResults, signal);
    case "stackoverflow":
      return searchStackOverflow(query, maxResults, signal);
    case "wikipedia":
      return searchWikipedia(query, maxResults, signal, lang);
    case "npm":
      return searchNpm(query, maxResults, signal);
    case "youtube":
      return searchYoutube(query, maxResults, signal);
    case "vimeo":
      return searchVimeo(query, maxResults, signal);
    case "juejin":
      return searchJuejin(query, maxResults, signal);
    case "douban":
      return searchDouban(query, maxResults, signal);
    case "qiita":
      return searchQiita(query, maxResults, signal);
    default:
      throw new Error(`unknown platform: ${platform}`);
  }
}
//#endregion

//#region video sources (Bing Videos / DuckDuckGo Videos / YouTube / Vimeo) - keyless scraping
const BING_VIDEOS_URL = "https://www.bing.com/videos/search";
const BING_VIDEOS_ASYNC_URL = "https://www.bing.com/videos/asyncv2";
const YOUTUBE_SEARCH_URL = "https://www.youtube.com/results";
const VIMEO_SEARCH_URL = "https://vimeo.com/search";

// 通用 HTML 抓取（视频源用；跟随重定向，桌面 UA）。失败信息通用，不套 DDG 文案。
async function fetchVideoHtml(url, signal, extraHeaders) {
  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    response = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        "accept-language": activeAcceptLanguage,
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        ...(extraHeaders ?? {}),
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`connection error: ${error?.message ?? String(error)}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.split("?")[0]}`);
  return response.text();
}

// 递归收集对象图里所有 key === searchKey 的值（YouTube ytInitialData 层级常变）
function collectByKey(node, searchKey, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectByKey(item, searchKey, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === searchKey) out.push(v);
      collectByKey(v, searchKey, out);
    }
  }
  return out;
}

// 从 text[start] 的 '{' 起做花括号配对，返回完整 JSON 子串（跳过字符串内的括号）
function sliceBalancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Bing Videos：结果卡片里 <div class="vrhdata" vrhm="{...json...}">。
// 2026-10 改版：静态搜索页不再内嵌结果（vrhm 消失），改用 asyncv2 异步端点（返回 HTML 片段，含 vrhm）。
// json 字段 murl(真实播放地址) / vt(标题) / du(时长) / purl(详情页)（字段语义以实测为准）。
async function searchBingVideos(query, maxResults, options, signal) {
  const params = new URLSearchParams({ q: query, count: String(Math.max(Number(maxResults) || 10, 1)), first: "1", mmasync: "1" });
  const market = options?.bingMarket ?? LANG_PROFILES[searchLanguage(configLanguage(options))].market;
  if (market) params.set("mkt", market);
  const html = await fetchVideoHtml(`${BING_VIDEOS_ASYNC_URL}?${params}`, signal);
  if (/captcha|unusual traffic|robot check/i.test(html.slice(0, 5000))) {
    throw new Error("Bing Videos is rate-limited right now (anti-bot challenge, usually temporary)");
  }
  const sources = [];
  for (const attr of html.match(/vrhm="([^"]*)"/g) ?? []) {
    let meta;
    try {
      meta = JSON.parse(decodeEntities(attr.slice(6, -1)));
    } catch {
      continue;
    }
    const url = meta?.murl;
    if (typeof url !== "string" || !url) continue;
    const metaBits = [meta.du, meta.vd].filter((v) => typeof v === "string" && v.trim());
    sources.push({
      url,
      ...(meta.vt ? { title: stripTags(meta.vt) } : {}),
      ...(metaBits.length ? { snippet: metaBits.join(" · ") } : {}),
    });
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// DuckDuckGo Videos：先取 vqd token，再请求 v.js（返回 {results:[{title,url,content,duration,uploader,image}]}）
async function searchDdgVideos(query, maxResults, signal) {
  const landing = await fetchVideoHtml(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=videos&ia=videos`,
    signal
  );
  const vqdMatch = landing.match(/vqd=["']?([\d-]+)/);
  if (!vqdMatch) throw new Error("DuckDuckGo Videos: could not obtain vqd token");
  const params = new URLSearchParams({ l: "us-en", o: "json", q: query, vqd: vqdMatch[1], f: ",,,", p: "1" });
  const text = await fetchVideoHtml(`https://duckduckgo.com/v.js?${params}`, signal, {
    accept: "application/json, text/javascript, */*",
  });
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("DuckDuckGo Videos: unexpected response");
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("DuckDuckGo Videos: invalid JSON");
  }
  const sources = [];
  for (const item of data.results ?? []) {
    // DDG 改版：真实播放 URL 移到了 content 字段（url 字段已废弃）；保留旧字段回退
    const url = typeof item?.content === "string" && item.content ? item.content : item?.url;
    if (!url) continue;
    const bits = [item.uploader, item.duration, item.published].filter((v) => typeof v === "string" && v.trim());
    sources.push({
      url,
      ...(item.title ? { title: stripTags(item.title) } : {}),
      ...(bits.length ? { snippet: bits.join(" · ") } : {}),
    });
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// YouTube：抓 results 页，解析 ytInitialData 里的 videoRenderer（层级常变 → 递归收集）
async function searchYoutube(query, maxResults, signal) {
  const html = await fetchVideoHtml(`${YOUTUBE_SEARCH_URL}?search_query=${encodeURIComponent(query)}`, signal, {
    "accept-language": "en-US,en;q=0.9",
  });
  const idx = html.indexOf("ytInitialData");
  if (idx < 0) throw new Error("YouTube: ytInitialData not found");
  const brace = html.indexOf("{", idx);
  const jsonText = brace >= 0 ? sliceBalancedObject(html, brace) : null;
  if (!jsonText) throw new Error("YouTube: could not parse ytInitialData");
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error("YouTube: invalid ytInitialData JSON");
  }
  const sources = [];
  for (const vr of collectByKey(data, "videoRenderer")) {
    const id = vr?.videoId;
    if (typeof id !== "string" || !id) continue;
    const title = vr.title?.runs?.[0]?.text ?? vr.title?.simpleText;
    const owner = vr.ownerText?.runs?.[0]?.text ?? vr.longBylineText?.runs?.[0]?.text;
    const bits = [owner, vr.lengthText?.simpleText, vr.viewCountText?.simpleText, vr.publishedTimeText?.simpleText].filter(
      (v) => typeof v === "string" && v.trim()
    );
    sources.push({
      url: `https://www.youtube.com/watch?v=${id}`,
      ...(title ? { title: stripTags(title) } : {}),
      ...(bits.length ? { snippet: bits.join(" · ") } : {}),
    });
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Weather（Open-Meteo）实现已抽至 lib/weather.js（fetchWeather / WEATHER_OUTPUT_SCHEMA /
// sanitizeWeatherResult）；契约由 tools/assert-weather-contract.mjs 离线校验（#73）。

// Vimeo：无官方免 key 搜索 API。尽力抓搜索页里内嵌的 /videos/<id> 数据；
// 抓不到时由调用方退回网页搜索（site:vimeo.com）。
async function searchVimeo(query, maxResults, signal) {
  const html = await fetchVideoHtml(`${VIMEO_SEARCH_URL}?q=${encodeURIComponent(query)}`, signal, {
    "accept-language": "en-US,en;q=0.9",
  });
  const sources = [];
  const seen = new Set();
  const re = /"uri"\s*:\s*"\/videos\/(\d+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const around = html.slice(Math.max(0, m.index - 600), m.index + 200);
    const nameM = around.match(/"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    let title;
    if (nameM) {
      try {
        title = JSON.parse(`"${nameM[1]}"`);
      } catch {
        title = nameM[1];
      }
    }
    sources.push({
      url: `https://vimeo.com/${id}`,
      ...(title ? { title: stripTags(title) } : {}),
    });
    if (sources.length >= (maxResults ?? 10)) break;
  }
  return { sources, truncated: false };
}
//#endregion

//#region paid engines (exa / tavily / perplexity / serpbase / deepseek-official)
async function searchExa(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("Exa search requires EXA_API_KEY");
  const body = {
    query,
    type: "auto",
    contents: { highlights: { highlightsPerUrl: 1 } },
    ...(maxResults !== undefined ? { numResults: maxResults } : {}),
  };
  // Exa 时间过滤：startPublishedDate（ISO 日期；支持任意天数和绝对日期）
  if (timeRange) {
    if (timeRange.after) body.startPublishedDate = timeRange.after;
    else if (timeRange.days !== undefined) body.startPublishedDate = isoDaysAgo(timeRange.days);
  }
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "deepseek-harness/free-search",
    },
    body: JSON.stringify(body),
    // AbortSignal.timeout 是全局定时器，不会像 clearTimeout 那样在读 body 前失效
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(20000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Exa API key is invalid (HTTP 401) - click the engine's status tag in the Free Search window to update it");
    }
    if (response.status === 402) {
      throw new Error(`Exa quota/billing error (HTTP 402) - the key is valid, but its team has no usable credits or hit a usage limit; check usage/credits for the key's team at dashboard.exa.ai. ${detail.slice(0, 200)}`);
    }
    throw new Error(`Exa API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .map((result) => {
      const snippet = result.highlights?.find((h) => h.trim().length > 0);
      if (!snippet) return null;
      return {
        url: result.url,
        ...(result.title ? { title: result.title } : {}),
        snippet,
        ...(result.publishedDate ? { publishedAt: result.publishedDate } : {}),
      };
    })
    .filter(Boolean);
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Tavily: 无 key 走 keyless（免费匿名额度），有 key 走账号档（Bearer）
async function searchTavily(query, maxResults, apiKey, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const body = {
      query,
      max_results: Math.min(maxResults ?? 5, 20),
      search_depth: "basic",
    };
    // Tavily 时间过滤：time_range 只支持固定档，自定义天数取最近似档位
    if (timeRange) {
      const tr = approximateTimeRange(timeRange.days ?? 7);
      if (tr) body.time_range = tr;
    }
    response = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : { "x-tavily-access-mode": "keyless" }),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Tavily request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Tavily API key is invalid (HTTP 401) - click the engine's status tag in the Free Search window to update it");
    }
    throw new Error(`Tavily API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.content ? { snippet: String(r.content).slice(0, 300) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Firecrawl: 无 key 走 keyless（官方免 key 匿名额度），有 key 走账号档（Bearer）
const FIRECRAWL_TBS = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };

// Firecrawl 自定义绝对日期 → Google tbs 语法（cd_min 用 M/D/YYYY）
function formatFirecrawlDate(date) {
  const [y, m, d] = String(date).split("-").map((n) => parseInt(n, 10));
  return `${m}/${d}/${y}`;
}

async function searchFirecrawl(query, maxResults, apiKey, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const body = { query, limit: Math.min(Math.max(maxResults ?? 5, 1), 10) };
    // Firecrawl 时间过滤：tbs 支持固定档（qdr:d/w/m/y）与自定义绝对区间（cdr:1,cd_min:...）
    if (timeRange) {
      if (timeRange.after) {
        body.tbs = `cdr:1,cd_min:${formatFirecrawlDate(timeRange.after)}`;
      } else if (timeRange.days !== undefined) {
        const tr = approximateTimeRange(timeRange.days);
        if (FIRECRAWL_TBS[tr]) body.tbs = FIRECRAWL_TBS[tr];
      }
    }
    response = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Firecrawl request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (!apiKey && isFirecrawlKeylessRefusal(response.status, detail)) {
      markFirecrawlKeylessBlocked();
      throw new Error(
        "Firecrawl keyless tier is blocked from this network (VPN/proxy egress) — set FIRECRAWL_API_KEY to use Firecrawl; cooling down for 6h (cleared automatically if you switch proxy)"
      );
    }
    if (response.status === 401) {
      throw new Error("Firecrawl API key is invalid (HTTP 401) - click the engine's status tag in the Free Search window to update it");
    }
    if (response.status === 429) {
      throw new Error("Firecrawl rate limit exceeded (HTTP 429) - configure FIRECRAWL_API_KEY for higher limits");
    }
    throw new Error(`Firecrawl API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.data?.web ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.description ? { snippet: String(r.description).slice(0, 300) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Parallel: 有 key 走 REST（x-api-key）；无 key 走官方 MCP 免 key。自然语言 objective + search_queries，返回带 excerpts 的结果
async function searchParallel(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("Parallel search requires PARALLEL_API_KEY");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const body = {
      objective: query,
      search_queries: [query],
      mode: "fast",
      advanced_settings: { max_results: Math.min(Math.max(maxResults ?? 5, 1), 20) },
    };
    // Parallel 时间过滤：source_policy.after_date（YYYY-MM-DD，精确）
    if (timeRange) {
      const after =
        timeRange.after ??
        (timeRange.days !== undefined ? isoDaysAgo(timeRange.days).slice(0, 10) : undefined);
      if (after) body.advanced_settings.source_policy = { after_date: after };
    }
    response = await fetch(PARALLEL_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Parallel request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Parallel API key is invalid (HTTP ${response.status}) - click the engine's status tag in the Free Search window to update it`);
    }
    if (response.status === 402) {
      throw new Error(`Parallel quota/billing error (HTTP 402) - check usage/credits at platform.parallel.ai. ${detail.slice(0, 200)}`);
    }
    throw new Error(`Parallel API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => {
      const excerpt = (r.excerpts ?? []).find((e) => String(e).trim().length > 0);
      return {
        url: r.url,
        ...(r.title ? { title: String(r.title) } : {}),
        ...(excerpt ? { snippet: String(excerpt).slice(0, 300) } : {}),
        ...(r.publish_date ? { publishedAt: String(r.publish_date) } : {}),
      };
    });
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Parallel keyless：官方 MCP（search.parallel.ai/mcp）匿名额度，无需 API key。
// 与 REST 的差异：MCP 的 web_search 工具没有 max_results / after_date 参数
// （条数由服务端决定），时间过滤退化为 objective 里的新鲜度提示（软过滤）。
const PARALLEL_MCP_SESSION = (() => {
  let id = "";
  for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
})();

async function searchParallelMCP(query, maxResults, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) controller.abort();
  let text;
  try {
    const after = timeRange
      ? timeRange.after ?? (timeRange.days !== undefined ? isoDaysAgo(timeRange.days).slice(0, 10) : undefined)
      : undefined;
    const objective = after ? `${query} (prefer results published after ${after})` : query;
    const response = await fetch(PARALLEL_MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": "dsh-free-search (+https://github.com/DDDMUC/dsh-free-search)",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "web_search",
          arguments: {
            objective,
            search_queries: [query],
            session_id: PARALLEL_MCP_SESSION,
          },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Parallel MCP error (HTTP ${response.status})`);
    // Keep the timeout and caller cancellation active while the body is streaming.
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Parallel MCP request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  // The shared parser skips SSE notifications and joins multiline data frames.
  const json = parseMcpResponseText(text);
  if (!json) throw new Error("Parallel MCP parse failed: invalid JSON or SSE");
  if (json.error) throw new Error(`Parallel MCP error: ${json.error.message ?? "unknown error"}`);
  if (!Array.isArray(json.result?.content)) throw new Error("Parallel MCP malformed content");
  const blocks = json.result.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text);
  if (json.result?.isError) throw new Error(`Parallel MCP error: ${blocks.join(" ").slice(0, 200) || "tool call failed"}`);
  let payload = null;
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      if (Array.isArray(parsed?.results)) {
        payload = parsed;
        break;
      }
    } catch {}
  }
  if (!payload) throw new Error("Parallel MCP malformed search results");
  const sources = payload.results
    .filter((r) => r.url)
    .map((r) => {
      const excerpt = (r.excerpts ?? []).find((e) => String(e).trim().length > 0);
      return {
        url: r.url,
        ...(r.title ? { title: String(r.title) } : {}),
        ...(excerpt ? { snippet: String(excerpt).slice(0, 300) } : {}),
        ...(r.publish_date ? { publishedAt: String(r.publish_date) } : {}),
      };
    });
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// 把任意天数转成 Keenable 的相对时间格式（12h / Nd / Nmo / Ny）
function formatKeenableRelative(days) {
  if (days <= 0.5) return "12h";
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

// Keenable: 有 key 走 REST API（X-API-Key），无 key 走 keyless MCP（免费匿名额度）
function extractKeenableSources(text, maxResults) {
  const sources = [];
  const blocks = String(text).split(/\n(?=Title:)/);
  for (const block of blocks) {
    const title = block.match(/^Title: (.+)$/m)?.[1];
    const url = block.match(/^URL: (\S+)$/m)?.[1];
    const published = block.match(/^Published: (.+)$/m)?.[1] ?? block.match(/^Acquired: (.+)$/m)?.[1];
    const snippets = block.split(/^Snippets:$/m)[1]?.split("\n").filter((l) => l.trim()).slice(0, 3).join(" ");
    if (!url) continue;
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(snippets ? { snippet: snippets.slice(0, 300) } : {}),
      // 与 Exa MCP 一致：只保留日期形态，过滤 "N/A" 等占位符
      ...(published && /^\d{4}-\d{2}-\d{2}/.test(published) ? { publishedAt: published } : {}),
    });
  }
  return uniqueSources(sources, maxResults ?? 10);
}

async function searchKeenableREST(query, maxResults, apiKey, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const body = { query, mode: "realtime" };
    // Keenable 时间过滤：published_after（相对 12h/7d/1mo/1y 或绝对 YYYY-MM-DD）
    if (timeRange) {
      if (timeRange.after) body.published_after = timeRange.after;
      else if (timeRange.days !== undefined) body.published_after = formatKeenableRelative(timeRange.days);
    }
    response = await fetch(KEENABLE_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Keenable request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Keenable API key is invalid (HTTP 401) - click the engine's status tag in the Free Search window to update it");
    }
    throw new Error(`Keenable API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.snippet ?? r.description ? { snippet: String(r.snippet ?? r.description).slice(0, 300) } : {}),
      ...(r.published_at ? { publishedAt: String(r.published_at) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

async function searchKeenableMCP(query, maxResults, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const arguments_ = { query };
    // Keenable MCP 支持 published_after（相对或绝对日期）
    if (timeRange) {
      if (timeRange.after) arguments_.published_after = timeRange.after;
      else if (timeRange.days !== undefined) arguments_.published_after = formatKeenableRelative(timeRange.days);
    }
    response = await fetch(KEENABLE_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: "search_web_pages", arguments: arguments_ },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Keenable MCP request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) throw new Error(`Keenable MCP error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.error) throw new Error(`Keenable MCP error: ${data.error?.message ?? "unknown"}`);
  const content = data.result?.content ?? [];
  // isError=true 时 content 里是错误文本
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (data.result?.isError) throw new Error(`Keenable MCP error: ${text.slice(0, 200)}`);
  return { sources: extractKeenableSources(text, maxResults ?? 10), truncated: false };
}

async function searchKeenable(query, maxResults, apiKey, timeRange, signal) {
  if (apiKey) return searchKeenableREST(query, maxResults, apiKey, timeRange, signal);
  return searchKeenableMCP(query, maxResults, timeRange, signal);
}

async function searchPerplexity(query, maxResults, apiKey, signal) {
  if (!apiKey) throw new Error("Perplexity search requires PERPLEXITY_API_KEY");
  // 内置 20s 超时（与外部 signal 组合）：调用方不传 signal 时也不会永久卡住
  const response = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      max_tokens: 1024,
      messages: [{ role: "user", content: query }],
    }),
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(20000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Perplexity API key is invalid (HTTP 401) - click the engine's status tag in the Free Search window to update it");
    }
    throw new Error(`Perplexity API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const answer = data.choices?.[0]?.message?.content ?? "";
  const citations = data.citations ?? [];
  const sources = citations.map((url) => ({ url, ...(answer ? { snippet: answer.slice(0, 200) } : {}) }));
  return {
    content: answer,
    sources: uniqueSources(sources, maxResults ?? 10),
    truncated: false,
  };
}

async function searchDeepSeekOfficial(query, maxResults, apiKey, signal) {
  if (!apiKey) throw new Error("DeepSeek search requires DEEPSEEK_API_KEY");
  // 内置 20s 超时（与外部 signal 组合）：调用方不传 signal 时也不会永久卡住
  const response = await fetch("https://api.deepseek.com/anthropic/v1/messages", {
    method: "POST",
    redirect: "error",
    headers: {
      "x-api-key": apiKey,
      authorization: `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "deepseek-harness/free-search",
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `Perform a web search for the query: ${query}` }],
        },
      ],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    }),
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(20000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("DeepSeek API key is invalid (HTTP 401) - click the engine's status tag in the Free Search window to update it");
    }
    throw new Error(`DeepSeek API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const blocks = data.content ?? [];
  const resultBlocks = blocks.filter((block) => block.type === "web_search_tool_result");
  const snippets = new Map();
  for (const block of blocks) {
    if (block.type !== "text") continue;
    for (const cite of block.citations ?? []) {
      if (cite.url && cite.cited_text && !snippets.has(cite.url)) snippets.set(cite.url, cite.cited_text);
    }
  }
  const sources = [];
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== "web_search_result" || !item.url) continue;
      if (sources.some((s) => s.url === item.url)) continue;
      sources.push({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(snippets.get(item.url) ? { snippet: snippets.get(item.url) } : {}),
        ...(item.page_age ? { publishedAt: item.page_age } : {}),
      });
    }
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// DeepSeek 官方原生搜索 API（POST /v1/tools/search）
// key = DEEPSEEK_API_KEY（与 deepseek-official 共用，接口不同）
//
// 与 deepseek-official 的区别：那一档走 Anthropic Messages +
// `web_search_20250305` 服务端工具，每次搜索是一个完整模型轮次（慢、耗 token、
// 结果要从 web_search_tool_result 块里再解析）；这一档直接调原生搜索端点，
// 无模型参与，返回结构化 results[]。实测同 query 下 ~0.3s vs ~5-6s。
//
// 计费按「请求次数」而非条数（count 不影响单价），所以这里超额取数不增加成本。
const DEEPSEEK_TOOLS_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";

// 原生搜索接口没有独立的时间字段，时间过滤写在 query 语法里（after:/before:）。
// 支持 `after:2025`、`after:2025-01-01`；这里把统一的 timeRange 映射成 after:。
function deepseekToolsQuery(query, timeRange) {
  const parsed = parseTimeRange(timeRange);
  if (!parsed) return query;
  if (parsed.after) return `${query} after:${parsed.after}`;
  if (parsed.days) {
    const since = new Date(Date.now() - parsed.days * 86400000).toISOString().slice(0, 10);
    return `${query} after:${since}`;
  }
  return query;
}

async function searchDeepSeekTools(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("DeepSeek search requires DEEPSEEK_API_KEY");
  const limit = Math.min(Math.max(maxResults ?? 5, 1), 50);
  // 超额取数：按请求计费，且缺 url 的行会被丢弃，多取一些补位成本为零
  const count = Math.min(50, Math.max(limit, Math.ceil(limit * 1.5)));

  const response = await fetch(DEEPSEEK_TOOLS_SEARCH_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "deepseek-harness/free-search",
    },
    body: JSON.stringify({ query: deepseekToolsQuery(query, timeRange), count }),
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(20000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("DeepSeek API key is invalid (HTTP 401) - click the engine's status tag in the Free Search window to update it");
    }
    // 402 余额不足是终态：不要当成可重试的暂时故障
    if (response.status === 402) {
      throw new Error("DeepSeek account balance is insufficient (HTTP 402) - top up at https://platform.deepseek.com");
    }
    throw new Error(`DeepSeek API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  const rows = Array.isArray(data?.results) ? data.results : [];
  const sources = rows
    .filter((r) => r && typeof r.url === "string" && r.url.length > 0)
    .map((r) => {
      // summary（600~800 字，面向模型）优先于 snippet（100~200 字，面向渲染）
      const raw = typeof r.summary === "string" && r.summary.trim() ? r.summary : r.snippet;
      const snippet = typeof raw === "string" ? raw.trim() : "";
      return {
        url: r.url,
        ...(r.title ? { title: String(r.title) } : {}),
        ...(snippet ? { snippet: snippet.slice(0, 600) } : {}),
        // date 是 UTC RFC3339，只保留日期部分与其它引擎的 publishedAt 对齐
        ...(r.date ? { publishedAt: String(r.date).slice(0, 10) } : {}),
      };
    });
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// SerpBase: 必须配置 SERPBASE_API_KEY（无 key 跳过，同 perplexity）
// Google SERP API：POST + X-API-Key 头，返回 organic[]（title/link/snippet/published_at）。
// 注意：SerpBase 始终返回 HTTP 200，业务状态放在 JSON 的 status 字段（0=成功，1001=key 无效/缺失，1000=请求非法）。
const SERPBASE_LOCALE = {
  zh: { hl: "zh-CN", gl: "cn" },
  en: { hl: "en", gl: "us" },
  ru: { hl: "ru", gl: "ru" },
  ja: { hl: "ja", gl: "jp" },
  de: { hl: "de", gl: "de" },
  fr: { hl: "fr", gl: "fr" },
  es: { hl: "es", gl: "es" },
  ko: { hl: "ko", gl: "kr" },
};

async function searchSerpbase(query, maxResults, apiKey, options, signal) {
  if (!apiKey) throw new Error("SerpBase search requires SERPBASE_API_KEY");
  // hl/gl 跟随设置页的 lang（SerpBase 支持 Google 的 hl/gl 本地化），默认 en/us
  const locale = SERPBASE_LOCALE[options?.lang] ?? SERPBASE_LOCALE.en;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    response = await fetch(SERPBASE_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        "X-API-Key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "deepseek-harness/free-search",
      },
      body: JSON.stringify({ q: query, hl: locale.hl, gl: locale.gl, page: 1 }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`SerpBase request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`SerpBase API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  // HTTP 200 + status 字段：0 成功 / 1001 key 无效或缺 / 1000 请求非法
  const data = await response.json();
  if (data.status !== 0) {
    if (data.status === 1001) {
      throw new Error("SerpBase API key is invalid or missing (status 1001) - click the engine's status tag in the Free Search window to update it");
    }
    throw new Error(`SerpBase API error (status ${data.status}): ${String(data.error ?? "").slice(0, 200)}`);
  }
  const sources = (data.organic ?? [])
    .filter((r) => r.link)
    .map((r) => ({
      url: r.link,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.snippet ? { snippet: String(r.snippet) } : {}),
      ...((r.published_at ?? r.date) ? { publishedAt: String(r.published_at ?? r.date) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Serply: 必须配置 SERPLY_API_KEY（无 key 跳过，同 serpbase）
// Google SERP API：GET + X-Api-Key 头，返回 results[]（title/link/description）；num 上限 10。
// 错误走 HTTP 状态码，401 时 JSON 为 {"detail": "Invalid API key"}。
async function searchSerply(query, maxResults, apiKey, options, signal) {
  if (!apiKey) throw new Error("Serply search requires SERPLY_API_KEY");
  // hl/gl 跟随设置页的 lang，与 SerpBase 同一套 Google 本地化参数，默认 en/us
  const locale = SERPBASE_LOCALE[options?.lang] ?? SERPBASE_LOCALE.en;
  const params = new URLSearchParams({
    q: query,
    num: String(Math.min(Math.max(maxResults ?? 10, 1), 10)),
    hl: locale.hl,
    gl: locale.gl,
  });
  const response = await fetch(`${SERPLY_URL}?${params}`, {
    method: "GET",
    redirect: "error",
    headers: {
      "X-Api-Key": apiKey,
      accept: "application/json",
      "user-agent": "deepseek-harness/free-search",
    },
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(15000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Serply API key is invalid (HTTP ${response.status}) - click the engine's status tag in the Free Search window to update it`);
    }
    throw new Error(`Serply API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .filter((r) => r.link)
    .map((r) => ({
      url: r.link,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.description ? { snippet: String(r.description) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// You.com：无 key 走免 key 档（api.you.com/v1/agents/search，每天 100 次），有 key 走官方 Search API（X-API-Key）。
// key 读取 YDC_API_KEY（标准名），旧名 YOUCOM_API_KEY 继续兼容，见 resolveYoucomApiKey。
async function searchYoucom(query, maxResults, apiKey, signal) {
  // 两档参数相同：GET + query 参数；count 为每段条数上限
  const params = new URLSearchParams({ query, count: String(Math.min(maxResults ?? 10, 20)) });
  const keyed = Boolean(apiKey);
  const response = await fetch(`${keyed ? YOUCOM_URL : YOUCOM_FREE_URL}?${params}`, {
    method: "GET",
    redirect: "error",
    headers: {
      ...(keyed ? { "X-API-Key": apiKey } : {}),
      accept: "application/json",
      "user-agent": "deepseek-harness/free-search",
    },
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(15000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (keyed && (response.status === 401 || response.status === 403)) {
      throw new Error(`You.com API key is invalid (HTTP ${response.status}) - click the engine's status tag in the Free Search window to update it`);
    }
    if (response.status === 402) {
      throw new Error(`You.com quota/billing error (HTTP 402) - check usage at you.com/platform/api-keys. ${detail.slice(0, 200)}`);
    }
    if (response.status === 429) {
      if (!keyed) {
        throw new Error(`You.com free tier rate limit exceeded (HTTP 429) - set YDC_API_KEY for higher limits: ${YOUCOM_KEYS_LINK}`);
      }
      throw new Error("You.com rate limit exceeded (HTTP 429) - check your plan at you.com/platform/api-keys");
    }
    throw new Error(`You.com API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  // 响应：{ results: { web: [ { url, title, snippets: [...], description } ] } }
  const hits = data.results?.web ?? [];
  const sources = hits
    .filter((r) => r.url)
    .map((r) => {
      const snippet = Array.isArray(r.snippets)
        ? r.snippets.filter((s) => typeof s === "string" && s).join(" ")
        : (r.description ?? "");
      return {
        url: r.url,
        ...(r.title ? { title: String(r.title) } : {}),
        ...(snippet ? { snippet: String(snippet).slice(0, 300) } : {}),
      };
    });
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// You.com key 解析（纯函数，便于断言）：凭据中心 YDC_API_KEY → 凭据中心 YOUCOM_API_KEY → 设置页 youcomApiKey
// → 环境变量 YDC_API_KEY → 环境变量 YOUCOM_API_KEY。与其它引擎一样凭据中心优先；旧名只是别名，已有配置不受影响。
const YOUCOM_KEY_REFS = ["YDC_API_KEY", "YOUCOM_API_KEY"];
async function resolveYoucomApiKey({ resolveCredential, settingsValue, env } = {}) {
  if (resolveCredential) {
    for (const ref of YOUCOM_KEY_REFS) {
      const value = await resolveCredential(ref);
      if (value) return value;
    }
  }
  if (settingsValue) return settingsValue;
  for (const ref of YOUCOM_KEY_REFS) {
    if (env?.[ref]) return env[ref];
  }
  return "";
}

// TinyFish Search（api.search.tinyfish.ai）：GET + X-API-Key；免费 12000 请求/天。
// 支持 after_date / before_date（YYYY-MM-DD）时间过滤。
async function searchTinyfish(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("TinyFish search requires TINYFISH_API_KEY");
  const params = new URLSearchParams({ query });
  if (timeRange) {
    if (timeRange.after) {
      params.set("after_date", timeRange.after);
    } else if (timeRange.days !== undefined) {
      params.set("after_date", new Date(Date.now() - timeRange.days * 86400000).toISOString().slice(0, 10));
    }
  }
  const response = await fetch(`${TINYFISH_URL}?${params}`, {
    method: "GET",
    redirect: "error",
    headers: {
      "X-API-Key": apiKey,
      accept: "application/json",
      "user-agent": "deepseek-harness/free-search",
    },
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(15000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(`TinyFish API key is invalid (HTTP ${response.status}) - click the engine's status tag in the Free Search window to update it`);
    }
    if (response.status === 429) {
      throw new Error("TinyFish rate limit exceeded (HTTP 429) - free tier is 30 req/min, 500 req/hour");
    }
    throw new Error(`TinyFish API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  // 响应：{ query, results: [ { position, site_name, title, snippet, url } ], total_results, page }
  const sources = (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.snippet ? { snippet: String(r.snippet).slice(0, 300) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Jina Search（s.jina.ai）：GET + Bearer；需 JINA_API_KEY。
async function searchJina(query, maxResults, apiKey, signal) {
  if (!apiKey) throw new Error("Jina search requires JINA_API_KEY");
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`${JINA_URL}?${params}`, {
    method: "GET",
    redirect: "error",
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      "user-agent": "deepseek-harness/free-search",
    },
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(20000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Jina API key is invalid (HTTP ${response.status}) - click the engine's status tag in the Free Search window to update it`);
    }
    if (response.status === 429) {
      throw new Error("Jina rate limit exceeded (HTTP 429) - check your plan at jina.ai");
    }
    throw new Error(`Jina API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  // 响应：{ code, status, data: [ { title, url, description, content } ] }
  const sources = (data.data ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.description ? { snippet: String(r.description).slice(0, 300) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// 百度千帆 AI 搜索（v2/ai_search/web_search）
// key = 环境变量 BAIDU_API_KEY
async function searchBaidu(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("Baidu search requires BAIDU_API_KEY");
  const count = Math.min(Math.max(maxResults ?? 10, 1), 50);
  const searchFilter = {};
  if (timeRange) {
    const now = new Date();
    const end = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
    let start;
    if (timeRange.after) {
      start = timeRange.after;
    } else if (timeRange.days !== undefined) {
      start = new Date(now.getTime() - timeRange.days * 86400000).toISOString().slice(0, 10);
    }
    if (start) {
      searchFilter.range = { page_time: { gte: start, lt: end } };
    }
  }

  const body = {
    messages: [{ content: query, role: "user" }],
    search_source: "baidu_search_v2",
    resource_type_filter: [{ type: "web", top_k: count }],
    search_filter: searchFilter,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    response = await fetch("https://qianfan.baidubce.com/v2/ai_search/web_search", {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "X-Appbuilder-From": "openclaw",
        "user-agent": "deepseek-harness/free-search",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Baidu search request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Baidu API key is invalid (HTTP ${response.status}) - click the engine's status tag in the Free Search window to update it`);
    }
    throw new Error(`Baidu API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }

  const results = await response.json();
  if (results.code) {
    throw new Error(`Baidu API error: ${results.message ?? JSON.stringify(results)}`);
  }

  const sources = (results.references ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.content ? { snippet: String(r.content).slice(0, 300) } : {}),
      ...(r.date ? { publishedAt: String(r.date) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Kimi (Moonshot) 开放平台联网搜索 basic (/v1/tools/search)
// key = MOONSHOT_API_KEY
async function searchKimi(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("Kimi search requires MOONSHOT_API_KEY");
  const limit = Math.min(Math.max(maxResults ?? 5, 1), 20);
  const body = {
    text_query: query,
    limit,
    timeout_seconds: 30,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    response = await fetch("https://api.moonshot.cn/v1/tools/search", {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "user-agent": "deepseek-harness/free-search",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Kimi search request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Kimi API key is invalid (HTTP ${response.status}) - click the engine's status tag in the Free Search window to update it`);
    }
    throw new Error(`Kimi API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  const sources = (data.search_results ?? [])
    .filter((r) => r.url)
    .map((r) => {
      let snippet = "";
      if (Array.isArray(r.chunks) && r.chunks.length > 0) {
        // chunks 是 [{ text }]（Basic 档位返回的正文片段），不是字符串数组
        snippet = r.chunks
          .map((c) => (typeof c === "string" ? c : c && typeof c.text === "string" ? c.text : ""))
          .filter(Boolean)
          .join(" ");
      } else if (r.snippet) {
        snippet = String(r.snippet);
      }
      return {
        url: r.url,
        ...(r.title ? { title: String(r.title) } : {}),
        ...(snippet ? { snippet: snippet.slice(0, 300) } : {}),
        ...(r.publish_date ? { publishedAt: String(r.publish_date) } : {}),
      };
    });
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// 阿里云百炼 EnhancedSearch MCP (search_pro)
// key = DASHSCOPE_API_KEY
async function searchAliyun(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("Aliyun search requires DASHSCOPE_API_KEY");
  const trimmed = String(query).trim();
  const q = trimmed.length < 2 ? `${trimmed} ` : trimmed.slice(0, 500);

  const rpcBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_pro",
      arguments: { query: q },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    response = await fetch("https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp", {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": "deepseek-harness/free-search",
      },
      body: JSON.stringify(rpcBody),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Aliyun search request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Aliyun API key is invalid (HTTP ${response.status}) - click the engine's status tag in the Free Search window to update it`);
    }
    throw new Error(`Aliyun API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }

  const rawText = await response.text();
  let envelope;
  try {
    envelope = JSON.parse(rawText);
  } catch {
    // 处理可能的 SSE 帧 (data: { ... })
    const dataLine = rawText.split("\n").find((l) => l.startsWith("data:"));
    if (dataLine) {
      try {
        envelope = JSON.parse(dataLine.slice(5).trim());
      } catch (e) {
        throw new Error(`Aliyun MCP response SSE parse failed: ${rawText.slice(0, 200)}`);
      }
    } else {
      throw new Error(`Aliyun MCP response is not valid JSON: ${rawText.slice(0, 200)}`);
    }
  }

  if (envelope.error) {
    throw new Error(`Aliyun MCP error ${envelope.error.code}: ${envelope.error.message}`);
  }

  const callResult = envelope.result;
  if (!callResult || typeof callResult !== "object") {
    throw new Error(`Aliyun MCP result missing: ${JSON.stringify(envelope).slice(0, 200)}`);
  }
  if (callResult.isError) {
    throw new Error(`Aliyun tool error: ${JSON.stringify(callResult).slice(0, 200)}`);
  }

  const contents = callResult.content;
  if (!Array.isArray(contents) || contents.length === 0) {
    return { sources: [], truncated: false };
  }
  const textItem = contents.find((c) => c && c.type === "text" && typeof c.text === "string");
  if (!textItem) {
    return { sources: [], truncated: false };
  }

  let inner;
  try {
    inner = JSON.parse(textItem.text);
  } catch (err) {
    throw new Error(`Aliyun inner content JSON parse error: ${textItem.text.slice(0, 200)}`);
  }

  const pages = inner.pages;
  if (!Array.isArray(pages)) {
    return { sources: [], truncated: false };
  }

  const sources = pages
    .filter((p) => p && p.url)
    .map((p) => ({
      url: p.url,
      ...(p.title ? { title: String(p.title) } : {}),
      ...(p.snippet ? { snippet: String(p.snippet).slice(0, 300) } : {}),
      ...(p.published_at ? { publishedAt: String(p.published_at) } : {}),
    }));

  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}


// ── 知乎开放平台 MCP（developer.zhihu.com/api/mcp/v1）─────────────────────────
// 两个引擎共用一套 MCP 适配器（lib/mcp_adapter.js，方案 v4.3 §2.7）：
//   zhihu_global → tools/call global_search（全网，filter 支持 publish_time>=unix秒 → 入 TIME_ENGINES）
//   zhihu_site   → tools/call zhihu_search（站内，未验证时间过滤 → 不入 TIME_ENGINES）
// 服务端为无状态 streamable-http：实测直连 tools/call 即可（initialize 非必需，也无 session 头），
// 响应可能是纯 JSON 或 SSE 帧——两种格式由适配器统一解析。
// key = ZHIHU_API_KEY（凭据中心 → 本条目 config zhihuApiKey → 环境变量，三级解析；无 key 时引擎跳过不阻断回退链）
function zhihuMcpHeaders(apiKey) {
  return {
    authorization: `Bearer ${apiKey}`,
    "user-agent": "deepseek-harness/free-search",
  };
}

// CallToolResult.content[0].text 内层 JSON → sources；{code:!=0} 与解析失败都算失败（不当搜索结果）
function zhihuToSources(result, maxResults) {
  const text = mcpContentText(result);
  if (!text) return { sources: [], truncated: false };
  let inner;
  try {
    inner = JSON.parse(text);
  } catch {
    throw new Error(`Zhihu inner content JSON parse error: ${text.slice(0, 200)}`);
  }
  if (inner && typeof inner.code === "number" && inner.code !== 0) {
    throw new Error(`Zhihu API error ${inner.code}: ${inner.message ?? JSON.stringify(inner).slice(0, 200)}`);
  }
  const items = inner?.data?.items;
  if (!Array.isArray(items)) return { sources: [], truncated: false };
  const sources = items
    .filter((it) => it && it.url)
    .map((it) => ({
      url: stripZhihuTracking(String(it.url)),
      ...(it.title ? { title: String(it.title) } : {}),
      ...(it.summary ? { snippet: String(it.summary) } : {}),
      ...(Number.isFinite(it.edit_time) && it.edit_time > 0
        ? { publishedAt: new Date(it.edit_time * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") }
        : {}),
      ...(it.author_name ? { author: String(it.author_name) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

async function searchZhihuGlobal(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("Zhihu search requires ZHIHU_API_KEY");
  const count = Math.min(Math.max(maxResults ?? 10, 1), 20);
  const arguments_ = { query: String(query).slice(0, 100), count, search_db: "all" };
  if (timeRange) {
    // 已验证原生时间过滤：filter 表达式 publish_time>=<unix秒>；{days} 相对 / {after} 绝对日期都折算成秒
    const afterMs = timeRange.after
      ? Date.parse(`${timeRange.after}T00:00:00Z`)
      : Date.now() - (timeRange.days ?? 1) * 86_400_000;
    if (Number.isFinite(afterMs)) arguments_.filter = `publish_time>=${Math.floor(afterMs / 1000)}`;
  }
  const result = await mcpCall(ZHIHU_MCP_URL, zhihuMcpHeaders(apiKey), "tools/call", {
    name: "global_search",
    arguments: arguments_,
  }, { timeoutMs: 20000, signal, label: "Zhihu" });
  return zhihuToSources(result, maxResults);
}

async function searchZhihuSite(query, maxResults, apiKey, signal) {
  if (!apiKey) throw new Error("Zhihu search requires ZHIHU_API_KEY");
  const count = Math.min(Math.max(maxResults ?? 10, 1), 20);
  const result = await mcpCall(ZHIHU_MCP_URL, zhihuMcpHeaders(apiKey), "tools/call", {
    name: "zhihu_search",
    arguments: { query: String(query).slice(0, 100), count },
  }, { timeoutMs: 20000, signal, label: "Zhihu" });
  return zhihuToSources(result, maxResults);
}


// ── 模型内置联网搜索（OpenAI / Gemini / Claude）──────────────────────────────
// 这三个走"模型 + 服务端搜索工具"：由模型执行搜索并返回引用，按次/按 token 计费，
// 因此只在用户显式选中该引擎时运行（见 EXPLICIT_ONLY_ENGINES）。模型名与 Base URL
// 都可配置，便于走兼容网关。

const OPENAI_DEFAULT_MODEL = "gpt-6-luna";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

function openaiResponsesUrl(baseUrl) {
  const base = (typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return base.endsWith("/responses") ? base : base + "/responses";
}

// OpenAI 给引用链接追加 utm_source=openai、知乎开放平台挂 utm_medium/openapi_platform：
// 统一走 lib/url_norm.js 的 stripTrackingParams（#69 §4 的唯一权威实现），
// 不再各写一份——两处旧实现只在自己引擎适配器里生效，管不到 multi 合并阶段。
function stripOpenaiTracking(url) {
  return stripTrackingParams(url);
}
function stripZhihuTracking(url) {
  return stripTrackingParams(url);
}

async function searchOpenai(query, maxResults, apiKey, options, signal) {
  if (!apiKey) throw new Error("OpenAI search requires OPENAI_API_KEY");
  const model = (typeof options?.openaiModel === "string" && options.openaiModel.trim()) || OPENAI_DEFAULT_MODEL;
  const response = await fetch(openaiResponsesUrl(options?.openaiBaseUrl), {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + apiKey,
      "user-agent": "deepseek-harness/free-search",
    },
    body: JSON.stringify({ model, input: String(query), tools: [{ type: "web_search" }] }),
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(45000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error("OpenAI API key is invalid (HTTP " + response.status + ") - click the engine's status tag in the Free Search window to update it");
    }
    if (response.status === 429) {
      throw new Error("OpenAI rate limit or quota exceeded (HTTP 429) - check your OpenAI usage/limits");
    }
    throw new Error("OpenAI search API error (HTTP " + response.status + "): " + detail.slice(0, 200));
  }
  const data = await response.json();
  if (data?.error) {
    throw new Error("OpenAI response failed: " + (data.error.message ?? JSON.stringify(data.error).slice(0, 200)));
  }
  // citations 以 url_citation annotation 的形式挂在 message 的 output_text 上
  const sources = [];
  for (const item of data.output ?? []) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      const text = typeof part?.text === "string" ? part.text : "";
      for (const annotation of part?.annotations ?? []) {
        if (annotation?.type !== "url_citation" || typeof annotation.url !== "string" || !annotation.url) continue;
        sources.push({
          url: stripOpenaiTracking(annotation.url),
          ...(annotation.title ? { title: String(annotation.title) } : {}),
          ...(text.trim() ? { snippet: stripTags(text).slice(0, 300) } : {}),
        });
      }
    }
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";
const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function geminiInteractionsUrl(baseUrl) {
  const base = (typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return base.endsWith("/interactions") ? base : base + "/interactions";
}

async function searchGemini(query, maxResults, apiKey, options, signal) {
  if (!apiKey) throw new Error("Gemini search requires GEMINI_API_KEY");
  const model = (typeof options?.geminiModel === "string" && options.geminiModel.trim()) || GEMINI_DEFAULT_MODEL;
  const response = await fetch(geminiInteractionsUrl(options?.geminiBaseUrl), {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
      "user-agent": "deepseek-harness/free-search",
    },
    body: JSON.stringify({
      model,
      input: String(query),
      tools: [{ type: "google_search" }],
    }),
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(45000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new Error("Gemini API key or request rejected (HTTP " + response.status + ") - check GEMINI_API_KEY and the model name. " + detail.slice(0, 160));
    }
    if (response.status === 429) {
      throw new Error("Gemini rate limit or quota exceeded (HTTP 429) - check your Google AI Studio quota");
    }
    throw new Error("Gemini search API error (HTTP " + response.status + "): " + detail.slice(0, 200));
  }
  const data = await response.json();
  if (data?.error) {
    throw new Error("Gemini response failed: " + (data.error.message ?? JSON.stringify(data.error).slice(0, 200)));
  }
  // Interactions API：结果在 steps[] 里；model_output 步骤的 text 块带 url_citation 注解
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  let answer = typeof data?.output_text === "string" ? data.output_text : "";
  const sources = [];
  for (const step of steps) {
    if (!step || step.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const block of step.content) {
      if (!block || block.type !== "text") continue;
      const text = typeof block.text === "string" ? block.text : "";
      if (!answer && text.trim()) answer = text;
      for (const annotation of block.annotations ?? []) {
        if (annotation?.type !== "url_citation" || typeof annotation.url !== "string" || !annotation.url) continue;
        sources.push({
          url: annotation.url,
          ...(annotation.title ? { title: String(annotation.title) } : {}),
          ...(text.trim() ? { snippet: stripTags(text).slice(0, 300) } : {}),
        });
      }
    }
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5-5";
const CLAUDE_DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const CLAUDE_DEFAULT_VERSION = "2023-06-01";

function claudeMessagesUrl(baseUrl) {
  const base = (typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : CLAUDE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return base.endsWith("/messages") ? base : base + "/messages";
}

async function searchClaude(query, maxResults, apiKey, options, signal) {
  if (!apiKey) throw new Error("Claude search requires ANTHROPIC_API_KEY");
  const model = (typeof options?.claudeModel === "string" && options.claudeModel.trim()) || CLAUDE_DEFAULT_MODEL;
  const response = await fetch(claudeMessagesUrl(options?.claudeBaseUrl), {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": CLAUDE_DEFAULT_VERSION,
      "user-agent": "deepseek-harness/free-search",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: String(query) }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    }),
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(45000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error("Anthropic API key is invalid (HTTP " + response.status + ") - update ANTHROPIC_API_KEY");
    }
    if (response.status === 429) {
      throw new Error("Anthropic rate limit or quota exceeded (HTTP 429) - check your Anthropic usage/limits");
    }
    throw new Error("Claude search API error (HTTP " + response.status + "): " + detail.slice(0, 200));
  }
  const data = await response.json();
  if (data?.error) {
    throw new Error("Claude response failed: " + (data.error.message ?? JSON.stringify(data.error).slice(0, 200)));
  }
  // web_search 的结果块 + 正文里的 citations
  const sources = [];
  for (const block of data.content ?? []) {
    if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const hit of block.content) {
        if (hit?.type !== "web_search_result" || typeof hit.url !== "string" || !hit.url) continue;
        sources.push({
          url: hit.url,
          ...(hit.title ? { title: String(hit.title) } : {}),
          ...(hit.page_age ? { publishedAt: String(hit.page_age) } : {}),
        });
      }
    }
    if (block?.type === "text" && Array.isArray(block.citations)) {
      for (const citation of block.citations) {
        if (citation?.type !== "web_search_result_location" || typeof citation.url !== "string" || !citation.url) continue;
        sources.push({ url: citation.url, ...(citation.title ? { title: String(citation.title) } : {}) });
      }
    }
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// 火山引擎「联网搜索」（豆包搜索，AskEcho）：
// key = DOUBAO_SEARCH_API_KEY（联网搜索控制台 / Ark Coding Plan；每月 500 次免费额度）
// 注意：错误也返回 HTTP 200，必须解析 ResponseMetadata.Error。
// 时间过滤：OneDay | OneWeek | OneMonth | OneYear | "YYYY-MM-DD..YYYY-MM-DD"
function doubaoTimeRange(timeRange) {
  if (!timeRange) return undefined;
  if (typeof timeRange.after === "string") {
    const end = new Date().toISOString().slice(0, 10);
    return `${timeRange.after}..${end}`;
  }
  const days = Number(timeRange.days);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  if (days <= 1) return "OneDay";
  if (days <= 7) return "OneWeek";
  if (days <= 31) return "OneMonth";
  return "OneYear";
}

const DOUBAO_ERROR_HINTS = {
  10400: "invalid request parameters (check Query/Count/TimeRange)",
  10402: "invalid SearchType (only web|image)",
  10403: "account or permission problem - make sure the key is from the Web Search console",
  10406: "free quota exhausted (500 requests/month on the free tier) - check your plan",
  10407: "no available free-tier policy - check the account status",
  10500: "Web Search service internal error - retry later",
  700429: "free-tier rate limit hit - slow down and retry",
  100013: "sub-account is not granted TorchlightApiFullAccess",
  700901: "invalid api key",
};

async function searchDoubao(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("Doubao search requires DOUBAO_SEARCH_API_KEY");
  const count = Math.min(Math.max(maxResults ?? 10, 1), 50);
  const body = {
    Query: String(query).slice(0, 100),
    SearchType: "web",
    Count: count,
    NeedSummary: true,
    Filter: { NeedUrl: true },
  };
  const range = doubaoTimeRange(timeRange);
  if (range !== undefined) body.TimeRange = range;

  const response = await fetch(DOUBAO_SEARCH_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "X-Traffic-Tag": "dsh-free-search",
      "user-agent": "deepseek-harness/free-search",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(20000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Doubao search auth failed (HTTP ${response.status}) - check DOUBAO_SEARCH_API_KEY (Web Search console)`
      );
    }
    throw new Error(`Doubao search API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  // HTTP 200 也可能携带错误信封
  const err = data?.ResponseMetadata?.Error;
  if (err && (err.Code || err.CodeN || err.Message)) {
    const code = err.CodeN ?? err.Code;
    const hint = DOUBAO_ERROR_HINTS[Number(code)] ?? DOUBAO_ERROR_HINTS[String(code)];
    throw new Error(
      `Doubao search API error (${code ?? "unknown"}): ${err.Message ?? "request failed"}${hint ? ` - ${hint}` : ""}`
    );
  }

  const hits = data?.Result?.WebResults ?? [];
  const sources = hits
    .filter((item) => item && item.Url)
    .map((item) => {
      const raw = item.Summary || item.Content || item.Snippet || "";
      const snippet = stripTags(String(raw)).replace(/\s+/g, " ").trim();
      return {
        url: String(item.Url),
        ...(item.Title ? { title: stripTags(String(item.Title)).trim() } : {}),
        ...(snippet ? { snippet: snippet.slice(0, snippetCap("doubao")) } : {}),
        ...(item.PublishTime ? { publishedAt: String(item.PublishTime) } : {}),
      };
    });
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}
//#endregion

//#region bridge
const MAX_JSON_BODY_BYTES = 64 * 1024;

// #84：桥接接口的 Host 围栏。
// DSH 宿主对 /api 已经做了同样的 Browser-trust 围栏并完成鉴权：放行 loopback、
// 监听绑定的 IP 字面量，以及 --trusted-host / --public-url 声明的 authority。
// 插件此前只认 loopback，于是 VPS / 反向代理 / 自定义域名下配置页整体 403、表单全灰。
// 这里沿用宿主的信任集合，而不是把写接口无差别放开。
const bridgeTrust = { hosts: [], publicHost: "" };

function parseAuthority(authority) {
  try {
    return new URL("http://" + authority);
  } catch {
    return null;
  }
}

function isLoopbackAddress(address) {
  const value = String(address ?? "");
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1" || /^127\./.test(value);
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

// 与宿主的 isTrustedAuthority 同规则：无端口条目匹配任意端口，带端口条目精确匹配。
function matchesTrustedAuthority(hostUrl, entry) {
  const entryUrl = parseAuthority(entry);
  if (entryUrl === null) return false;
  return entryUrl.port === "" ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
}

function isBridgeRequestAllowed(request, trust = bridgeTrust) {
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === null) return false;
  // 跨站发起的请求一律拒绝（防 confused deputy）；同源请求才继续看 Host。
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== hostUrl.host) return false;
    } catch {
      return false;
    }
  }
  if (isLoopbackHostname(hostUrl.hostname)) return isLoopbackAddress(request.socket.remoteAddress);
  if (trust.hosts.some((entry) => matchesTrustedAuthority(hostUrl, entry))) return true;
  if (trust.publicHost && matchesTrustedAuthority(hostUrl, trust.publicHost)) return true;
  // 直接绑定非 loopback 地址（--host 192.168.x.x / 公网 IP）时，Host 就是绑定地址。
  const localAddress = request.socket.localAddress;
  if (typeof localAddress === "string" && localAddress !== "0.0.0.0" && localAddress !== "::") {
    const local = parseAuthority(localAddress.includes(":") ? `[${localAddress}]` : localAddress);
    if (local !== null && local.hostname === hostUrl.hostname) return true;
  }
  return false;
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function toView(descriptor) {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
    ...(descriptor.secrets === undefined
      ? {}
      : { secrets: descriptor.secrets.map((secret) => ({ path: [...secret.path], set: secret.set })) }),
    revision: descriptor.revision,
  };
}

function makeBridgeRoutes(settings, search, testEngine, getCredentials) {
  const allowlisted = () =>
    settings
      .describe({ redactSecrets: true })
      .filter((descriptor) => String(descriptor.ns) === FREE_SEARCH_NS)
      .map((descriptor) => String(descriptor.ns));

  const handlers = {
    async checkUpdate() {
      const latest = await fetchLatestVersion();
      if (latest === null) {
        return {
          ok: false,
          code: "update-check-failed",
          message: "could not reach the npm registry (network/proxy) - check your connection",
        };
      }
      const cmp = compareVersions(latest, PLUGIN_VERSION);
      const mode = detectInstallMode();
      return {
        ok: true,
        value: {
          current: PLUGIN_VERSION,
          latest,
          hasUpdate: cmp > 0,
          updateUrl: PLUGIN_NPM_URL,
          repoUrl: PLUGIN_REPO_URL,
          // 可一键升级：npm 真安装时 true；本地 link 开发模式 false（升级请 git pull 源码）
          installable: mode !== null && !mode.isLink,
          installMode: mode?.isLink ? "link" : mode !== null ? "registry" : "unknown",
        },
      };
    },
    // 一键升级：仅在 npm 真安装模式下执行 pnpm 升级；link 模式拒绝（避免破坏本地开发链路）
    async updatePlugin() {
      const mode = detectInstallMode();
      if (mode === null) {
        return { ok: false, code: "install-not-found", message: "could not locate dsh-free-search in any profile" };
      }
      if (mode.isLink) {
        return {
          ok: false,
          code: "local-link-mode",
          message: "local development install (symlink) - update the source repo instead (git pull), then restart dsh",
        };
      }
      try {
        const result = await new Promise((resolve, reject) => {
          exec("pnpm add dsh-free-search@latest", { cwd: mode.profileDir, timeout: 120000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(`upgrade failed: ${(stderr || stdout || error.message).trim().slice(0, 300)}`));
            else resolve(stdout);
          });
        });
        const latest = await fetchLatestVersion();
        return {
          ok: true,
          value: {
            updated: true,
            latest: latest ?? "unknown",
            message: `upgraded to latest - restart dsh to apply`,
            output: String(result).trim().slice(0, 200),
          },
        };
      } catch (error) {
        return { ok: false, code: "upgrade-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async rawSearch(request) {
      if (request === null || typeof request !== "object" || typeof request.query !== "string" || request.query.length === 0) {
        return { ok: false, code: "search-rejected", message: "malformed bridge search request (query is required)" };
      }
      const maxResults = Math.min(Math.max(Number(request.maxResults) || 5, 1), 10);
      const timeRange = parseTimeRange(request.timeRange);
      // 指定 engine：直测该引擎本身（不走回退链），报告它自己的可用性。
      // auto / multi 是虚拟模式，没有"单引擎本身"可测 → 交给下面的 provider.search，
      // 真实跑一遍路由/并发链路（否则设置页「测试引擎」会对它们报 unknown engine）。
      const engineIsMode = typeof request.engine === "string" && SEARCH_MODES.includes(request.engine);
      if (typeof request.engine === "string" && request.engine.length > 0 && !engineIsMode) {
        if (typeof testEngine !== "function") {
          return { ok: false, code: "search-unavailable", message: "engine test is not wired" };
        }
        try {
          const result = await testEngine(request.engine, request.query, timeRange);
          if (result.ok === false) {
            return { ok: false, code: "engine-failed", message: result.error ?? `${request.engine} failed` };
          }
          return {
            ok: true,
            value: {
              provider: request.engine,
              sources: result.sources ?? [],
              content: result.content ?? "",
            },
          };
        } catch (error) {
          return { ok: false, code: "engine-failed", message: error instanceof Error ? error.message : String(error) };
        }
      }
      if (typeof search !== "function") {
        return { ok: false, code: "search-unavailable", message: "search provider is not wired" };
      }
      try {
        const result = await search({ ...request, maxResults, timeRange });
        return {
          ok: true,
          value: {
            // 实际使用的引擎：provider.search 在成功时返回 provider 字段
            provider: result.provider ?? request.engine ?? request.provider ?? "bing",
            sources: result.sources ?? [],
            content: result.content ?? "",
            // 缓存命中标记：provider.search 成功路径标记 _cache（hit=命中缓存，miss=真实搜索）
            cache: result._cache === "hit" ? "hit" : "miss",
          },
        };
      } catch (error) {
        return { ok: false, code: "search-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async describe() {
      const descriptors = settings.describe({ redactSecrets: true });
      return {
        ok: true,
        value: {
          namespaces: allowlisted()
            .map((ns) => descriptors.find((descriptor) => String(descriptor.ns) === ns))
            .filter((descriptor) => descriptor !== undefined)
            .map(toView),
          writable: settings.writable !== false,
        },
      };
    },
    async mutate(request) {
      const body = request;
      if (body === null || typeof body !== "object" || typeof body.ns !== "string" || !Array.isArray(body.ops)) {
        return { ok: false, code: "settings-rejected", message: "malformed bridge settings request" };
      }
      const { ns } = body;
      if (!allowlisted().includes(ns)) {
        return { ok: false, code: "settings-not-exposed", message: `settings namespace "${ns}" is not exposed` };
      }
      const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
      try {
        await settings.mutate(ns, body.ops, expectedRevision);
        // 设置页保存了 AnySearch key：允许下次再试（不删除存储，仅解除本进程忽略）
        if (body.ops.some((op) => op && op.op === "set" && Array.isArray(op.path) && op.path[0] === "anysearchApiKey")) {
          ignoredAnysearchKey = "";
        }
      } catch (error) {
        if (error instanceof SettingsConflictError) {
          return { ok: false, code: "settings-conflict", message: error.message };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, code: "internal", message };
      }
      const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === ns);
      if (descriptor === undefined) {
        return { ok: false, code: "internal", message: `settings namespace "${ns}" was disposed after the mutate` };
      }
      return { ok: true, value: toView(descriptor) };
    },
    // 凭据中心：查询各引擎 key 的配置状态（value 不返回，只返回是否已配置）
    async credentialsStatus() {
      const credentials = getCredentials();
      if (!credentials) return { ok: false, code: "credentials-unavailable", message: "credentials service is not available" };
      const configured = {};
      for (const [settingsKey, ref] of Object.entries(KEY_REF_MAP)) {
        try {
          const info = await credentials.describe(ref);
          configured[settingsKey] = info !== undefined && info.configured === true;
        } catch {
          configured[settingsKey] = false;
        }
      }
      return { ok: true, value: { configured, available: true } };
    },
    // 凭据中心：写入一个引擎 key（ref 白名单限定）
    async credentialsSet(request) {
      const credentials = getCredentials();
      if (!credentials) return { ok: false, code: "credentials-unavailable", message: "credentials service is not available" };
      const { key, value } = request ?? {};
      const ref = KEY_REF_MAP[key];
      if (!ref) return { ok: false, code: "credentials-rejected", message: `unknown credential key "${key}"` };
      if (typeof value !== "string" || value.trim().length === 0) {
        return { ok: false, code: "credentials-rejected", message: "value is required" };
      }
      try {
        await credentials.set(ref, value.trim());
        // 用户写入新 AnySearch key：允许下次请求再试（仅忽略同值坏 key，不删除存储）
        if (key === "anysearchApiKey") ignoredAnysearchKey = "";
        return { ok: true, value: { ref, set: true } };
      } catch (error) {
        return { ok: false, code: "credentials-write-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    // 凭据中心：删除一个引擎 key
    async credentialsUnset(request) {
      const credentials = getCredentials();
      if (!credentials) return { ok: false, code: "credentials-unavailable", message: "credentials service is not available" };
      const { key } = request ?? {};
      const ref = KEY_REF_MAP[key];
      if (!ref) return { ok: false, code: "credentials-rejected", message: `unknown credential key "${key}"` };
      try {
        await credentials.unset(ref);
        return { ok: true, value: { ref, set: false } };
      } catch (error) {
        return { ok: false, code: "credentials-write-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  const guard = (req, res) => {
    if (!isBridgeRequestAllowed(req)) {
      writeJson(res, 403, { error: "requests must come from the local host or a configured trusted host" });
      return false;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
      return false;
    }
    return true;
  };

  return [
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/describe`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.describe());
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/mutate`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "settings-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.mutate(body));
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/credentials-status`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.credentialsStatus());
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/credentials-set`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "credentials-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.credentialsSet(body));
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/credentials-unset`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "credentials-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.credentialsUnset(body));
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/check-update`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.checkUpdate());
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/update`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.updatePlugin());
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/raw-search`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "search-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.rawSearch(body));
      },
    },
  ];
}
//#endregion

const name = "web-search-free";
const inject = ["web"];

// 引擎 key 与凭据中心 ref 的映射（白名单：只允许这些 ref 被 UI 读写凭据中心）
const KEY_REF_MAP = {
  anysearchApiKey: "ANYSEARCH_API_KEY",
  exaApiKey: "EXA_API_KEY",
  tavilyApiKey: "TAVILY_API_KEY",
  keenableApiKey: "KEENABLE_API_KEY",
  firecrawlApiKey: "FIRECRAWL_API_KEY",
  parallelApiKey: "PARALLEL_API_KEY",
  perplexityApiKey: "PERPLEXITY_API_KEY",
  serpbaseApiKey: "SERPBASE_API_KEY",
  serplyApiKey: "SERPLY_API_KEY",
  deepseekApiKey: "DEEPSEEK_API_KEY",
  // 设置页写入的凭据槽位保持旧名，已保存的 key 不受影响；读取时 YDC_API_KEY 优先（见 resolveYoucomApiKey）
  youcomApiKey: "YOUCOM_API_KEY",
  baiduApiKey: "BAIDU_API_KEY",
  kimiApiKey: "MOONSHOT_API_KEY",
  aliyunApiKey: "DASHSCOPE_API_KEY",
  doubaoApiKey: "DOUBAO_SEARCH_API_KEY",
  tinyfishApiKey: "TINYFISH_API_KEY",
  jinaApiKey: "JINA_API_KEY",
  zhihuApiKey: "ZHIHU_API_KEY",
  openaiApiKey: "OPENAI_API_KEY",
  geminiApiKey: "GEMINI_API_KEY",
  claudeApiKey: "ANTHROPIC_API_KEY",
};

// rc.1 declares editable fields `.volatile()`: the Loader hands `apply` live
// references and commits profile edits in place without remounting. `resolveConfig`
// unwraps those references so every read sees the latest accepted value.
// `.volatile()` requires the scoped `@deepseek-ai/schemastery` (>= 3.18.2).


// ── 旧版 settings.yaml `free-search:` 段的迁移 ─────────────────────────────────
// DSH 核心的 importLegacyDocument 只为 ui-developer-tools / ui-onboarding / shell
// 三个段提供了映射；`free-search:` 段无法自动导入，值只会留在启动时被改名的
// settings.yaml.imported 里。这里解析该段，并在首次启动时补种进本条目 config，
// 用 Config.legacyYamlMigrated 去重（只写一次）。
const LEGACY_MIGRATABLE_KEYS = [
  "provider",
  "disabledEngines",
  "fallbackOrder",
  "fallbackOn",
  "cache",
  "cacheTtl",
  "keyStorage",
  "lang",
  "region",
  "bingMarket",
  "safeSearch",
  "searxngInstances",
  "searxngBearerToken",
  "platforms",
  "anysearchApiKey",
  "exaApiKey",
  "tavilyApiKey",
  "keenableApiKey",
  "firecrawlApiKey",
  "parallelApiKey",
  "perplexityApiKey",
  "serpbaseApiKey",
  "serplyApiKey",
  "deepseekApiKey",
  "youcomApiKey",
  "baiduApiKey",
  "kimiApiKey",
  "aliyunApiKey",
  "doubaoApiKey",
  "tinyfishApiKey",
  "jinaApiKey",
  "openaiApiKey",
  "geminiApiKey",
  "claudeApiKey",
  "openaiModel",
  "openaiBaseUrl",
  "geminiModel",
  "geminiBaseUrl",
  "claudeModel",
  "claudeBaseUrl",
];

function dshHomeDir() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
}

/** 解析 YAML 标量：引号字符串、布尔、null、数字、内联数组；其余按原样字符串。 */
function parseLegacyScalar(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  const quoted = raw.match(/^(['"])([\s\S]*)\1$/);
  if (quoted) return quoted[2];
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => parseLegacyScalar(part))
      .filter((value) => value !== null);
  }
  return raw;
}

/** 从 settings.yaml 文本里抽出顶层 `free-search:` 段的扁平键值（忽略嵌套块/块状列表）。 */
function parseLegacyFreeSearchSection(text) {
  const lines = String(text).split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^free-search:\s*(#.*)?$/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const section = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\S/.test(line)) break; // 下一个顶层键
    const kv = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].replace(/\s+#.*$/, "").trim();
    if (value === "") continue; // 嵌套块（map / 块状列表）：跳过，保留人工处理
    section[kv[1]] = parseLegacyScalar(value);
  }
  return section;
}

/** 依次尝试 settings.yaml.imported（导入后的遗留段）与 settings.yaml。 */
function readLegacyFreeSearchSection() {
  const home = dshHomeDir();
  for (const name of ["settings.yaml.imported", "settings.yaml"]) {
    try {
      const text = fs.readFileSync(path.join(home, name), "utf8");
      const section = parseLegacyFreeSearchSection(text);
      if (section !== null && Object.keys(section).length > 0) return { file: name, section };
    } catch {}
  }
  return null;
}

// Unwrap the live `Volatile<T>` references the Loader passes for `.volatile()`
// fields into a plain object, once per read.
function resolveConfig(config) {
  if (config === null || typeof config !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
  }
  return out;
}

// #82 诊断：深度比较 web 条目的 config，返回 `a.b: 旧 → 新` 形式的路径（最多 8 条）。
// 只用于日志，不参与任何逻辑；嵌套对象会展开，数组按整体比较。
function changedConfigPaths(previous, next, prefix = "", out = []) {
  const left = previous !== null && typeof previous === "object" ? previous : {};
  const right = next !== null && typeof next === "object" ? next : {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (out.length >= 8) break;
    const path = prefix ? `${prefix}.${key}` : key;
    const before = left[key];
    const after = right[key];
    const nested =
      before !== null &&
      after !== null &&
      typeof before === "object" &&
      typeof after === "object" &&
      !Array.isArray(before) &&
      !Array.isArray(after);
    if (nested) {
      changedConfigPaths(before, after, path, out);
      continue;
    }
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) {
      out.push(`${path}: ${previewConfigValue(before)} → ${previewConfigValue(after)}`);
    }
  }
  return out;
}

function previewConfigValue(value) {
  if (value === undefined) return "undefined";
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = "undefined";
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

export { searchDdgHtml, searchDdgLite, searchBing, searchSearxng, searchAnysearch, searchExaMCP, searchExa, searchTavily, searchKeenable, searchFirecrawl, searchParallel, searchParallelMCP, searchPerplexity, searchDeepSeekOfficial, searchDeepSeekTools, searchSerpbase, searchSerply, searchYoucom, searchTinyfish, searchJina, searchBaidu, searchKimi, searchAliyun, searchDoubao, searchZhihuGlobal, searchZhihuSite, searchOpenai, searchGemini, searchClaude, searchPlatform, searchBingVideos, searchDdgVideos, searchYoutube, searchVimeo, classifyFailure, normalizeFallbackOrder, normalizeDisabledEngines, enabledEngines, hasCustomFallbackOrder, routeEngines, languagePool, normalizeLanguagePool, parseTimeRange, approximateTimeRange, wrapUntrustedBlock, stripBoundaryTags, uniqueSources, cleanSnippet, fetchHtml, fetchHtmlWithRetry, ALL_ENGINES, FREE_ENGINES, EXPLICIT_ONLY_ENGINES, DEFAULT_FALLBACK_ORDER, FAILURE_CLASSES, engineCooldowns, applyFailureCooldown, isCoolingDown, DEFAULT_ZH_POOL, DEFAULT_EN_POOL, SEARCH_MODES, stripZhihuTracking };

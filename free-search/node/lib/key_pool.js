// 多 key 池：同一个引擎可以配多把 key（两个账号、两份额度），轮流用。
//
// 为什么需要它：上游一直只认「一把 key 一个引擎」，`splitApiKeys` 是当年留下的
// 解析函数，全仓库没有任何调用点。要两个 Tavily 账号的额度都吃到，必须在
// 每次尝试前挑 key，并且**按 key 记账**——一把 key 额度用完不能连坐另一把。
//
// 记账粒度：engine + key。冷却中的 key 跳过；全都在冷却时退回冷却最快到期的那把
// （空转一次拿真实报错，比直接判「没 key 可用」更有用）。

const AUTH_COOLDOWN_MS = (() => {
  const raw = Number(process.env.FREE_SEARCH_KEY_COOLDOWN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
})();
const RATE_COOLDOWN_MS = 60 * 1000;

const slots = new Map(); // "engine|key" -> { cooldownUntil, fails, lastFailure }
const cursors = new Map(); // engine -> 轮转下标

/** 逗号、分号、换行都能分隔；去重且保序（同一把 key 写两遍不该被用两次）。 */
export function parseKeys(raw) {
  const out = [];
  const seen = new Set();
  for (const piece of String(raw ?? "").split(/[\n,;]+/)) {
    const key = piece.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function countKeys(raw) {
  return parseKeys(raw).length;
}

function slot(engine, key) {
  const id = `${engine}|${key}`;
  let entry = slots.get(id);
  if (!entry) {
    entry = { cooldownUntil: 0, fails: 0, lastFailure: "" };
    slots.set(id, entry);
  }
  return entry;
}

export function isKeyCooling(engine, key, now = Date.now()) {
  return slot(engine, key).cooldownUntil > now;
}

/**
 * 取下一把可用 key。只有一把就直接返回，不做无用记账；
 * 多把时在「未冷却」的集合里轮转，避免永远只用第一把。
 */
export function pickKey(engine, raw, now = Date.now()) {
  const keys = parseKeys(raw);
  if (keys.length === 0) return "";
  if (keys.length === 1) return keys[0];

  const fresh = keys.filter((key) => slot(engine, key).cooldownUntil <= now);
  let pool = fresh;
  if (pool.length === 0) {
    // 全部冷却：挑最早到期的一把，让这次调用拿到真实报错，而不是「无可用 key」。
    pool = [...keys].sort((a, b) => slot(engine, a).cooldownUntil - slot(engine, b).cooldownUntil).slice(0, 1);
  }
  const cursor = cursors.get(engine) ?? 0;
  const key = pool[cursor % pool.length];
  cursors.set(engine, (cursor + 1) % pool.length);
  return key;
}

/** 按失败类型给这把 key 记冷却；success 会把冷却和失败计数清零。 */
export function markKeyFailure(engine, key, failureClass, rateLimited = false, now = Date.now()) {
  if (!engine || !key) return;
  const entry = slot(engine, key);
  entry.fails += 1;
  entry.lastFailure = failureClass || "unknown";
  if (failureClass === "quota" || failureClass === "auth") {
    entry.cooldownUntil = Math.max(entry.cooldownUntil, now + AUTH_COOLDOWN_MS);
  } else if (failureClass === "bot-wall" || rateLimited) {
    entry.cooldownUntil = Math.max(entry.cooldownUntil, now + RATE_COOLDOWN_MS);
  }
}

export function markKeySuccess(engine, key) {
  if (!engine || !key) return;
  const entry = slot(engine, key);
  entry.cooldownUntil = 0;
  entry.fails = 0;
  entry.lastFailure = "";
}

/** 给 /health、/stats 和 keys/list 用的只读快照。只回尾 4 位，绝不回完整 key。 */
export function keyStats(engine, raw, now = Date.now()) {
  return parseKeys(raw).map((key) => {
    const entry = slot(engine, key);
    return {
      tail: key.length >= 8 ? key.slice(-4) : null,
      cooling: entry.cooldownUntil > now,
      cooldownMsLeft: Math.max(0, entry.cooldownUntil - now),
      fails: entry.fails,
      lastFailure: entry.lastFailure || "",
    };
  });
}

/** 单测用：把所有记账清空。 */
export function resetKeyPool() {
  slots.clear();
  cursors.clear();
}

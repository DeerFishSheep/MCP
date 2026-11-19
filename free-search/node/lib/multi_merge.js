// 多引擎结果合并：并行跑几个引擎后，把各自的 sources 去重、按域名多样性排序。
//
// 复用仓库里已有的两件成品，不另造一套：
//   - url_norm.normalizeUrlForDedupe —— 去追踪参数后的归一化，判断「是不是同一页」；
//   - multi_policy.rankMergedResults —— 域内按原顺序/时效，域间轮转交错。
//
// 与 multi_policy 的约定一致：多样性只影响排序，不剔除结果；同一 URL 在多个引擎
// 出现只保留一条，但把来源记进 engines，供上层说明「这条有几个引擎佐证」。

import { normalizeUrlForDedupe } from "./url_norm.js";
import { domainOf, rankMergedResults } from "./multi_policy.js";

/**
 * @param {{engine: string, sources: Array<object>}[]} perEngine 每个引擎的原始结果
 * @param {{limit?: number, appliesFreshness?: boolean}} options
 * @returns {Array<object>} 合并后的结果，带 order / domain / corroboration / engines
 */
export function mergeEngineResults(perEngine, { limit = 20, appliesFreshness = false } = {}) {
  const seen = new Map(); // 归一化 URL -> 条目
  const merged = [];
  let order = 0;

  for (const entry of Array.isArray(perEngine) ? perEngine : []) {
    const engine = String(entry?.engine ?? "");
    const sources = Array.isArray(entry?.sources) ? entry.sources : [];
    for (const source of sources) {
      const url = String(source?.url ?? "").trim();
      if (!url) continue;
      const norm = normalizeUrlForDedupe(url);
      const existing = seen.get(norm);
      if (existing) {
        existing.corroboration += 1;
        if (engine && !existing.engines.includes(engine)) existing.engines.push(engine);
        continue;
      }
      const item = {
        ...source,
        url,
        order: order++,
        corroboration: 1,
        domain: domainOf(url),
        engines: engine ? [engine] : [],
      };
      seen.set(norm, item);
      merged.push(item);
    }
  }

  return rankMergedResults(merged, { appliesFreshness }).slice(0, Math.max(1, Number(limit) || 20));
}

/** 这条结果被几个引擎同时给出（≥2 说明有独立佐证）。 */
export function corroboratedCount(results) {
  return (Array.isArray(results) ? results : []).filter((item) => Number(item?.corroboration) > 1).length;
}

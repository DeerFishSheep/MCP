// 多引擎合并单测：去重、佐证计数、域名轮转排序。node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { mergeEngineResults, corroboratedCount } from "../node/lib/multi_merge.js";

test("同一页面（带 utm）只保留一条，佐证数累加", () => {
  const merged = mergeEngineResults([
    { engine: "exa", sources: [{ title: "A", url: "https://a.com/post?utm_source=x" }] },
    { engine: "tavily", sources: [{ title: "A2", url: "https://a.com/post" }] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].corroboration, 2);
  assert.deepEqual(merged[0].engines, ["exa", "tavily"]);
  assert.equal(corroboratedCount(merged), 1);
});

test("域名轮转：单一站点堆叠时，另一站点优先交错出现", () => {
  const merged = mergeEngineResults([
    {
      engine: "exa",
      sources: [
        { title: "a1", url: "https://a.com/1" },
        { title: "a2", url: "https://a.com/2" },
        { title: "a3", url: "https://a.com/3" },
      ],
    },
    { engine: "tavily", sources: [{ title: "b1", url: "https://b.com/1" }] },
  ]);
  assert.equal(merged[0].domain, "a.com");
  assert.equal(merged[1].domain, "b.com");
});

test("limit 生效，空 URL 被跳过", () => {
  const merged = mergeEngineResults(
    [{ engine: "exa", sources: [{ title: "x", url: "" }, { title: "1", url: "https://x.com/1" }, { title: "2", url: "https://x.com/2" }] }],
    { limit: 1 },
  );
  assert.equal(merged.length, 1);
});

test("不同引擎的同域不同页都保留", () => {
  const merged = mergeEngineResults([
    { engine: "exa", sources: [{ url: "https://a.com/1" }] },
    { engine: "tavily", sources: [{ url: "https://a.com/2" }] },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(corroboratedCount(merged), 0);
});

// 多 key 池单测：不碰网络，只验轮换与「按 key 记账」。node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseKeys,
  pickKey,
  countKeys,
  markKeyFailure,
  markKeySuccess,
  keyStats,
  isKeyCooling,
  resetKeyPool,
} from "../node/lib/key_pool.js";

test("parseKeys：逗号/分号/换行分隔，去重保序", () => {
  assert.deepEqual(parseKeys("a,b;c\n a \n"), ["a", "b", "c"]);
  assert.deepEqual(parseKeys(""), []);
  assert.equal(countKeys("k1,k2"), 2);
});

test("pickKey：单 key 原样返回，多 key 轮转", () => {
  resetKeyPool();
  assert.equal(pickKey("tavily", "only-one"), "only-one");
  const picks = [pickKey("tavily", "k1,k2"), pickKey("tavily", "k1,k2"), pickKey("tavily", "k1,k2")];
  assert.deepEqual(picks, ["k1", "k2", "k1"]);
});

test("markKeyFailure：额度/鉴权只冷却那一把，另一把照用", () => {
  resetKeyPool();
  markKeyFailure("tavily", "k1", "quota");
  assert.equal(isKeyCooling("tavily", "k1"), true);
  assert.equal(isKeyCooling("tavily", "k2"), false);
  const picks = new Set([pickKey("tavily", "k1,k2"), pickKey("tavily", "k1,k2")]);
  assert.deepEqual([...picks], ["k2"]);
});

test("全部冷却时仍返回一把，不返回空", () => {
  resetKeyPool();
  markKeyFailure("exa", "a", "auth");
  markKeyFailure("exa", "b", "auth");
  assert.ok(pickKey("exa", "a,b"));
});

test("markKeySuccess：冷却与失败计数清零", () => {
  resetKeyPool();
  markKeyFailure("exa", "a", "auth");
  markKeySuccess("exa", "a");
  const stat = keyStats("exa", "a").pop();
  assert.equal(stat.cooling, false);
  assert.equal(stat.fails, 0);
  assert.equal(stat.lastFailure, "");
});

test("keyStats：只暴露尾号，不暴露完整 key", () => {
  resetKeyPool();
  const [stat] = keyStats("tavily", "tvly-abcdefgh1234");
  assert.equal(stat.tail, "1234");
  assert.ok(!JSON.stringify(stat).includes("abcdefgh"));
});

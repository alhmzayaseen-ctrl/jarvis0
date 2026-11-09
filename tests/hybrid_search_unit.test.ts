import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cosineSimilarity,
  compareUtf8,
  normalizeExactMatchText,
  determineExactMatchTier,
  computeRRF,
  RRF_DEFAULT_K,
} from "../src/memory";

test("cosineSimilarity: mathematical edge cases and contracts", () => {
  // 1. Dimension mismatch returns 0
  const v2 = new Float32Array([1, 2]);
  const v3 = new Float32Array([1, 2, 3]);
  assert.equal(cosineSimilarity(v2, v3), 0);

  // 2. Empty vector returns 0
  const empty = new Float32Array([]);
  assert.equal(cosineSimilarity(empty, empty), 0);

  // 3. Zero norm returns 0
  const zero = new Float32Array([0, 0, 0]);
  const normal = new Float32Array([1, 0, 0]);
  assert.equal(cosineSimilarity(zero, normal), 0);
  assert.equal(cosineSimilarity(zero, zero), 0);

  // 4. Non-finite values return 0
  const nanVec = new Float32Array([NaN, 1, 0]);
  const infVec = new Float32Array([Infinity, 1, 0]);
  assert.equal(cosineSimilarity(nanVec, normal), 0);
  assert.equal(cosineSimilarity(infVec, normal), 0);

  // 5. Positive similarity
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([1, 0, 0]);
  assert.equal(Math.abs(cosineSimilarity(a, b) - 1.0) < 1e-6, true);

  // 6. Orthogonal vectors return 0
  const orthA = new Float32Array([1, 0]);
  const orthB = new Float32Array([0, 1]);
  assert.equal(Math.abs(cosineSimilarity(orthA, orthB)) < 1e-6, true);

  // 7. Negative similarity is preserved and clamped within [-1, 1] without destroying valid negative similarities
  const negA = new Float32Array([1, 0]);
  const negB = new Float32Array([-1, 0]);
  const negSim = cosineSimilarity(negA, negB);
  assert.equal(Math.abs(negSim - (-1.0)) < 1e-6, true);
  assert.ok(negSim < 0, "Negative similarity must not be forced to 0");
});

test("compareUtf8: strict UTF-8 byte comparison with UTF-16 code-unit fallback", () => {
  // Identity
  assert.equal(compareUtf8("abc", "abc"), 0);

  // Standard ASCII order
  assert.equal(compareUtf8("alpha", "beta") < 0, true);
  assert.equal(compareUtf8("beta", "alpha") > 0, true);

  // Length prefix
  assert.equal(compareUtf8("test", "testing") < 0, true);
  assert.equal(compareUtf8("testing", "test") > 0, true);

  // Arabic UTF-8 bytes order
  assert.equal(compareUtf8("أحمد", "باسم") < 0, true);

  // Mixed scripts
  assert.equal(compareUtf8("123", "abc") < 0, true);
  assert.equal(compareUtf8("abc", "أحمد") < 0, true);

  // Surrogate pairs / Unicode code points determinism
  assert.equal(compareUtf8("😀", "😁") < 0, true);
});

test("Exact Matching Normalization: preserves punctuation and prevents false token boundary joins", () => {
  // Punctuation and code boundaries must be preserved
  assert.notEqual(
    normalizeExactMatchText("PRJ-9042"),
    normalizeExactMatchText("PRJ9042"),
    "PRJ-9042 and PRJ9042 must NEVER be considered identical",
  );
  assert.notEqual(
    normalizeExactMatchText("user-port"),
    normalizeExactMatchText("port"),
    "user-port and port must not match identically",
  );
  assert.notEqual(
    normalizeExactMatchText("8080"),
    normalizeExactMatchText("808"),
    "8080 and 808 must not match identically",
  );

  // Case and basic whitespace trimming are normalized safely
  assert.equal(normalizeExactMatchText("  PRJ-9042  "), "prj-9042");
  assert.equal(normalizeExactMatchText("HTTP_PROXY"), "http_proxy");
});

test("determineExactMatchTier: exact key (Tier 3), exact code/token (Tier 2), exact full value (Tier 1), partial (Tier 0)", () => {
  const recordA = {
    key: "my-project",
    value: "Working on PRJ-9042 release",
  };
  const recordB = {
    key: "user-port",
    value: "Listening on port 8080",
  };
  const recordC = {
    key: "favorite-quote",
    value: "Stay hungry stay foolish",
  };

  // Tier 3: Exact Key Match
  assert.equal(determineExactMatchTier("my-project", recordA), 3);
  assert.equal(determineExactMatchTier("MY-PROJECT", recordA), 3);

  // Partial match on key must NOT be Tier 3 or Tier 2 or Tier 1
  assert.equal(
    determineExactMatchTier("port", recordB),
    0,
    "Query 'port' against key 'user-port' must be Tier 0 (not Tier 3, 2, or 1)",
  );

  // Tier 2: Exact composite code/token match
  assert.equal(
    determineExactMatchTier("PRJ-9042", recordA),
    2,
    "Query 'PRJ-9042' must match record token PRJ-9042 as Tier 2",
  );
  assert.equal(
    determineExactMatchTier("PRJ9042", recordA),
    0,
    "Query 'PRJ9042' must NOT match record token 'PRJ-9042' (Tier 0)",
  );

  // Tier 2: Exact standalone number token
  assert.equal(
    determineExactMatchTier("8080", recordB),
    2,
    "Exact number 8080 must be Tier 2",
  );
  assert.equal(
    determineExactMatchTier("808", recordB),
    0,
    "Partial number 808 must NOT match 8080 (Tier 0)",
  );

  // Tier 1: Exact Full Value Match
  assert.equal(
    determineExactMatchTier("Stay hungry stay foolish", recordC),
    1,
    "Exact full value match must be Tier 1",
  );
  assert.equal(
    determineExactMatchTier("stay hungry", recordC),
    0,
    "Partial value match must be Tier 0",
  );

  // Arabic exact key, identifier, and full value
  const recordArabic = {
    key: "لغة-الرد",
    value: "تفضيل اللغة العربية بلبنان رقم 1024",
  };
  const recordArabicFull = {
    key: "لغة-الرد",
    value: "تفضيل اللغة العربية بلبنان فقط",
  };
  assert.equal(determineExactMatchTier("لغة-الرد", recordArabic), 3);
  assert.equal(determineExactMatchTier("1024", recordArabic), 2);
  assert.equal(determineExactMatchTier("تفضيل اللغة العربية بلبنان فقط", recordArabicFull), 1);
  assert.equal(determineExactMatchTier("لغة", recordArabic), 0);
});

test("computeRRF: deterministic ranking and multi-level tie-breaking with strict 4 tiers", () => {
  const item1 = { id: "id-1", key: "alpha", updatedAt: "2026-11-08T10:00:00Z" };
  const item2 = { id: "id-2", key: "beta", updatedAt: "2026-11-08T12:00:00Z" };
  const item3 = { id: "id-3", key: "gamma", updatedAt: "2026-11-08T09:00:00Z" };
  const item4 = { id: "id-4", key: "delta", updatedAt: "2026-11-08T08:00:00Z" };

  // Case A: Lexical has [item1, item2], Semantic has [item2, item3]
  // RRF(item1) = 1/(60+1) + 0 = 1/61
  // RRF(item2) = 1/(60+2) + 1/(60+1) = 1/62 + 1/61 (highest)
  // RRF(item3) = 0 + 1/(60+2) = 1/62
  const tiers = new Map<string, 0 | 1 | 2 | 3>();
  const scored = computeRRF([item1, item2], [item2, item3], tiers, RRF_DEFAULT_K);

  assert.equal(scored[0].id, "id-2");
  assert.equal(scored[1].id, "id-1");
  assert.equal(scored[2].id, "id-3");

  // Case B: Tier Priority hierarchy (Tier 3 > Tier 2 > Tier 1 > Tier 0)
  // item4: Tier 3 (exact key)
  // item3: Tier 2 (exact identifier)
  // item1: Tier 1 (exact full value)
  // item2: Tier 0 (highest RRF score but Tier 0)
  tiers.set("id-4", 3);
  tiers.set("id-3", 2);
  tiers.set("id-1", 1);
  tiers.set("id-2", 0);

  const scoredTiers = computeRRF([item1, item2], [item2, item3, item4], tiers, RRF_DEFAULT_K);
  assert.equal(scoredTiers[0].id, "id-4", "Tier 3 (Exact Key) must be rank 1");
  assert.equal(scoredTiers[1].id, "id-3", "Tier 2 (Exact Identifier) must be rank 2");
  assert.equal(scoredTiers[2].id, "id-1", "Tier 1 (Exact Full Value) must be rank 3");
  assert.equal(scoredTiers[3].id, "id-2", "Tier 0 must be rank 4 despite highest RRF score");

  // Case C: Absolute Tie-breaking hierarchy (identical RRF score and tier)
  // Both items appear at rank 1 in lexical only:
  // candidate X and candidate Y have same RRF and tier:
  const candOlder = { id: "id-older", key: "same-key", updatedAt: "2026-11-01T00:00:00Z" };
  const candNewer = { id: "id-newer", key: "same-key", updatedAt: "2026-11-02T00:00:00Z" };
  const tieScored = computeRRF([candOlder], [candNewer], new Map());
  // candOlder: 1/61 from lex, candNewer: 1/61 from sem -> RRF scores are equal (1/61)
  // Tie-breaker 3 (updatedAt DESC): candNewer is newer -> must rank first!
  assert.equal(tieScored[0].id, "id-newer");
  assert.equal(tieScored[1].id, "id-older");

  // Case D: Tie-breaker 5 (unique id ASC when updatedAt and key are identical)
  const cloneA = { id: "id-aaa", key: "same-key", updatedAt: "2026-11-08T00:00:00Z" };
  const cloneB = { id: "id-bbb", key: "same-key", updatedAt: "2026-11-08T00:00:00Z" };
  const tieIdScored = computeRRF([cloneB], [cloneA], new Map());
  // Both have score 1/61, same tier, same updatedAt, same key
  // id-aaa < id-bbb -> id-aaa must come first!
  assert.equal(tieIdScored[0].id, "id-aaa");
  assert.equal(tieIdScored[1].id, "id-bbb");
});

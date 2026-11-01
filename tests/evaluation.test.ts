import assert from "node:assert/strict";
import { test } from "node:test";
import { QualityEvaluator } from "../src/evaluation";

test("computes deterministic retrieval precision, recall, MRR, and NDCG", () => {
  const metrics = new QualityEvaluator().evaluateRetrieval(
    ["memory-a", "memory-b"],
    ["irrelevant", "memory-a", "memory-a", "memory-b"],
    3,
  );
  assert.equal(metrics.precisionAtK, 1 / 3);
  assert.equal(metrics.recallAtK, 1 / 2);
  assert.equal(metrics.reciprocalRank, 1 / 2);
  assert.ok(metrics.ndcgAtK > 0 && metrics.ndcgAtK < 1);
});

test("measures exact answer accuracy and abstention quality without a model", () => {
  const evaluator = new QualityEvaluator();
  assert.equal(evaluator.evaluateAnswer("Arabic Levantine", " arabic levantine ").exactMatch, true);
  assert.equal(evaluator.evaluateAnswer(null, null).correctlyAbstained, true);
  assert.equal(evaluator.evaluateAnswer(null, "guessed answer").correctlyAbstained, false);

  const metrics = evaluator.evaluateAbstention([
    { expectedToAnswer: false, actuallyAnswered: false },
    { expectedToAnswer: false, actuallyAnswered: true },
    { expectedToAnswer: true, actuallyAnswered: false },
  ]);
  assert.equal(metrics.correctAbstentions, 1);
  assert.equal(metrics.falseAbstentions, 1);
  assert.equal(metrics.precision, 1 / 2);
  assert.equal(metrics.recall, 1 / 2);
});

test("measures operation duration using an injected deterministic clock", async () => {
  let now = 100;
  const measured = await new QualityEvaluator().measureDuration(
    async () => "done",
    () => {
      now += 25;
      return now;
    },
  );
  assert.deepEqual(measured, { result: "done", durationMs: 25 });
});

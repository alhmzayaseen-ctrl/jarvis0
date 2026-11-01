export interface RetrievalMetrics {
  precisionAtK: number;
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
}

export interface AbstentionMetrics {
  precision: number;
  recall: number;
  correctAbstentions: number;
  falseAbstentions: number;
}

export interface AbstentionCase {
  expectedToAnswer: boolean;
  actuallyAnswered: boolean;
}

export interface AnswerMetrics {
  exactMatch: boolean;
  correctlyAbstained: boolean;
}

export class QualityEvaluator {
  evaluateRetrieval(
    expectedIds: readonly string[],
    rankedIds: readonly string[],
    k: number,
  ): RetrievalMetrics {
    if (!Number.isInteger(k) || k < 1) throw new Error("k must be a positive integer.");
    const expected = new Set(expectedIds);
    if (expected.size === 0) {
      return { precisionAtK: 0, recallAtK: 0, reciprocalRank: 0, ndcgAtK: 0 };
    }

    const top = rankedIds.slice(0, k);
    const seenRelevant = new Set<string>();
    const relevantRanks: number[] = [];
    top.forEach((id, index) => {
      if (expected.has(id) && !seenRelevant.has(id)) {
        relevantRanks.push(index + 1);
        seenRelevant.add(id);
      }
    });
    const dcg = relevantRanks.reduce((sum, rank) => sum + 1 / Math.log2(rank + 1), 0);
    const idealHits = Math.min(expected.size, k);
    const idealDcg = Array.from({ length: idealHits }, (_, index) =>
      1 / Math.log2(index + 2),
    ).reduce((sum, value) => sum + value, 0);

    return {
      precisionAtK: relevantRanks.length / k,
      recallAtK: relevantRanks.length / expected.size,
      reciprocalRank: relevantRanks.length > 0 ? 1 / relevantRanks[0] : 0,
      ndcgAtK: idealDcg === 0 ? 0 : dcg / idealDcg,
    };
  }

  evaluateAbstention(cases: readonly AbstentionCase[]): AbstentionMetrics {
    const correctAbstentions = cases.filter(
      ({ expectedToAnswer, actuallyAnswered }) => !expectedToAnswer && !actuallyAnswered,
    ).length;
    const falseAbstentions = cases.filter(
      ({ expectedToAnswer, actuallyAnswered }) => expectedToAnswer && !actuallyAnswered,
    ).length;
    const actualAbstentions = correctAbstentions + falseAbstentions;
    const expectedAbstentions = cases.filter(({ expectedToAnswer }) => !expectedToAnswer).length;
    return {
      precision: actualAbstentions === 0 ? 0 : correctAbstentions / actualAbstentions,
      recall: expectedAbstentions === 0 ? 0 : correctAbstentions / expectedAbstentions,
      correctAbstentions,
      falseAbstentions,
    };
  }

  evaluateAnswer(expected: string | null, actual: string | null): AnswerMetrics {
    if (expected === null) {
      return {
        exactMatch: false,
        correctlyAbstained: actual === null || actual.trim().length === 0,
      };
    }
    if (actual === null) return { exactMatch: false, correctlyAbstained: false };
    return {
      exactMatch: normalizeAnswer(expected) === normalizeAnswer(actual),
      correctlyAbstained: false,
    };
  }

  async measureDuration<T>(
    operation: () => Promise<T>,
    now: () => number = performance.now,
  ): Promise<{ result: T; durationMs: number }> {
    const start = now();
    const result = await operation();
    return { result, durationMs: Math.max(0, now() - start) };
  }
}

function normalizeAnswer(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

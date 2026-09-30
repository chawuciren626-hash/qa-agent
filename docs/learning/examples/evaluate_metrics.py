"""Offline teaching example; annotations are supplied, not inferred by an LLM."""

from math import sqrt


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def retrieval_scores(relevant, retrieved, k):
    if k < 1:
        raise ValueError("k must be positive")
    relevant = set(relevant)
    ranked = list(dict.fromkeys(retrieved))[:k]
    hits = len(relevant.intersection(ranked))
    return {
        "recall": ratio(hits, len(relevant)),
        "precision": ratio(hits, len(ranked)),
    }


def coverage(required, supported):
    required = set(required)
    return ratio(len(required.intersection(supported)), len(required))


def faithfulness(output_claims, supported_claims):
    return coverage(output_claims, supported_claims)


def wilson_interval(successes, total, z=1.959963984540054):
    if not 0 <= successes <= total:
        raise ValueError("successes must be between zero and total")
    if total == 0:
        return None
    p = successes / total
    denominator = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denominator
    margin = z * sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return center - margin, center + margin


def percent(value):
    return "N/A" if value is None else f"{value:.2%}"


def main():
    retrieval = retrieval_scores({"A", "B", "C", "D"}, ["B", "X", "A"], 3)
    required_facts = {"F1", "F2", "F3", "F4"}
    final_context_support = {"F1", "F2", "F4"}
    output_claims = {"C1", "C2", "C3", "C4"}
    supported_claims = {"C1", "C2", "C3"}
    active_memories = {"M-new-budget", "M-no-submit"}
    retrieved_memories = {"M-new-budget", "M-old-date"}
    memory = retrieval_scores(active_memories, sorted(retrieved_memories), 2)

    assert retrieval["recall"] == 0.5
    assert retrieval["precision"] == 2 / 3
    assert coverage(required_facts, final_context_support) == 0.75
    assert faithfulness(output_claims, supported_claims) == 0.75
    assert coverage(set(), set()) is None
    assert retrieval_scores({"A"}, [], 3) == {"recall": 0.0, "precision": None}
    assert retrieval_scores({"A", "B"}, ["A", "A", "B"], 2)["recall"] == 1.0
    assert coverage(required_facts, {"F1", "irrelevant"}) == 0.25
    assert wilson_interval(0, 0) is None
    interval = wilson_interval(90, 100)
    assert 0.825 < interval[0] < 0.827 and 0.944 < interval[1] < 0.946

    print("Retrieval Recall@3:", percent(retrieval["recall"]))
    print("Retrieval Precision@3:", percent(retrieval["precision"]))
    print("Final-context recall:", percent(coverage(required_facts, final_context_support)))
    print("Faithfulness:", percent(faithfulness(output_claims, supported_claims)))
    print("Memory recall / precision:", percent(memory["recall"]), percent(memory["precision"]))
    print("Empty reference:", percent(coverage(set(), set())))
    print("Wilson 95% interval (90/100 independent tasks):", *(percent(x) for x in interval))
    print("All offline example checks passed. No model or business tools were called.")


if __name__ == "__main__":
    main()

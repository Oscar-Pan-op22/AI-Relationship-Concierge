function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTrailingPunctuation(value) {
  return value.replace(/[，。,、；;：:！!？?\s]+$/gu, "").trim();
}

function normalizeFactValueForComparison(value) {
  return stripTrailingPunctuation(normalizeWhitespace(value));
}

function getFactGroupKey(fact) {
  return [String(fact?.subjectUserId || ""), String(fact?.key || "").trim()].join("::");
}

function getConfidence(fact) {
  return Number(fact?.confidence ?? 0);
}

function isCandidateMoreInformative(existing, candidate) {
  const existingValue = normalizeFactValueForComparison(existing?.value);
  const candidateValue = normalizeFactValueForComparison(candidate?.value);

  if (!existingValue) {
    return true;
  }

  if (!candidateValue) {
    return false;
  }

  if (existingValue === candidateValue) {
    return getConfidence(candidate) > getConfidence(existing);
  }

  if (candidateValue.includes(existingValue)) {
    return true;
  }

  return false;
}

function compareFactValues(existing, candidate) {
  const existingValue = normalizeFactValueForComparison(existing?.value);
  const candidateValue = normalizeFactValueForComparison(candidate?.value);

  if (!existingValue && !candidateValue) {
    return "same";
  }

  if (!existingValue) {
    return "replace";
  }

  if (!candidateValue) {
    return "keep-both";
  }

  if (existingValue === candidateValue) {
    return isCandidateMoreInformative(existing, candidate) ? "replace" : "skip";
  }

  if (candidateValue.includes(existingValue)) {
    return "replace";
  }

  if (existingValue.includes(candidateValue)) {
    return "skip";
  }

  return "keep-both";
}

export function dedupeFacts(facts = []) {
  const result = [];
  const groupIndexes = new Map();

  for (const fact of facts) {
    const groupKey = getFactGroupKey(fact);
    const indexes = groupIndexes.get(groupKey) || [];
    let handled = false;

    for (const index of indexes) {
      const existing = result[index];

      if (!existing) {
        continue;
      }

      const comparison = compareFactValues(existing, fact);

      if (comparison === "replace") {
        result[index] = fact;
        handled = true;
        break;
      }

      if (comparison === "skip") {
        handled = true;
        break;
      }
    }

    if (handled) {
      continue;
    }

    result.push(fact);
    indexes.push(result.length - 1);
    groupIndexes.set(groupKey, indexes);
  }

  return result;
}

export { normalizeFactValueForComparison };

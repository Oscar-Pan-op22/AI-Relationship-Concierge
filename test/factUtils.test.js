import test from "node:test";
import assert from "node:assert/strict";

import { dedupeFacts } from "../public/fact-utils.js";

test("同主体同字段会保留更完整的长句", () => {
  const facts = [
    {
      subjectUserId: "self",
      key: "relationshipGoal",
      value: "认真长期关系",
      confidence: 0.9
    },
    {
      subjectUserId: "self",
      key: "relationshipGoal",
      value: "认真长期关系，希望以结婚为目标",
      confidence: 0.9
    }
  ];

  const deduped = dedupeFacts(facts);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].value, "认真长期关系，希望以结婚为目标");
});

test("跨主体的同字段事实不会被合并", () => {
  const facts = [
    {
      subjectUserId: "self",
      key: "relationshipGoal",
      value: "认真长期关系，希望以结婚为目标",
      confidence: 0.9
    },
    {
      subjectUserId: "counterparty",
      key: "relationshipGoal",
      value: "认真长期关系，希望以结婚为目标",
      confidence: 0.9
    }
  ];

  const deduped = dedupeFacts(facts);

  assert.equal(deduped.length, 2);
});

test("完全相同文本会保留置信度更高的一条", () => {
  const facts = [
    {
      subjectUserId: "self",
      key: "relationshipGoal",
      value: "认真长期关系",
      confidence: 0.6
    },
    {
      subjectUserId: "self",
      key: "relationshipGoal",
      value: "认真长期关系",
      confidence: 0.9
    }
  ];

  const deduped = dedupeFacts(facts);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].confidence, 0.9);
});

test("同字段互不包含的事实会同时保留", () => {
  const facts = [
    {
      subjectUserId: "self",
      key: "cities",
      value: "目前在上海",
      confidence: 0.8
    },
    {
      subjectUserId: "self",
      key: "cities",
      value: "杭州也可以考虑",
      confidence: 0.8
    }
  ];

  const deduped = dedupeFacts(facts);

  assert.equal(deduped.length, 2);
});

test("仅标点和空白差异会视为重复", () => {
  const facts = [
    {
      subjectUserId: "self",
      key: "relationshipGoal",
      value: "认真长期关系，希望以结婚为目标。 ",
      confidence: 0.8
    },
    {
      subjectUserId: "self",
      key: "relationshipGoal",
      value: "认真长期关系，希望以结婚为目标",
      confidence: 0.9
    }
  ];

  const deduped = dedupeFacts(facts);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].confidence, 0.9);
});

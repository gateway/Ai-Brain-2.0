import assert from "node:assert/strict";
import test from "node:test";

import {
  isGeneratedRecursiveReflectQuery,
  shouldSuppressRecursiveReflectForGeneratedQuery
} from "../dist/retrieval/service.js";

test("detects generated exact-detail reflect prompts", () => {
  assert.equal(
    isGeneratedRecursiveReflectQuery(
      "what exact detail about Deborah answers this question: What are the names of Deborah's snakes?"
    ),
    true
  );
  assert.equal(
    isGeneratedRecursiveReflectQuery(
      "what explicit fact in the source answers: What are the names of Deborah's snakes?"
    ),
    true
  );
  assert.equal(
    isGeneratedRecursiveReflectQuery("What are the names of Deborah's snakes?"),
    false
  );
});

test("suppresses reflect-on-reflect only after the first recursive depth", () => {
  const generatedPrompt =
    "what exact detail about Deborah answers this question: What are the names of Deborah's snakes?";

  assert.equal(shouldSuppressRecursiveReflectForGeneratedQuery(generatedPrompt, 0), false);
  assert.equal(shouldSuppressRecursiveReflectForGeneratedQuery(generatedPrompt, 1), true);
  assert.equal(
    shouldSuppressRecursiveReflectForGeneratedQuery("What are the names of Deborah's snakes?", 1),
    false
  );
});

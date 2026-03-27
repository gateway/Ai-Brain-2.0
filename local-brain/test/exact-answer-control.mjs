import test from "node:test";
import assert from "node:assert/strict";
import { deriveExactAnswerCandidate } from "../dist/retrieval/exact-answer-control.js";

function makeResult({
  memoryId,
  memoryType = "artifact_derivation",
  content,
  subjectName,
  speakerName,
  participantNames = [],
  derivationType = "source_sentence",
  sourceSentenceText
}) {
  return {
    memoryId,
    memoryType,
    content,
    score: 1,
    artifactId: null,
    occurredAt: null,
    namespaceId: "ns_test",
    provenance: {
      subject_name: subjectName,
      speaker_name: speakerName,
      derivation_type: derivationType,
      metadata: {
        subject_name: subjectName,
        speaker_name: speakerName,
        participant_names: participantNames,
        derivation_type: derivationType,
        source_sentence_text: sourceSentenceText
      }
    }
  };
}

function runExactAnswer({
  queryText,
  family,
  results,
  extractValues,
  structuredQuery = true
}) {
  return deriveExactAnswerCandidate({
    queryText,
    results,
    family,
    structuredQuery,
    extractValues,
    formatClaimText: (_query, value) => value
  });
}

test("mixed-subject conversation unit is discarded", () => {
  const result = runExactAnswer({
    queryText: "What is Joanna's favorite movie?",
    family: "favorite_movie",
    results: [
      makeResult({
        memoryId: "r1",
        content: "Joanna said her favorite movie is Inception, but Andrew said his favorite movie is Titanic.",
        subjectName: "Joanna",
        participantNames: ["Joanna", "Andrew"],
        derivationType: "conversation_unit"
      })
    ],
    extractValues: (text) => {
      const values = [];
      if (/Inception/.test(text)) values.push("Inception");
      if (/Titanic/.test(text)) values.push("Titanic");
      return values;
    }
  });

  assert.equal(result.candidate, null);
  assert.equal(result.telemetry.exactAnswerSafeWindowCount, 0);
  assert.ok(result.telemetry.exactAnswerDiscardedMixedWindowCount >= 1);
});

test("wrong-speaker participant turn is rejected", () => {
  const result = runExactAnswer({
    queryText: "What is Joanna's favorite movie?",
    family: "favorite_movie",
    results: [
      makeResult({
        memoryId: "r2",
        content: "Andrew: My favorite movie is Titanic.",
        subjectName: "Joanna",
        speakerName: "Andrew",
        participantNames: ["Joanna", "Andrew"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => (/Titanic/.test(text) ? ["Titanic"] : [])
  });

  assert.equal(result.candidate, null);
  assert.ok(result.telemetry.exactAnswerDiscardedForeignWindowCount >= 1);
});

test("favorite movie prefers favorite-cue sentence over generic mention", () => {
  const result = runExactAnswer({
    queryText: "What is Joanna's favorite movie?",
    family: "favorite_movie",
    results: [
      makeResult({
        memoryId: "r3",
        content: "Joanna watched Titanic last weekend.",
        subjectName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "source_sentence"
      }),
      makeResult({
        memoryId: "r4",
        content: "Joanna: My favorite movie is Inception.",
        subjectName: "Joanna",
        speakerName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => {
      const values = [];
      if (/Inception/.test(text)) values.push("Inception");
      if (/Titanic/.test(text)) values.push("Titanic");
      return values;
    }
  });

  assert.equal(result.candidate?.text, "Inception");
});

test("hobbies only extracts from hobby-bearing cues", () => {
  const result = runExactAnswer({
    queryText: "What are Joanna's hobbies?",
    family: "hobbies",
    results: [
      makeResult({
        memoryId: "r5",
        content: "Joanna went hiking for work on Tuesday.",
        subjectName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "source_sentence"
      }),
      makeResult({
        memoryId: "r6",
        content: "Joanna's hobbies include painting and sketching.",
        subjectName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "source_sentence"
      })
    ],
    extractValues: (text) => {
      const values = [];
      if (/painting/i.test(text)) values.push("painting");
      if (/hiking/i.test(text)) values.push("hiking");
      return values;
    }
  });

  assert.equal(result.candidate?.text, "painting");
});

test("favorite movie trilogy adversarial case abstains when no trilogy cue exists", () => {
  const result = runExactAnswer({
    queryText: "What is Joanna's favorite movie trilogy?",
    family: "favorite_movie",
    results: [
      makeResult({
        memoryId: "r7",
        content: "Joanna: My favorite movie is Inception.",
        subjectName: "Joanna",
        speakerName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => (/Inception/.test(text) ? ["Inception"] : [])
  });

  assert.equal(result.candidate, null);
  assert.equal(result.telemetry.exactAnswerAbstainedForAmbiguity, true);
});

test("two close competing values abstain", () => {
  const result = runExactAnswer({
    queryText: "What is Joanna's favorite movie?",
    family: "favorite_movie",
    results: [
      makeResult({
        memoryId: "r8",
        content: "Joanna: My favorite movie is Inception.",
        subjectName: "Joanna",
        speakerName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "participant_turn"
      }),
      makeResult({
        memoryId: "r9",
        content: "Joanna: My favorite movie is Titanic.",
        subjectName: "Joanna",
        speakerName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => {
      const values = [];
      if (/Inception/.test(text)) values.push("Inception");
      if (/Titanic/.test(text)) values.push("Titanic");
      return values;
    }
  });

  assert.equal(result.candidate, null);
  assert.equal(result.telemetry.exactAnswerAbstainedForAmbiguity, true);
});

test("one strong subject-safe value beats weak generic topic mention", () => {
  const result = runExactAnswer({
    queryText: "What is Joanna's favorite movie?",
    family: "favorite_movie",
    results: [
      makeResult({
        memoryId: "r10",
        memoryType: "semantic_memory",
        content: "Joanna discussed movies like Titanic and Avatar recently.",
        subjectName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "topic_segment"
      }),
      makeResult({
        memoryId: "r11",
        content: "Joanna: My favorite movie is Inception.",
        subjectName: "Joanna",
        speakerName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => {
      const values = [];
      if (/Inception/.test(text)) values.push("Inception");
      if (/Titanic/.test(text)) values.push("Titanic");
      return values;
    }
  });

  assert.equal(result.candidate?.text, "Inception");
});

test("martial arts multi-value family returns multiple values only from strong windows", () => {
  const result = runExactAnswer({
    queryText: "What martial arts does John practice?",
    family: "martial_arts",
    results: [
      makeResult({
        memoryId: "r12",
        content: "John: I practice karate.",
        subjectName: "John",
        speakerName: "John",
        participantNames: ["John"],
        derivationType: "participant_turn"
      }),
      makeResult({
        memoryId: "r13",
        content: "John: I also train in judo.",
        subjectName: "John",
        speakerName: "John",
        participantNames: ["John"],
        derivationType: "participant_turn"
      }),
      makeResult({
        memoryId: "r14",
        memoryType: "semantic_memory",
        content: "John talked about sports last week.",
        subjectName: "John",
        participantNames: ["John"],
        derivationType: "topic_segment"
      })
    ],
    extractValues: (text) => {
      const values = [];
      if (/karate/i.test(text)) values.push("karate");
      if (/judo/i.test(text)) values.push("judo");
      return values;
    }
  });

  assert.ok(result.candidate?.text.includes("karate"));
  assert.ok(result.candidate?.text.includes("judo"));
});

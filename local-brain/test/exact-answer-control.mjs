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

test("hobbies discard incomplete gerund fragments from nearby affective chatter", () => {
  const result = runExactAnswer({
    queryText: "What are Joanna's hobbies?",
    family: "hobbies",
    results: [
      makeResult({
        memoryId: "r6b",
        content: "Besides writing, I also enjoy reading, watching movies, and exploring nature.",
        subjectName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "source_sentence"
      }),
      makeResult({
        memoryId: "r6c",
        content: "Joanna: I'm all about dramas and romcoms. I love getting immersed in the feelings and plots.",
        subjectName: "Joanna",
        speakerName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "participant_turn"
      }),
      makeResult({
        memoryId: "r6d",
        content: "Writing and hanging with friends!",
        subjectName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "source_sentence"
      })
    ],
    extractValues: (text) => {
      const values = [];
      if (/writing/i.test(text)) values.push("writing");
      if (/reading/i.test(text)) values.push("reading");
      if (/watching movies/i.test(text)) values.push("watching movies");
      if (/exploring nature/i.test(text)) values.push("exploring nature");
      if (/getting immersed in/i.test(text)) values.push("getting immersed in");
      if (/hanging with friends/i.test(text)) values.push("hanging with friends");
      return values;
    }
  });

  assert.match(result.candidate?.text ?? "", /writing/i);
  assert.match(result.candidate?.text ?? "", /hanging with friends/i);
  assert.doesNotMatch(result.candidate?.text ?? "", /getting immersed in/i);
});

test("meal companion extracts joint first-person meal phrasing", () => {
  const result = runExactAnswer({
    queryText: "Who did Maria have dinner with on May 3, 2023?",
    family: "meal_companion",
    results: [
      makeResult({
        memoryId: "r6e",
        content: "Maria: My mom and I made some dinner together last night!",
        subjectName: "Maria",
        speakerName: "Maria",
        participantNames: ["Maria", "John"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => (/my mom and I made some dinner together/i.test(text) ? ["her mother"] : [])
  });

  assert.equal(result.candidate?.text, "her mother");
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

test("hobbies aggregate distinct owned windows instead of collapsing to one sentence", () => {
  const result = runExactAnswer({
    queryText: "What are Joanna's hobbies?",
    family: "hobbies",
    results: [
      makeResult({
        memoryId: "r15",
        content: "Joanna: Besides writing, I also enjoy watching movies and exploring nature.",
        subjectName: "Joanna",
        speakerName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "participant_turn"
      }),
      makeResult({
        memoryId: "r16",
        content: "Joanna: Writing and hanging with friends!",
        subjectName: "Joanna",
        speakerName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => {
      const values = [];
      if (/writing/i.test(text)) values.push("writing");
      if (/watching movies/i.test(text)) values.push("watching movies");
      if (/exploring nature/i.test(text)) values.push("exploring nature");
      if (/hanging with friends/i.test(text)) values.push("hanging with friends");
      return values;
    }
  });

  assert.ok(result.candidate?.text.includes("writing"));
  assert.ok(result.candidate?.text.includes("watching movies"));
  assert.ok(result.candidate?.text.includes("exploring nature"));
  assert.ok(result.candidate?.text.includes("hanging with friends"));
});

test("hobbies reject media-only taste chatter when no hobby value is extracted", () => {
  const result = runExactAnswer({
    queryText: "What are Joanna's hobbies?",
    family: "hobbies",
    results: [
      makeResult({
        memoryId: "r16b",
        content: "Joanna: I'm all about dramas and romcoms. I love getting immersed in the feelings and plots.",
        subjectName: "Joanna",
        speakerName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "participant_turn"
      }),
      makeResult({
        memoryId: "r16c",
        content: "Joanna: Besides writing, I also enjoy watching movies and exploring nature.",
        subjectName: "Joanna",
        speakerName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => {
      const values = [];
      if (/writing/i.test(text)) values.push("writing");
      if (/watching movies/i.test(text)) values.push("watching movies");
      if (/exploring nature/i.test(text)) values.push("exploring nature");
      return values;
    }
  });

  assert.ok(result.candidate?.text.includes("writing"));
  assert.ok(!result.candidate?.text.includes("dramas"));
});

test("allergy-safe pets prefer explicit alternatives over generic allergy complaints", () => {
  const result = runExactAnswer({
    queryText: "What pets wouldn't cause any discomfort to Joanna?",
    family: "pets",
    results: [
      makeResult({
        memoryId: "r16d",
        content: "Joanna: Unfortunately, allergies make it so I don't really want to get any, and I'm too lazy to research alternative pets for my allergy.",
        subjectName: "Joanna",
        speakerName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "participant_turn"
      }),
      makeResult({
        memoryId: "r16e",
        content: "Joanna: Hairless cats or pigs would be better since they don't have fur, which is one of the main causes of my allergy.",
        subjectName: "Joanna",
        speakerName: "Joanna",
        participantNames: ["Joanna"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => {
      const values = [];
      if (/hairless cats/i.test(text)) values.push("hairless cats");
      if (/\bpigs?\b/i.test(text)) values.push("pigs");
      return values;
    }
  });

  assert.ok(result.candidate?.text.includes("hairless cats"));
  assert.ok(result.candidate?.text.includes("pigs"));
});

test("goals aggregate only the query-relevant career lane", () => {
  const result = runExactAnswer({
    queryText: "What are John's goals for his career that are not related to his basketball skills?",
    family: "goals",
    results: [
      makeResult({
        memoryId: "g1",
        content: "John: I want to improve my shooting percentage and win a championship.",
        subjectName: "John",
        speakerName: "John",
        participantNames: ["John"],
        derivationType: "participant_turn"
      }),
      makeResult({
        memoryId: "g2",
        content: "John: I also want to get endorsements, build my brand, and do charity work.",
        subjectName: "John",
        speakerName: "John",
        participantNames: ["John"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text, queryText) => {
      const values = [];
      if (/shooting percentage/i.test(text)) values.push("improve shooting percentage");
      if (/championship/i.test(text)) values.push("win a championship");
      if (/endorsements/i.test(text)) values.push("get endorsements");
      if (/build my brand/i.test(text)) values.push("build my brand");
      if (/charity work/i.test(text)) values.push("do charity work");
      if (/not related/i.test(queryText)) {
        return values.filter((value) => /endorsements|brand|charity/i.test(value));
      }
      return values;
    }
  });

  assert.match(result.candidate?.text ?? "", /endorsements/i);
  assert.match(result.candidate?.text ?? "", /brand/i);
  assert.match(result.candidate?.text ?? "", /charity/i);
  assert.doesNotMatch(result.candidate?.text ?? "", /championship/i);
});

test("purchased items aggregate distinct bought values from a single list statement", () => {
  const result = runExactAnswer({
    queryText: "What items did Calvin buy in March 2023?",
    family: "purchased_items",
    results: [
      makeResult({
        memoryId: "p1",
        content: "Calvin bought a mansion in Japan and a Ferrari 488 GTB in March 2023.",
        subjectName: "Calvin",
        speakerName: "Calvin",
        participantNames: ["Calvin"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => {
      const values = [];
      if (/mansion in Japan/i.test(text)) values.push("mansion in Japan");
      if (/Ferrari 488 GTB/i.test(text)) values.push("Ferrari 488 GTB");
      return values;
    }
  });

  assert.match(result.candidate?.text ?? "", /mansion in Japan/i);
  assert.match(result.candidate?.text ?? "", /Ferrari 488 GTB/i);
});

test("bands aggregate multiple listened-to acts from strong windows", () => {
  const result = runExactAnswer({
    queryText: "Which bands has Dave enjoyed listening to?",
    family: "bands",
    results: [
      makeResult({
        memoryId: "b1",
        content: "Dave: I've enjoyed listening to Aerosmith and The Fireworks lately.",
        subjectName: "Dave",
        speakerName: "Dave",
        participantNames: ["Dave"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => {
      const values = [];
      if (/Aerosmith/i.test(text)) values.push("Aerosmith");
      if (/The Fireworks/i.test(text)) values.push("The Fireworks");
      return values;
    }
  });

  assert.match(result.candidate?.text ?? "", /Aerosmith/i);
  assert.match(result.candidate?.text ?? "", /The Fireworks/i);
});

test("owned pets returns the supported species instead of falling through to generic snippets", () => {
  const result = runExactAnswer({
    queryText: "What pets does Jolene have?",
    family: "owned_pets",
    results: [
      makeResult({
        memoryId: "pet1",
        content: "Jolene: I have two snakes at home.",
        subjectName: "Jolene",
        speakerName: "Jolene",
        participantNames: ["Jolene"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => (/snakes/i.test(text) ? ["snakes"] : [])
  });

  assert.equal(result.candidate?.text, "snakes");
});

test("temporary job abstains to None when the role is unspecified", () => {
  const result = runExactAnswer({
    queryText: "What temporary job did Jon take to cover expenses?",
    family: "temporary_job",
    results: [
      makeResult({
        memoryId: "r17",
        content: "Jon: I got a temp job to help cover expenses while I look for investors.",
        subjectName: "Jon",
        speakerName: "Jon",
        participantNames: ["Jon", "Gina"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => (/\btemp job\b/i.test(text) ? ["None"] : [])
  });

  assert.equal(result.candidate?.text, "None");
});

test("temporary job abstains when only a generic temp-job mention exists", () => {
  const result = runExactAnswer({
    queryText: "What temporary job did Jon take to cover expenses?",
    family: "temporary_job",
    results: [
      makeResult({
        memoryId: "r17",
        content: "Jon: I got a temp job to help cover expenses while I look for investors.",
        subjectName: "Jon",
        speakerName: "Jon",
        participantNames: ["Jon", "Gina"],
        derivationType: "participant_turn"
      })
    ],
    extractValues: (text) => (/temp job/i.test(text) ? [] : [])
  });

  assert.equal(result.candidate, null);
});

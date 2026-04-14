import test from "node:test";
import assert from "node:assert/strict";
import {
  answerableUnitFixtures,
  previewUnitsForFixture,
  toAnswerableUnitMocks
} from "../dist/benchmark/answerable-unit-fixtures.js";
import { scoreAnswerableUnitsForQuery } from "../dist/retrieval/answerable-unit-retrieval.js";
import { selectReaderResult } from "../dist/retrieval/answerable-unit-reader.js";

test("answerable unit fixtures construct expected unit families", () => {
  const fixture = answerableUnitFixtures().find((entry) => entry.name === "audrey_dogs_year");
  const units = previewUnitsForFixture(fixture);
  assert.ok(units.some((unit) => unit.unitType === "participant_turn"));
  assert.ok(units.some((unit) => unit.unitType === "source_sentence"));
  assert.ok(units.some((unit) => unit.unitType === "date_span"));
});

test("reader resolves and abstains on frozen fixtures", () => {
  for (const fixture of answerableUnitFixtures()) {
    const units = previewUnitsForFixture(fixture);
    const candidates = scoreAnswerableUnitsForQuery(fixture.query, toAnswerableUnitMocks(units), []);
    const reader = selectReaderResult(fixture.query, candidates);

    if (!fixture.expectedApplied) {
      assert.equal(candidates.length, 0, `${fixture.name}: candidate count`);
      assert.equal(reader.applied, false, `${fixture.name}: reader applied`);
      continue;
    }

    assert.ok(candidates.length > 0, `${fixture.name}: candidate count`);
    assert.equal(reader.applied, true, `${fixture.name}: reader applied`);
    assert.equal(reader.decision, fixture.expectedDecision, `${fixture.name}: reader decision`);
    if (fixture.expectedClaimIncludes) {
      assert.match((reader.claimText ?? "").toLowerCase(), new RegExp(fixture.expectedClaimIncludes.toLowerCase()));
    }
  }
});

test("reader fans out across multiple owned units for safe list aggregation queries", () => {
  const candidates = [
    {
      unit: {
        id: "u1",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m1",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c1",
        unitType: "participant_turn",
        contentText: "Joanna: Writing and hanging with friends!",
        ownerEntityHint: "Joanna",
        speakerEntityHint: "Joanna",
        participantNames: ["Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 1
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 5
    },
    {
      unit: {
        id: "u2",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m2",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c2",
        unitType: "source_sentence",
        contentText: "Joanna's hobbies include reading, watching movies, and exploring nature.",
        ownerEntityHint: "Joanna",
        speakerEntityHint: null,
        participantNames: ["Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.9
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 4.82
    },
    {
      unit: {
        id: "u3",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m3",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c3",
        unitType: "participant_turn",
        contentText: "Joanna: What hobbies should we try next summer?",
        ownerEntityHint: "Joanna",
        speakerEntityHint: "Joanna",
        participantNames: ["Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.8
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 4.6
    }
  ];

  const reader = selectReaderResult("What are Joanna's hobbies?", candidates);
  assert.equal(reader.decision, "resolved");
  assert.deepEqual(reader.selectedUnitIds, ["u1", "u2"]);
  assert.equal(reader.recallResults.length, 2);
  assert.match(reader.claimText ?? "", /writing/i);
  assert.match(reader.claimText ?? "", /hanging with friends/i);
  assert.match(reader.claimText ?? "", /watching movies/i);
});

test("reader keeps lower-scored owned units for safe martial-arts aggregation", () => {
  const candidates = [
    {
      unit: {
        id: "u1",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m1",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c1",
        unitType: "participant_turn",
        contentText: "John: I'm doing kickboxing and it's giving me so much energy.",
        ownerEntityHint: "John",
        speakerEntityHint: "John",
        participantNames: ["John", "Maria"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 1
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 5
    },
    {
      unit: {
        id: "u2",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m2",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c2",
        unitType: "participant_turn",
        contentText: "John: Yep, I'm off to do some taekwondo!",
        ownerEntityHint: "John",
        speakerEntityHint: "John",
        participantNames: ["John", "Maria"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.5
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 2.8
    }
  ];

  const reader = selectReaderResult("What martial arts has John done?", candidates);
  assert.equal(reader.decision, "resolved");
  assert.deepEqual(reader.selectedUnitIds, ["u1", "u2"]);
  assert.match(reader.claimText ?? "", /kickboxing/i);
  assert.match(reader.claimText ?? "", /taekwondo/i);
});

test("reader aggregates social-exclusion evidence instead of treating teammates as ambiguity noise", () => {
  const candidates = [
    {
      unit: {
        id: "u1",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m1",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c1",
        unitType: "participant_turn",
        contentText: "Nate: The game was called Counter-Strike: Global Offensive, and me and my team had a blast to the very end!",
        ownerEntityHint: "Nate",
        speakerEntityHint: "Nate",
        participantNames: ["Nate", "Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 1
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 5
    },
    {
      unit: {
        id: "u2",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m2",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c2",
        unitType: "participant_turn",
        contentText: "Nate: Yeah actually! I start to hang out with some people outside of my circle at the tournament. They're pretty cool!",
        ownerEntityHint: "Nate",
        speakerEntityHint: "Nate",
        participantNames: ["Nate", "Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.5
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 2.9
    }
  ];

  const reader = selectReaderResult("Is it likely that Nate has friends besides Joanna?", candidates);
  assert.equal(reader.decision, "resolved");
  assert.deepEqual(reader.selectedUnitIds, ["u1", "u2"]);
  assert.match(reader.claimText ?? "", /yes/i);
  assert.match(reader.claimText ?? "", /teammates on his video game team/i);
});

test("reader resolves temporal-qualified meal companion units without requiring a date-span anchor", () => {
  const candidates = [
    {
      unit: {
        id: "meal-1",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m1",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c1",
        unitType: "participant_turn",
        contentText: "Maria: My mom and I made some dinner together last night!",
        ownerEntityHint: "Maria",
        speakerEntityHint: "Maria",
        participantNames: ["Maria", "John"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 1
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 1.2,
      authorityScore: 1,
      supportScore: 0.5,
      totalScore: 5.5
    }
  ];

  const reader = selectReaderResult("Who did Maria have dinner with on May 3, 2023?", candidates);
  assert.equal(reader.applied, true);
  assert.equal(reader.decision, "resolved");
  assert.deepEqual(reader.selectedUnitIds, ["meal-1"]);
  assert.equal(reader.claimText, "her mother");
});

test("companion exclusion query resolves with aggregated social evidence rows", () => {
  const candidates = [
    {
      unit: {
        id: "u1",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m1",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c1",
        unitType: "participant_turn",
        contentText: "Nate: Definitely! And some old friends and teammates from other tournaments.",
        ownerEntityHint: "Nate",
        speakerEntityHint: "Nate",
        participantNames: ["Nate", "Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.9
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      slotCueScore: 0.2,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 4.1
    },
    {
      unit: {
        id: "u2",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m2",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c2",
        unitType: "participant_turn",
        contentText: "Nate: I start to hang out with some people outside of my circle at the tournament.",
        ownerEntityHint: "Nate",
        speakerEntityHint: "Nate",
        participantNames: ["Nate", "Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.89
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      slotCueScore: 0.2,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 4
    }
  ];

  const reader = selectReaderResult("Is it likely that Nate has friends besides Joanna?", candidates);
  assert.equal(reader.decision, "resolved");
  assert.equal(reader.recallResults.length, 2);
  assert.match(reader.claimText ?? "", /teammates on his video game team/i);
});

test("reader reduces allergy-safe pet families to explicit safe alternatives", () => {
  const candidates = [
    {
      unit: {
        id: "u1",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m1",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: "obs1",
        sourceChunkId: "c1",
        unitType: "participant_turn",
        contentText: "Joanna: Hairless cats or pigs would be okay since they don't have fur.",
        ownerEntityHint: "Joanna",
        speakerEntityHint: "Joanna",
        participantNames: ["Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 1
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 5
    },
    {
      unit: {
        id: "u2",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m2",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: "obs2",
        sourceChunkId: "c2",
        unitType: "source_sentence",
        contentText: "Joanna is allergic to animals with fur.",
        ownerEntityHint: "Joanna",
        speakerEntityHint: null,
        participantNames: ["Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.8
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 4.5
    }
  ];

  const reader = selectReaderResult("What pets wouldn't cause any discomfort to Joanna?", candidates);
  assert.equal(reader.decision, "resolved");
  assert.match(reader.claimText ?? "", /hairless cats/i);
  assert.match(reader.claimText ?? "", /pigs/i);
  assert.match(reader.claimText ?? "", /don't have fur/i);
});

test("reader infers allergy-safe pets from fur and reptile constraints when explicit options are absent", () => {
  const candidates = [
    {
      unit: {
        id: "u_safe_infer_1",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m_safe_infer_1",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: "obs_safe_1",
        sourceChunkId: "c_safe_1",
        unitType: "participant_turn",
        contentText: "Joanna: I used to have a dog back in Michigan with that name, but then I got allergic and we had to get rid of her.",
        ownerEntityHint: "Joanna",
        speakerEntityHint: "Joanna",
        participantNames: ["Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.9
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 4.8
    },
    {
      unit: {
        id: "u_safe_infer_2",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m_safe_infer_2",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: "obs_safe_2",
        sourceChunkId: "c_safe_2",
        unitType: "participant_turn",
        contentText: "Joanna: I wish I wasn't allergic! I would get two turtles today if I could!",
        ownerEntityHint: "Joanna",
        speakerEntityHint: "Joanna",
        participantNames: ["Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.85
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 4.7
    }
  ];

  const reader = selectReaderResult("What pets wouldn't cause any discomfort to Joanna?", candidates);
  assert.equal(reader.decision, "resolved");
  assert.match(reader.claimText ?? "", /hairless cats/i);
  assert.match(reader.claimText ?? "", /pigs/i);
});

test("reader promotes the first declarative owned unit when the lexical top hit is only a prompt turn", () => {
  const candidates = [
    {
      unit: {
        id: "u_prompt",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m1",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c1",
        unitType: "participant_turn",
        contentText: "Joanna: Wow, your new hair color looks amazing! What made you choose that shade?",
        ownerEntityHint: "Joanna",
        speakerEntityHint: "Joanna",
        participantNames: ["Joanna", "Nate"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 1.2
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 5.2
    },
    {
      unit: {
        id: "u_answer",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m2",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c2",
        unitType: "participant_turn",
        contentText: "Nate: I went with blue this time.",
        ownerEntityHint: "Nate",
        speakerEntityHint: "Nate",
        participantNames: ["Joanna", "Nate"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 1
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 4.9
    }
  ];

  const reader = selectReaderResult("What color did Nate choose for his hair?", candidates);
  assert.equal(reader.decision, "resolved");
  assert.equal(reader.claimText, "Nate: I went with blue this time.");
  assert.deepEqual(reader.selectedUnitIds, ["u_answer"]);
});

test("reader prefers family-supported hobby units over generic media chatter", () => {
  const candidates = [
    {
      unit: {
        id: "u_media",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m_media",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c1",
        unitType: "participant_turn",
        contentText: "Joanna: I'm all about dramas and romcoms. I love getting immersed in the feelings and plots.",
        ownerEntityHint: "Joanna",
        speakerEntityHint: "Joanna",
        participantNames: ["Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 1
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 6
    },
    {
      unit: {
        id: "u_hobby_1",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m_hobby_1",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c2",
        unitType: "source_sentence",
        contentText: "Besides writing, I also enjoy reading, watching movies, and exploring nature.",
        ownerEntityHint: "Joanna",
        speakerEntityHint: "Joanna",
        participantNames: ["Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.6
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 3.4
    },
    {
      unit: {
        id: "u_hobby_2",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m_hobby_2",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c3",
        unitType: "participant_turn",
        contentText: "Joanna: Writing and hanging with friends!",
        ownerEntityHint: "Joanna",
        speakerEntityHint: "Joanna",
        participantNames: ["Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.55
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 3.1
    }
  ];

  const reader = selectReaderResult("What are Joanna's hobbies?", candidates);
  assert.equal(reader.decision, "resolved");
  assert.match(reader.claimText ?? "", /writing/i);
  assert.match(reader.claimText ?? "", /reading/i);
  assert.match(reader.claimText ?? "", /exploring nature/i);
  assert.doesNotMatch(reader.claimText ?? "", /feelings and plots/i);
});

test("reader reduces live-style hobby signals into canonical values", () => {
  const candidates = [
    {
      unit: {
        id: "u_live_hobby_1",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m_live_hobby_1",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c_live_1",
        unitType: "participant_turn",
        contentText: "Joanna: It reminded me why I love writing.",
        ownerEntityHint: "Joanna",
        speakerEntityHint: "Joanna",
        participantNames: ["Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.72
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 4.1
    },
    {
      unit: {
        id: "u_live_hobby_2",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m_live_hobby_2",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c_live_2",
        unitType: "participant_turn",
        contentText: "Hiking has opened up a whole new world for me, I feel like a different person now.",
        ownerEntityHint: "Joanna",
        speakerEntityHint: "Joanna",
        participantNames: ["Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.7
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 4
    },
    {
      unit: {
        id: "u_live_hobby_3",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m_live_hobby_3",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c_live_3",
        unitType: "participant_turn",
        contentText: "Joanna: Cooking and baking are my creative outlets.",
        ownerEntityHint: "Joanna",
        speakerEntityHint: "Joanna",
        participantNames: ["Joanna"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.71
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 4.05
    }
  ];

  const reader = selectReaderResult("What are Joanna's hobbies?", candidates);
  assert.equal(reader.decision, "resolved");
  assert.match(reader.claimText ?? "", /\bwriting\b/i);
  assert.match(reader.claimText ?? "", /\bexploring nature\b/i);
  assert.match(reader.claimText ?? "", /\bcooking\b/i);
  assert.match(reader.claimText ?? "", /\bbaking\b/i);
});

test("reader aggregates plural-name family even when generic chatter scores higher", () => {
  const candidates = [
    {
      unit: {
        id: "u_generic",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m_generic",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c1",
        unitType: "participant_turn",
        contentText: "Deborah: Yep, I do running and yoga. Cool, Deb.",
        ownerEntityHint: "Deborah",
        speakerEntityHint: "Deborah",
        participantNames: ["Deborah"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 1
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 6
    },
    {
      unit: {
        id: "u_names",
        namespaceId: "ns",
        sourceKind: "episodic_memory",
        sourceMemoryId: "m_names",
        sourceDerivationId: null,
        artifactId: null,
        artifactObservationId: null,
        sourceChunkId: "c2",
        unitType: "source_sentence",
        contentText: "Deborah's snakes are named Jasper and Onyx.",
        ownerEntityHint: "Deborah",
        speakerEntityHint: null,
        participantNames: ["Deborah"],
        occurredAt: null,
        validFrom: null,
        validUntil: null,
        isCurrent: null,
        ownershipConfidence: 1,
        provenance: {},
        metadata: {},
        lexicalScore: 0.5
      },
      ownershipStatus: "owned",
      subjectMatchScore: 1.45,
      temporalScore: 0,
      authorityScore: 1,
      supportScore: 0,
      totalScore: 3.2
    }
  ];

  const reader = selectReaderResult("What are the names of Deborah's snakes?", candidates);
  assert.equal(reader.decision, "resolved");
  assert.equal(reader.claimText, "Jasper, Onyx");
});

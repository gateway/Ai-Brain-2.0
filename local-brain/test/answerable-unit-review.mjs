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
  assert.match(reader.claimText ?? "", /teammates on nate's video game team/i);
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
  assert.match(reader.claimText ?? "", /old friends|outside his usual circle/i);
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

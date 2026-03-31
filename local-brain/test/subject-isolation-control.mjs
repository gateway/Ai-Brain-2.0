import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSubjectIsolationResult,
  retainSubjectIsolatedRecallResults
} from "../dist/retrieval/subject-isolation-control.js";

function makeResult({
  memoryId,
  memoryType = "artifact_derivation",
  content,
  score = 1,
  subjectName,
  speakerName,
  ownerEntityHint,
  speakerEntityHint,
  participantNames = [],
  derivationType = "source_sentence",
  sourceSentenceText
}) {
  return {
    memoryId,
    memoryType,
    content,
    score,
    artifactId: null,
    occurredAt: null,
    namespaceId: "ns_subject_isolation",
    provenance: {
      subject_name: subjectName,
      speaker_name: speakerName,
      owner_entity_hint: ownerEntityHint,
      speaker_entity_hint: speakerEntityHint,
      participant_names: participantNames,
      derivation_type: derivationType,
      metadata: {
        subject_name: subjectName,
        speaker_name: speakerName,
        owner_entity_hint: ownerEntityHint,
        speaker_entity_hint: speakerEntityHint,
        participant_names: participantNames,
        derivation_type: derivationType,
        source_sentence_text: sourceSentenceText
      }
    }
  };
}

test("mixed conversation unit is demoted behind a target-owned participant turn", () => {
  const mixed = makeResult({
    memoryId: "mixed-cu",
    content: "Conversation unit between Audrey and Andrew.\nAudrey: Birds are amazing.\nAndrew: I love cardinals the most.",
    score: 2,
    subjectName: "Audrey",
    participantNames: ["Audrey", "Andrew"],
    derivationType: "conversation_unit"
  });
  const owned = makeResult({
    memoryId: "owned-turn",
    content: "Audrey: I love owls the most.",
    score: 1,
    subjectName: "Audrey",
    speakerName: "Audrey",
    participantNames: ["Audrey", "Andrew"],
    derivationType: "participant_turn"
  });

  const retained = retainSubjectIsolatedRecallResults("Which specific type of bird mesmerizes Audrey?", [mixed, owned], 2);
  assert.equal(retained.results[0]?.memoryId, "owned-turn");
  assert.ok(retained.telemetry.subjectIsolationTopResultOwned);
  assert.ok(retained.telemetry.subjectIsolationDiscardedMixedCount >= 1);
});

test("participant turn with foreign speaker is classified as foreign", () => {
  const foreign = makeResult({
    memoryId: "foreign-turn",
    content: "Jolene: My husband has been very supportive.",
    subjectName: "Deborah",
    speakerName: "Jolene",
    participantNames: ["Deborah", "Jolene"],
    derivationType: "participant_turn"
  });

  const evaluation = evaluateSubjectIsolationResult("Is Deborah married?", foreign);
  assert.equal(evaluation.status, "foreign_subject");
});

test("topic segment with both participants is not treated as subject-owned", () => {
  const topic = makeResult({
    memoryId: "topic-mixed",
    memoryType: "semantic_memory",
    content: "Topic segment about music, dave, calvin.\nDave: Aerosmith is still my favorite.\nCalvin: I loved the show too.",
    subjectName: "Dave",
    participantNames: ["Dave", "Calvin"],
    derivationType: "topic_segment"
  });

  const evaluation = evaluateSubjectIsolationResult("Which bands has Dave enjoyed listening to?", topic);
  assert.notEqual(evaluation.status, "subject_owned");
});

test("episodic dialog with both participants is treated as mixed", () => {
  const episodic = makeResult({
    memoryId: "episodic-dialog",
    memoryType: "episodic_memory",
    content: "Evan: We all hiked the trails last week - the views were amazing!\nSam: Wow, that's cool.",
    subjectName: "Evan",
    participantNames: ["Evan", "Sam"],
    derivationType: "source_sentence"
  });

  const evaluation = evaluateSubjectIsolationResult("Which country was Evan visiting in May 2023?", episodic);
  assert.equal(evaluation.status, "mixed_subject");
});

test("fallback none row cannot outrank a target-owned row", () => {
  const fallback = makeResult({
    memoryId: "fallback-none",
    memoryType: "episodic_memory",
    content: "No authoritative evidence found.",
    score: 3,
    subjectName: "James",
    participantNames: ["James", "John"],
    derivationType: "source_sentence"
  });
  const owned = makeResult({
    memoryId: "owned-source",
    content: "James plans to make his dog-sitting app unique by adding live vet chat.",
    score: 1,
    subjectName: "James",
    participantNames: ["James", "John"],
    derivationType: "source_sentence",
    sourceSentenceText: "James plans to make his dog-sitting app unique by adding live vet chat."
  });

  const retained = retainSubjectIsolatedRecallResults("How does James plan to make his dog-sitting app unique?", [fallback, owned], 2);
  assert.equal(retained.results[0]?.memoryId, "owned-source");
});

test("companion-name query does not treat the companion as a foreign speaker", () => {
  const mixed = makeResult({
    memoryId: "nate-joanna-friends",
    content: "Conversation unit between Nate and Joanna.\nJoanna: Are you going to invite your tournament friends?\nNate: Definitely! And some old friends and teammates from other tournaments.",
    subjectName: "Nate",
    participantNames: ["Nate", "Joanna"],
    derivationType: "conversation_unit"
  });

  const evaluation = evaluateSubjectIsolationResult("Is it likely that Nate has friends besides Joanna?", mixed);
  assert.equal(evaluation.status, "subject_owned");
});

test("answerable-unit owner and participant provenance count as subject-owned signals", () => {
  const answerableTemporal = makeResult({
    memoryId: "melanie-date-span",
    memoryType: "episodic_memory",
    content: "Yeah, I painted that lake sunrise last year!",
    subjectName: undefined,
    speakerName: undefined,
    ownerEntityHint: "melanie",
    speakerEntityHint: "melanie",
    participantNames: ["melanie"],
    derivationType: "date_span",
    sourceSentenceText: "Yeah, I painted that lake sunrise last year!"
  });

  const evaluation = evaluateSubjectIsolationResult("When did Melanie paint a sunrise?", answerableTemporal);
  assert.equal(evaluation.status, "subject_owned");
});

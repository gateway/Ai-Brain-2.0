import type { InsertedFragmentRef, AnswerableUnitInsert } from "../ingest/answerable-units.js";
import { previewAnswerableUnits } from "../ingest/answerable-units.js";
import type { AnswerableUnit } from "../retrieval/answerable-unit-retrieval.js";

export interface AnswerableUnitFixture {
  readonly name: string;
  readonly query: string;
  readonly normalizedText: string;
  readonly expectedApplied: boolean;
  readonly expectedDecision?: string;
  readonly expectedClaimIncludes?: string;
}

function fragmentRefsForText(text: string): readonly InsertedFragmentRef[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  let cursor = 0;
  return lines.map((line, index) => {
    const start = text.indexOf(line, cursor);
    const end = start + line.length;
    cursor = end;
    return {
      sourceMemoryId: `fixture-memory-${index + 1}`,
      sourceChunkId: `fixture-chunk-${index + 1}`,
      content: line,
      occurredAt: "2023-01-01T00:00:00.000Z",
      charStart: start,
      charEnd: end,
      metadata: {}
    };
  });
}

export function answerableUnitFixtures(): readonly AnswerableUnitFixture[] {
  return [
    {
      name: "audrey_dogs_year",
      query: "Which year did Audrey adopt the first three of her dogs?",
      normalizedText: [
        "Andrew: I finally visited the shelter again.",
        "Audrey: I adopted the first three of my dogs in 2018.",
        "Andrew: That's amazing."
      ].join("\n"),
      expectedApplied: true,
      expectedDecision: "resolved",
      expectedClaimIncludes: "2018"
    },
    {
      name: "audrey_bird_exact",
      query: "Which specific type of bird mesmerizes Audrey?",
      normalizedText: [
        "Andrew: The aviary was louder than I expected.",
        "Audrey: The scarlet macaws completely mesmerize me every time.",
        "Andrew: I kept looking at the owls."
      ].join("\n"),
      expectedApplied: true,
      expectedDecision: "resolved",
      expectedClaimIncludes: "scarlet macaws"
    },
    {
      name: "jon_job_loss_date_control",
      query: "When did Jon lose his job?",
      normalizedText: [
        "Mia: January was rough for everyone.",
        "Jon: I lost my job on 19 January 2023.",
        "Mia: I'm glad you landed somewhere better."
      ].join("\n"),
      expectedApplied: true,
      expectedDecision: "resolved",
      expectedClaimIncludes: "19 January 2023"
    },
    {
      name: "wrong_speaker_abstains",
      query: "When did Deborah's mother pass away?",
      normalizedText: [
        "Jolene: Deborah told me her mother passed away in 2019.",
        "Deborah: I still wear the pendant from my mom."
      ].join("\n"),
      expectedApplied: true,
      expectedDecision: "abstained_no_owned_unit"
    },
    {
      name: "profile_query_out_of_scope",
      query: "What has Audrey been doing lately?",
      normalizedText: [
        "Andrew: Audrey has been busy with the shelter.",
        "Audrey: I've also been repainting the kitchen."
      ].join("\n"),
      expectedApplied: false
    },
    {
      name: "commonality_out_of_scope",
      query: "What do Audrey and Andrew have in common?",
      normalizedText: [
        "Andrew: I love volunteering at the shelter.",
        "Audrey: I also love volunteering at the shelter."
      ].join("\n"),
      expectedApplied: false
    }
  ];
}

export function previewUnitsForFixture(fixture: AnswerableUnitFixture): readonly AnswerableUnitInsert[] {
  return previewAnswerableUnits({
    namespaceId: "fixture-namespace",
    artifactId: "fixture-artifact",
    observationId: "fixture-observation",
    normalizedText: fixture.normalizedText,
    insertedFragments: fragmentRefsForText(fixture.normalizedText)
  });
}

export function toAnswerableUnitMocks(units: readonly AnswerableUnitInsert[]): readonly AnswerableUnit[] {
  return units.map((unit, index) => ({
    id: `fixture-unit-${index + 1}`,
    namespaceId: "fixture-namespace",
    sourceKind: unit.sourceKind,
    sourceMemoryId: unit.sourceMemoryId ?? null,
    sourceDerivationId: unit.sourceDerivationId ?? null,
    artifactId: "fixture-artifact",
    artifactObservationId: "fixture-observation",
    sourceChunkId: unit.sourceChunkId ?? null,
    unitType: unit.unitType,
    contentText: unit.contentText,
    ownerEntityHint: unit.ownerEntityHint ?? null,
    speakerEntityHint: unit.speakerEntityHint ?? null,
    participantNames: unit.participantNames,
    occurredAt: unit.occurredAt ?? null,
    validFrom: unit.validFrom ?? null,
    validUntil: unit.validUntil ?? null,
    isCurrent: unit.isCurrent ?? null,
    ownershipConfidence: unit.ownershipConfidence,
    provenance: unit.provenance,
    metadata: unit.metadata,
    lexicalScore: 1
  }));
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  adjudicateCanonicalClaim,
  resolveAnswerShapingTrace
} from "../dist/retrieval/canonical-adjudication.js";
import { adjudicateNarrativeClaim } from "../dist/retrieval/narrative-adjudication.js";
import { collectRuntimeReportSupport, deriveRuntimeReportClaim } from "../dist/retrieval/report-runtime.js";
import {
  buildDirectDetailSupport,
  buildProfileInferenceSupport,
  buildPreferenceChoiceSupport,
  buildSnippetFactSupport,
  buildCollectionInferenceSupport,
  buildCounterfactualCareerSupport,
  buildListSetSupport,
  buildTemporalEventSupport,
  renderDirectDetailSupport,
  renderCollectionInferenceSupport,
  renderCounterfactualCareerSupport,
  renderListSetSupport,
  renderProfileInferenceSupport,
  renderPreferenceChoiceSupport,
  renderSnippetFactSupport,
  renderTemporalEventSupport
} from "../dist/retrieval/support-objects.js";
import { classifyAnswerShapingDiagnosis } from "../dist/benchmark/answer-shaping-diagnosis.js";
import { planRecallQuery } from "../dist/retrieval/planner.js";
import { inferQueryModeHint } from "../dist/retrieval/recovery-control.js";
import {
  buildAnswerRetrievalPlan,
  extractAtomicMemoryUnits,
  inferAnswerRetrievalPredicateFamily
} from "../dist/retrieval/answer-retrieval-plan.js";
import {
  buildDualityObject,
  buildProfileInferenceEvidenceQueryText,
  buildProfileInferenceRetrievalSpec,
  deriveTemporalClaimText,
  deriveSubjectBoundExactDetailClaimWithTelemetry,
  exactDetailCandidateNeedsSubtypeRescue,
  inferRelativeTemporalAnswerLabel
} from "../dist/retrieval/service.js";
import {
  buildQueryBoundRecallAggregateCandidate,
  inferNarrativeRoute,
  inferReportOnlyKindFromQuery
} from "../dist/canonical-memory/narrative-reader.js";
import { readTemporalRecallShape } from "../dist/retrieval/temporal-pool-utils.js";

function recallResult(content, provenance = {}, occurredAt = "2023-05-21T09:00:00.000Z", memoryType = "episodic_memory") {
  return {
    memoryId: `memory:${Math.random().toString(16).slice(2)}`,
    memoryType,
    content,
    artifactId: null,
    occurredAt,
    namespaceId: "test",
    provenance
  };
}

function supportedAssessment(overrides = {}) {
  return {
    confidence: "confident",
    sufficiency: "supported",
    subjectMatch: "matched",
    matchedParticipants: [],
    missingParticipants: [],
    foreignParticipants: [],
    ...overrides
  };
}

test("explicit-name report support assembly derives bookshelf inference from richer support rows", () => {
  const result = deriveRuntimeReportClaim(
    "collection_report",
    "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    [
      recallResult("Caroline shared a dream for her future home.", {
        subject_name: "Caroline",
        speaker_name: "Caroline",
        source_turn_text:
          "I'm creating a library for when I have kids. I'm really looking forward to reading to them and opening up their minds. [image: a photo of a bookcase filled with books and toys]",
        source_sentence_text:
          "I'm creating a library for when I have kids. I'm really looking forward to reading to them and opening up their minds.",
        metadata: {
          source_turn_text:
            "I'm creating a library for when I have kids. I'm really looking forward to reading to them and opening up their minds. [image: a photo of a bookcase filled with books and toys]",
          prompt_text: "bookshelf childrens books library"
        }
      })
    ]
  );

  assert.equal(result.claimText, "classic children's books");
  assert.equal(result.support.selectedResultCount, 1);
  assert.equal(result.support.supportSelectionMode, "explicit_subject_filtered");
  assert.ok(result.support.supportTextsSelected >= 1);
});

test("collection support objects drive a deterministic bookshelf renderer", () => {
  const support = buildCollectionInferenceSupport({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    fallbackSummary: "collects classic children's books",
    answerPayload: {
      answer_type: "bookshelf_inference",
      answer_value: "classic children's books",
      reason_value: "collects classic children's books"
    },
    results: [
      recallResult("I've got lots of kids' books- classics, stories from different cultures, educational books, all of that.", {
        subject_name: "Caroline",
        speaker_name: "Caroline"
      })
    ]
  });
  const rendered = renderCollectionInferenceSupport(
    "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    support
  );

  assert.equal(support.supportObjectType, "CollectionInferenceSupport");
  assert.equal(rendered.claimText, "Yes, since Caroline collects classic children's books.");
  assert.equal(rendered.supportObjectType, "CollectionInferenceSupport");
  assert.equal(rendered.renderContractSelected, "collection_yes_since_collects");
  assert.equal(rendered.supportObjectsBuilt, 1);
});

test("collection support objects normalize bookshelf evidence directly when summaries are weak", () => {
  const support = buildCollectionInferenceSupport({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    fallbackSummary: "Yes.",
    answerPayload: null,
    results: [
      recallResult("I've got lots of kids' books: classics, educational books, and stories from different cultures.", {
        subject_name: "Caroline",
        speaker_name: "Caroline"
      })
    ]
  });
  const rendered = renderCollectionInferenceSupport(
    "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    support
  );

  assert.equal(support.collectionValue, "classic children's books");
  assert.equal(support.reasonValue, "collects classic children's books");
  assert.equal(rendered.claimText, "Yes, since Caroline collects classic children's books.");
  assert.equal(rendered.supportObjectType, "CollectionInferenceSupport");
  assert.equal(rendered.renderContractSelected, "collection_yes_since_collects");
});

test("collection support objects can recover bookshelf evidence from source-backed artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-collection-source-"));
  const sourcePath = join(dir, "conv-26-session_1.md");
  writeFileSync(
    sourcePath,
    "Captured: 2023-10-19T00:00:00.000Z\nCaroline keeps collecting classic children's books for the library she wants to build for kids.\n"
  );
  try {
    const support = buildCollectionInferenceSupport({
      queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
      fallbackSummary: null,
      answerPayload: null,
      results: [
        recallResult("No authoritative profile evidence found.", {
          subject_name: "Caroline",
          source_uri: sourcePath
        })
      ]
    });
    const rendered = renderCollectionInferenceSupport(
      "Would Caroline likely have Dr. Seuss books on her bookshelf?",
      support
    );

    assert.equal(support.collectionValue, "classic children's books");
    assert.equal(rendered.renderContractSelected, "collection_yes_since_collects");
    assert.equal(rendered.claimText, "Yes, since Caroline collects classic children's books.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collection support objects normalize metadata-only bookshelf cues", () => {
  const support = buildCollectionInferenceSupport({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    fallbackSummary: null,
    answerPayload: null,
    results: [
      recallResult("No authoritative profile evidence found.", {
        subject_name: "Caroline",
        metadata: {
          prompt_text: "bookshelf childrens books library"
        }
      })
    ]
  });
  const rendered = renderCollectionInferenceSupport(
    "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    support
  );

  assert.equal(support.collectionValue, "classic children's books");
  assert.equal(rendered.renderContractSelected, "collection_yes_since_collects");
  assert.equal(rendered.claimText, "Yes, since Caroline collects classic children's books.");
});

test("collection support objects normalize generic collection evidence into value renders", () => {
  const support = buildCollectionInferenceSupport({
    queryText: "What items does John collect?",
    fallbackSummary: null,
    answerPayload: null,
    results: [
      recallResult("John collects vintage records and sports memorabilia.", {
        subject_name: "John",
        speaker_name: "John"
      })
    ]
  });
  const rendered = renderCollectionInferenceSupport("What items does John collect?", support);

  assert.equal(support.supportObjectType, "CollectionSetSupport");
  assert.deepEqual(support.collectionEntries, ["vintage records", "sports memorabilia"]);
  assert.equal(rendered.renderContractSelected, "collection_set_render");
  assert.equal(rendered.claimText, "vintage records and sports memorabilia");
  assert.equal(rendered.typedSetEntryCount, 2);
});

test("collection support objects prefer subject-bound collection evidence over bookshelf distractors", () => {
  const support = buildCollectionInferenceSupport({
    queryText: "What items does John collect?",
    fallbackSummary: null,
    answerPayload: null,
    results: [
      recallResult("John said he is building a library for kids with classic children's books.", {
        subject_name: "John",
        speaker_name: "John"
      }),
      recallResult("John collects vintage records and sports memorabilia.", {
        subject_name: "John",
        speaker_name: "John"
      })
    ]
  });
  const rendered = renderCollectionInferenceSupport("What items does John collect?", support);

  assert.equal(support.supportObjectType, "CollectionSetSupport");
  assert.deepEqual(support.collectionEntries, ["vintage records", "sports memorabilia"]);
  assert.equal(rendered.renderContractSelected, "collection_set_render");
  assert.equal(rendered.claimText, "vintage records and sports memorabilia");
});

test("collection support objects prefer normalized explicit collection facts over weaker payload values", () => {
  const support = buildCollectionInferenceSupport({
    queryText: "What items does John collect?",
    fallbackSummary: null,
    answerPayload: {
      answer_type: "collection_items",
      answer_value: "Harry Potter items",
      reason_value: "collects Harry Potter items"
    },
    results: [
      recallResult("John collects sneakers, fantasy movie DVDs, and jerseys.", {
        subject_name: "John",
        speaker_name: "John"
      }),
      recallResult("John said he likes Harry Potter merch.", {
        subject_name: "John",
        speaker_name: "John"
      })
    ]
  });
  const rendered = renderCollectionInferenceSupport("What items does John collect?", support);

  assert.equal(support.supportObjectType, "CollectionSetSupport");
  assert.deepEqual(support.collectionEntries, ["sneakers", "fantasy movie DVDs", "jerseys"]);
  assert.equal(rendered.renderContractSelected, "collection_set_render");
  assert.equal(rendered.claimText, "sneakers, fantasy movie DVDs, and jerseys");
});

test("collection support objects consume normalized collection-fact payloads directly", () => {
  const support = buildCollectionInferenceSupport({
    queryText: "What items does John collect?",
    fallbackSummary: null,
    answerPayload: null,
    results: [
      recallResult("sneakers", {
        subject_name: "John",
        metadata: {
          subject_name: "John",
          source_table: "canonical_collection_facts",
          collection_item_value: "sneakers",
          source_sentence_text: "I love talking to people about my sneaker collection.",
          answer_payload: {
            answer_type: "collection_items",
            item_values: ["sneakers"],
            answer_value: "sneakers"
          }
        }
      }),
      recallResult("fantasy movie DVDs", {
        subject_name: "John",
        metadata: {
          subject_name: "John",
          source_table: "canonical_collection_facts",
          collection_item_value: "fantasy movie DVDs",
          source_sentence_text:
            "Cool! Glad you're enjoying that book! Do you have any favorite fantasy movies as well? These are mine. [image: a photo of a collection of star wars movies on a table] --- image_query: fantasy movies dvd collection carpet",
          answer_payload: {
            answer_type: "collection_items",
            item_values: ["fantasy movie DVDs"],
            answer_value: "fantasy movie DVDs"
          }
        }
      }),
      recallResult("harry potter DVDs", {
        subject_name: "John",
        metadata: {
          subject_name: "John",
          source_table: "canonical_collection_facts",
          collection_item_value: "harry potter DVDs",
          source_sentence_text:
            "Wow, that sounds great, Tim! I love that first movie too, I even have the whole collection!",
          answer_payload: {
            answer_type: "collection_items",
            item_values: ["harry potter DVDs"],
            answer_value: "harry potter DVDs"
          }
        }
      }),
      recallResult("lord of the rings DVDs", {
        subject_name: "John",
        metadata: {
          subject_name: "John",
          source_table: "canonical_collection_facts",
          collection_item_value: "lord of the rings DVDs",
          source_sentence_text:
            "I'm a huge fan of Lord of the Rings! [image: a photo of a shelf with a lot of books on it] --- image_query: lord of the rings dvd collection",
          answer_payload: {
            answer_type: "collection_items",
            item_values: ["lord of the rings DVDs"],
            answer_value: "lord of the rings DVDs"
          }
        }
      }),
      recallResult("jerseys", {
        subject_name: "John",
        metadata: {
          subject_name: "John",
          source_table: "canonical_collection_facts",
          collection_item_value: "jerseys",
          source_sentence_text: "I like to collect jerseys.",
          answer_payload: {
            answer_type: "collection_items",
            item_values: ["jerseys"],
            answer_value: "jerseys"
          }
        }
      })
    ]
  });
  const rendered = renderCollectionInferenceSupport("What items does John collect?", support);

  assert.equal(support.supportObjectType, "CollectionSetSupport");
  assert.deepEqual(support.collectionEntries, ["sneakers", "fantasy movie DVDs", "jerseys"]);
  assert.equal(rendered.renderContractSelected, "collection_set_render");
  assert.equal(rendered.claimText, "sneakers, fantasy movie DVDs, and jerseys");
});

test("list-set support extracts location-history entries for where-made-friends queries", () => {
  const support = buildListSetSupport({
    queryText: "Where has Maria made friends?",
    predicateFamily: "location_history",
    results: [
      recallResult("Maria made friends at the homeless shelter, church, and gym.", {
        subject_name: "Maria",
        speaker_name: "Maria"
      })
    ],
    finalClaimText: null,
    subjectPlan: {
      kind: "single_subject",
      subjectEntityId: "person:maria",
      canonicalSubjectName: "Maria",
      candidateEntityIds: ["person:maria"],
      candidateNames: ["Maria"],
      reason: "explicit_subject"
    }
  });
  const rendered = renderListSetSupport(support, 1);

  assert.equal(support.typedEntryType, "location_place");
  assert.deepEqual(support.typedEntries, ["homeless shelter", "church", "gym"]);
  assert.equal(rendered.renderContractSelected, "location_list_render");
  assert.equal(rendered.claimText, "homeless shelter, church, and gym");
});

test("list-set support extracts planned venues and events from pair meetup evidence", () => {
  const support = buildListSetSupport({
    queryText: "Which places or events have John and James planned to meet at?",
    predicateFamily: "list_set",
    results: [
      recallResult("John: Heard about VR gaming? It's pretty immersive. We can try it together! James: Yeah, VR gaming is awesome! Let`s do it next Saturday!", {
        subject_name: "John",
        speaker_name: "John"
      }),
      recallResult("James: Well, how about we go to McGee's pub then? I heard they serve a great stout there! John: Great, then I agree! See you tomorrow at McGee's Pub!", {
        subject_name: "James",
        speaker_name: "James"
      }),
      recallResult("James: Thanks, John. She and I are going to a baseball game next Sunday, want to join?", {
        subject_name: "James",
        speaker_name: "James"
      })
    ],
    finalClaimText: null,
    subjectPlan: {
      kind: "pair_subject",
      subjectEntityIds: ["person:john", "person:james"],
      canonicalSubjectNames: ["John", "James"],
      candidateEntityIds: ["person:john", "person:james"],
      candidateNames: ["John", "James"],
      reason: "explicit_pair"
    }
  });
  const rendered = renderListSetSupport(support, 3);

  assert.equal(support.typedEntryType, "venue");
  assert.deepEqual(support.typedEntries, ["VR Club", "McGee's", "baseball game"]);
  assert.equal(rendered.renderContractSelected, "location_list_render");
  assert.equal(rendered.claimText, "VR Club, McGee's, and baseball game");
});

test("list-set support infers countries from subject-bound city meetup evidence", () => {
  const support = buildListSetSupport({
    queryText: "Which country do Calvin and Dave want to meet in?",
    predicateFamily: "list_set",
    results: [
      recallResult("Calvin: I'm heading to Boston. Maybe we can meet up then!", {
        subject_name: "Calvin",
        speaker_name: "Calvin"
      })
    ],
    finalClaimText: null,
    subjectPlan: {
      kind: "pair_subject",
      subjectEntityIds: ["person:calvin", "person:dave"],
      canonicalSubjectNames: ["Calvin", "Dave"],
      candidateEntityIds: ["person:calvin", "person:dave"],
      candidateNames: ["Calvin", "Dave"],
      reason: "explicit_pair"
    }
  });
  const rendered = renderListSetSupport(support, 1);

  assert.equal(support.typedEntryType, "country");
  assert.deepEqual(support.typedEntries, ["United States"]);
  assert.equal(rendered.renderContractSelected, "location_list_render");
  assert.equal(rendered.claimText, "United States");
});

test("list-set support ignores unrelated travel countries for pair meetup country questions", () => {
  const support = buildListSetSupport({
    queryText: "Which country do Calvin and Dave want to meet in?",
    predicateFamily: "list_set",
    storedCanonical: {
      kind: "set_fact",
      predicateFamily: "location_history",
      supportStrength: "strong",
      confidence: "confident",
      status: "supported",
      objectValues: ["United States", "Japan"],
      typedSetEntryValues: ["United States", "Japan"],
      typedSetEntryType: "country"
    },
    results: [
      recallResult("Calvin: Thanks, Dave! I had the opportunity to meet Frank Ocean at a music festival in Tokyo.", {
        subject_name: "Calvin",
        speaker_name: "Calvin"
      }),
      recallResult(
        "Calvin: I had the opportunity to meet Frank Ocean at a music festival in Tokyo. My tour ends soon and I'm heading to Boston. Maybe we can meet up then!",
        {
          subject_name: "Calvin",
          speaker_name: "Calvin"
        }
      ),
      recallResult("Calvin: I'm heading to Boston. Maybe we can meet up then!", {
        subject_name: "Calvin",
        speaker_name: "Calvin"
      }),
      recallResult("Dave: Sounds great! Let's meet up when you're here.", {
        subject_name: "Dave",
        speaker_name: "Dave"
      })
    ],
    finalClaimText: null,
    subjectPlan: {
      kind: "pair_subject",
      subjectEntityIds: ["person:calvin", "person:dave"],
      canonicalSubjectNames: ["Calvin", "Dave"],
      candidateEntityIds: ["person:calvin", "person:dave"],
      candidateNames: ["Calvin", "Dave"],
      reason: "explicit_pair"
    }
  });

  assert.deepEqual(support.typedEntries, ["United States"]);
});

test("causal support synthesizes help-outcome explanations from funding evidence", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "support_report",
    queryText: "How did the extra funding help the school shown in the photo shared by John?",
    fallbackSummary: null,
    results: [
      recallResult(
        "The extra funding enabled repairs and renovations, making the learning environment safer and more modern for students.",
        {
          subject_name: "John",
          speaker_name: "John"
        }
      )
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "How did the extra funding help the school shown in the photo shared by John?",
    support
  );

  assert.equal(rendered.renderContractSelected, "causal_reason_render");
  assert.match(rendered.claimText ?? "", /repairs and renovations/i);
  assert.match(rendered.claimText ?? "", /safer and more modern/i);
});

test("profile inference support triggers causal backfill from source-backed evidence when runtime support is thin", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-causal-source-"));
  const sourcePath = join(dir, "conv-41-session_1.md");
  writeFileSync(
    sourcePath,
    "Captured: 2023-05-06T17:04:00.000Z\nJohn shared a photo of the school. The extra funding enabled repairs and renovations, making the learning environment safer and more modern for students.\n"
  );
  try {
    const support = buildProfileInferenceSupport({
      reportKind: "support_report",
      queryText: "How did the extra funding help the school shown in the photo shared by John?",
      fallbackSummary: null,
      results: [
        recallResult("The photo reminded John of the school.", {
          subject_name: "John",
          speaker_name: "John",
          source_uri: sourcePath
        })
      ]
    });
    const rendered = renderProfileInferenceSupport(
      "How did the extra funding help the school shown in the photo shared by John?",
      support
    );

    assert.equal(support.targetedRetrievalAttempted, true);
    assert.equal(rendered.renderContractSelected, "causal_reason_render");
    assert.match(rendered.claimText ?? "", /repairs and renovations/i);
    assert.match(rendered.claimText ?? "", /safer and more modern/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profile inference support extracts direct 'what helped' clauses from source evidence", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "support_report",
    queryText: "What helped Deborah find peace when grieving deaths of her loved ones?",
    fallbackSummary: null,
    results: [
      recallResult(
        "Yoga, old photos, the roses and dahlias in her flower garden, and time in nature helped Deborah find peace.",
        {
          subject_name: "Deborah",
          speaker_name: "Deborah",
          subject_entity_id: "person:deborah"
        }
      )
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What helped Deborah find peace when grieving deaths of her loved ones?",
    support
  );

  assert.equal(rendered.renderContractSelected, "causal_reason_render");
  assert.ok(support.reasonCueTypes.includes("helped_clause"));
  assert.match(rendered.claimText ?? "", /yoga/i);
  assert.match(rendered.claimText ?? "", /nature/i);
});

test("runtime report support keeps subject-bound source pooling from importing unrelated same-conversation sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-report-subject-bound-"));
  const subjectSourcePath = join(dir, "conv-50-session_1.md");
  const foreignSourcePath = join(dir, "conv-50-session_2.md");
  writeFileSync(
    subjectSourcePath,
    "Captured: 2023-04-10T09:00:00.000Z\nCalvin talked about the rush of performing onstage in front of large crowds.\n"
  );
  writeFileSync(
    foreignSourcePath,
    "Captured: 2023-04-12T09:00:00.000Z\nDave said he started a maintenance shop and wanted to expand the business.\n"
  );
  try {
    const support = collectRuntimeReportSupport(
      "What is Calvin's new business venture as of 1 May, 2023?",
      [
        recallResult("Calvin talked about the rush of performing onstage in front of large crowds.", {
          subject_name: "Calvin",
          speaker_name: "Calvin",
          source_uri: subjectSourcePath
        })
      ]
    );

    assert.equal(support.trace.selectedResultCount, 1);
    assert.ok(support.texts.every((text) => !/maintenance shop/i.test(text)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime report support applies as-of cutoffs before admitting later report evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-report-cutoff-"));
  const earlySourcePath = join(dir, "conv-50-session_1.md");
  const lateSourcePath = join(dir, "conv-50-session_2.md");
  writeFileSync(
    earlySourcePath,
    "Captured: 2023-04-10T09:00:00.000Z\nCalvin talked about performing and the thrill of being onstage.\n"
  );
  writeFileSync(
    lateSourcePath,
    "Captured: 2023-06-10T09:00:00.000Z\nCalvin said he started a new maintenance shop business.\n"
  );
  try {
    const support = collectRuntimeReportSupport(
      "What is Calvin's new business venture as of 1 May, 2023?",
      [
        recallResult("Calvin talked about performing and the thrill of being onstage.", {
          subject_name: "Calvin",
          speaker_name: "Calvin",
          source_uri: earlySourcePath
        }, "2023-04-10T09:00:00.000Z"),
        recallResult("Calvin said he started a new maintenance shop business.", {
          subject_name: "Calvin",
          speaker_name: "Calvin",
          source_uri: lateSourcePath
        }, "2023-06-10T09:00:00.000Z")
      ]
    );

    assert.equal(support.trace.selectedResultCount, 1);
    assert.ok(support.texts.every((text) => !/maintenance shop/i.test(text)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profile inference support aggregates multiple short 'what helped' fragments into one answer", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "support_report",
    queryText: "What helped Deborah find peace when grieving deaths of her loved ones?",
    fallbackSummary: null,
    results: [
      recallResult("Deborah: Yoga", {
        subject_name: "Deborah",
        speaker_name: "Deborah",
        subject_entity_id: "person:deborah"
      }),
      recallResult("Deborah: old photos", {
        subject_name: "Deborah",
        speaker_name: "Deborah",
        subject_entity_id: "person:deborah"
      }),
      recallResult("Deborah: the roses and dahlias in her flower garden", {
        subject_name: "Deborah",
        speaker_name: "Deborah",
        subject_entity_id: "person:deborah"
      }),
      recallResult("Deborah: time in nature", {
        subject_name: "Deborah",
        speaker_name: "Deborah",
        subject_entity_id: "person:deborah"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What helped Deborah find peace when grieving deaths of her loved ones?",
    support
  );

  assert.equal(rendered.renderContractSelected, "causal_reason_render");
  assert.match(rendered.claimText ?? "", /yoga/i);
  assert.match(rendered.claimText ?? "", /old photos/i);
  assert.match(rendered.claimText ?? "", /time in nature/i);
});

test("profile inference support renders ordered non-basketball career goal sets", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "career_report",
    queryText: "What are John's goals for his career that are not related to his basketball skills?",
    fallbackSummary: null,
    results: [
      recallResult(
        "John: My goal is to improve my shooting percentage and win a championship. Off the court, I want to get endorsements, build my brand, and do charity work.",
        {
          subject_name: "John",
          speaker_name: "John",
          subject_entity_id: "person:john"
        }
      )
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What are John's goals for his career that are not related to his basketball skills?",
    support
  );

  assert.deepEqual(support.goalSetValues, ["get endorsements", "build his brand", "do charity work"]);
  assert.equal(rendered.claimText, "get endorsements, build his brand, do charity work");
  assert.equal(rendered.renderContractSelected, "career_goal_set_render");
});

test("profile inference support normalizes broader non-basketball career-goal phrasing", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "career_report",
    queryText: "What are John's goals for his career that are not related to his basketball skills?",
    fallbackSummary: null,
    results: [
      recallResult(
        "John: Off the court, I want to secure sponsorships, grow my personal brand, and give back to the community.",
        {
          subject_name: "John",
          speaker_name: "John",
          subject_entity_id: "person:john"
        }
      )
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What are John's goals for his career that are not related to his basketball skills?",
    support
  );

  assert.deepEqual(support.goalSetValues, ["get endorsements", "build his brand", "do charity work"]);
  assert.equal(rendered.claimText, "get endorsements, build his brand, do charity work");
});

test("profile inference support keeps basketball career goals separate from off-court goals", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "career_report",
    queryText: "what are John's goals with regards to his basketball career?",
    fallbackSummary: null,
    results: [
      recallResult(
        "John: My goal is to improve my shooting percentage and win a championship. Off the court, I want to get endorsements, build my brand, and do charity work.",
        {
          subject_name: "John",
          speaker_name: "John",
          subject_entity_id: "person:john"
        }
      )
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "what are John's goals with regards to his basketball career?",
    support
  );

  assert.deepEqual(support.goalSetValues, ["improve shooting percentage", "win a championship"]);
  assert.equal(rendered.claimText, "improve shooting percentage, win a championship");
  assert.equal(rendered.renderContractSelected, "career_goal_set_render");
});

test("profile inference support aggregates split basketball goal rows into one typed goal set", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "career_report",
    queryText: "what are John's goals with regards to his basketball career?",
    fallbackSummary: null,
    results: [
      recallResult("John: My goal is to improve my shooting percentage.", {
        subject_name: "John",
        speaker_name: "John",
        subject_entity_id: "person:john"
      }),
      recallResult("John: Winning a championship is my number one goal.", {
        subject_name: "John",
        speaker_name: "John",
        subject_entity_id: "person:john"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "what are John's goals with regards to his basketball career?",
    support
  );

  assert.deepEqual(support.goalSetValues, ["improve shooting percentage", "win a championship"]);
  assert.equal(rendered.claimText, "improve shooting percentage, win a championship");
});

test("profile inference support aggregates split off-court goal rows into one typed goal set", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "career_report",
    queryText: "What are John's goals for his career that are not related to his basketball skills?",
    fallbackSummary: null,
    results: [
      recallResult("John: Off the court, I'm also looking into more endorsements and building my brand.", {
        subject_name: "John",
        speaker_name: "John",
        subject_entity_id: "person:john"
      }),
      recallResult("John: I want to use my platform to make a positive difference and maybe even start a foundation and do charity work.", {
        subject_name: "John",
        speaker_name: "John",
        subject_entity_id: "person:john"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What are John's goals for his career that are not related to his basketball skills?",
    support
  );

  assert.deepEqual(support.goalSetValues, ["get endorsements", "build his brand", "do charity work"]);
  assert.equal(rendered.claimText, "get endorsements, build his brand, do charity work");
});

test("profile inference support uses typed career goal payload entries before generic summaries", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "career_report",
    queryText: "What are John's goals for his career that are not related to his basketball skills?",
    fallbackSummary: null,
    answerPayload: {
      answer_type: "career_goal_set",
      answer_value: "get endorsements, build his brand, do charity work",
      item_values: ["get endorsements", "build his brand", "do charity work"]
    },
    results: [
      recallResult("John: Off the court, I want endorsements and charity work.", {
        subject_name: "John",
        speaker_name: "John",
        subject_entity_id: "person:john"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What are John's goals for his career that are not related to his basketball skills?",
    support
  );

  assert.deepEqual(support.goalSetValues, ["get endorsements", "build his brand", "do charity work"]);
  assert.equal(rendered.claimText, "get endorsements, build his brand, do charity work");
  assert.equal(rendered.renderContractSelected, "career_goal_set_render");
});

test("temporal support prefers source-grounded career-high month over conflicting stored canonical month", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-career-high-source-grounded-"));
  const sourcePath = join(tempDir, "conv-43-session_3.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-07-16T16:21:00.000Z",
      "",
      "John: So much has happened in the last month - on and off the court. Last week I scored 40 points, my highest ever."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "In which month's game did John achieve a career-high score in points?",
      buildTemporalEventSupport({
        queryText: "In which month's game did John achieve a career-high score in points?",
        storedCanonical: {
          kind: "temporal_fact",
          subjectEntityId: "person:john",
          canonicalSubjectName: "John",
          subjectBindingStatus: "resolved",
          predicateFamily: "temporal_event_fact",
          supportStrength: "strong",
          timeScopeKind: "event",
          confidence: "confident",
          objectValue: "July 2023",
          eventKey: "career_high_points",
          eventType: "achievement",
          timeGranularity: "month",
          answerYear: 2023,
          answerMonth: 7,
          answerDay: null,
          sourceTable: "canonical_temporal_facts"
        },
        fallbackClaimText: null,
        results: [
          recallResult(
            "John: So much has happened in the last month - on and off the court. Last week I scored 40 points, my highest ever.",
            {
              source_uri: sourcePath,
              metadata: {
                source_turn_text: "John: So much has happened in the last month - on and off the court. Last week I scored 40 points, my highest ever."
              }
            },
            "2023-07-16T16:21:00.000Z"
          )
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      1
    );

    assert.equal(rendered.claimText, "June 2023");
    assert.equal(rendered.renderContractSelected, "temporal_month");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pet-care report support synthesizes joined classes and groups deterministically", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "pet_care_report",
    queryText: "What kind of classes or groups has Audrey joined to take better care of her dogs?",
    fallbackSummary: null,
    results: [
      recallResult("Audrey joined local dog-owner workshops and agility groups to take better care of her dogs.", {
        subject_name: "Audrey",
        speaker_name: "Audrey"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What kind of classes or groups has Audrey joined to take better care of her dogs?",
    support
  );

  assert.equal(rendered.renderContractSelected, "pet_care_classes_render");
  assert.match(rendered.claimText ?? "", /dog-owner workshops/i);
  assert.match(rendered.claimText ?? "", /agility groups/i);
});

test("temporal support keeps fact-backed month-year over neighborhood-only day derivations for resumed-drums queries", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-resume-drums-fact-priority-"));
  const sourcePath = join(tempDir, "conv-43-session_drums.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2022-04-27T20:56:00.000Z",
      "",
      "John: I play drums too, and I've been back at it for a month now."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When did John resume playing drums in his adulthood?",
      buildTemporalEventSupport({
        queryText: "When did John resume playing drums in his adulthood?",
        storedCanonical: {
          kind: "temporal_fact",
          subjectEntityId: "person:john",
          canonicalSubjectName: "John",
          subjectBindingStatus: "resolved",
          predicateFamily: "temporal_event_fact",
          supportStrength: "strong",
          timeScopeKind: "event",
          confidence: "confident",
          objectValue: "February 2022",
          eventKey: "resume_playing_drums",
          eventType: "habit",
          timeGranularity: "month",
          answerYear: 2022,
          answerMonth: 2,
          answerDay: null,
          sourceTable: "canonical_temporal_facts",
          supportKind: "explicit_event_fact",
          temporalSourceQuality: "canonical_event"
        },
        fallbackClaimText: null,
        results: [
          recallResult(
            "John: I play drums too, and I've been back at it for a month now.",
            {
              source_uri: sourcePath,
              metadata: {
                source_turn_text: "John: I play drums too, and I've been back at it for a month now."
              }
            },
            "2022-04-27T20:56:00.000Z"
          )
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      1
    );

    assert.equal(rendered.claimText, "February 2022");
    assert.equal(rendered.renderContractSelected, "temporal_month_year");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("direct detail support keeps canonical exact values when no span extraction survives", () => {
  const support = buildDirectDetailSupport({
    finalClaimText: null,
    exactDetailCandidate: {
      text: "Under Armour",
      source: "stored_canonical_fact",
      strongSupport: false
    }
  });
  const rendered = renderDirectDetailSupport(support, 1);

  assert.equal(rendered.claimText, "Under Armour");
  assert.equal(rendered.renderContractSelected, "exact_canonical_value");
});

test("pet-care report support keeps richer workshop and course phrases when multiple class cues exist", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "pet_care_report",
    queryText: "What kind of classes or groups has Audrey joined to take better care of her dogs?",
    fallbackSummary: null,
    results: [
      recallResult(
        "Audrey signed up for a positive reinforcement training workshop to bond with pets, a dog training course, an agility training course, a grooming course, and a dog-owners group.",
        {
          subject_name: "Audrey",
          speaker_name: "Audrey"
        }
      )
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What kind of classes or groups has Audrey joined to take better care of her dogs?",
    support
  );

  assert.equal(rendered.renderContractSelected, "pet_care_classes_render");
  assert.match(rendered.claimText ?? "", /positive reinforcement training workshop/i);
  assert.match(rendered.claimText ?? "", /dog training course/i);
  assert.match(rendered.claimText ?? "", /agility training course/i);
  assert.match(rendered.claimText ?? "", /grooming course/i);
  assert.match(rendered.claimText ?? "", /dog-owners group/i);
});

test("pet-care report support derives indoor activities from dog-treat evidence", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "pet_care_report",
    queryText: "What is an indoor activity that Andrew would enjoy doing while make his dog happy?",
    fallbackSummary: null,
    results: [
      recallResult("Andrew likes cooking homemade dog treats when he needs an indoor activity with his dog.", {
        subject_name: "Andrew",
        speaker_name: "Andrew"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What is an indoor activity that Andrew would enjoy doing while make his dog happy?",
    support
  );

  assert.equal(rendered.renderContractSelected, "pet_care_activity_render");
  assert.equal(rendered.claimText, "cook dog treats");
});

test("pet-care report support derives living-situation advice from remote-job and suburbs evidence", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "pet_care_report",
    queryText: "What can Andrew potentially do to improve his stress and accomodate his living situation with his dogs?",
    fallbackSummary: null,
    results: [
      recallResult("Andrew wants a hybrid or remote job so he can move to the suburbs, have a larger living space, and be closer to nature with his dogs.", {
        subject_name: "Andrew",
        speaker_name: "Andrew"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What can Andrew potentially do to improve his stress and accomodate his living situation with his dogs?",
    support
  );

  assert.equal(rendered.renderContractSelected, "pet_care_advice_render");
  assert.match(rendered.claimText ?? "", /hybrid or remote job/i);
  assert.match(rendered.claimText ?? "", /suburbs/i);
});

test("aspiration report support extracts unique app feature plans deterministically", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "aspiration_report",
    queryText: "How does James plan to make his dog-sitting app unique?",
    fallbackSummary: null,
    results: [
      recallResult("James plans to make his dog-sitting app unique by allowing users to customize their pup's preferences and needs.", {
        subject_name: "James",
        speaker_name: "James"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "How does James plan to make his dog-sitting app unique?",
    support
  );

  assert.equal(rendered.renderContractSelected, "aspiration_unique_feature_render");
  assert.match(rendered.claimText ?? "", /customize/i);
  assert.match(rendered.claimText ?? "", /preferences and needs/i);
});

test("aspiration report support ignores noisy payloads when aligned source evidence provides the unique feature", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "aspiration_report",
    queryText: "How does James plan to make his dog-sitting app unique?",
    fallbackSummary: null,
    answerPayload: {
      answer_value: "witcher inspired virtual world canonical_rebuild. media_mentions. unknown"
    },
    results: [
      recallResult("James plans to make his dog-sitting app unique by allowing users to customize their pup's preferences and needs.", {
        subject_name: "James",
        speaker_name: "James"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "How does James plan to make his dog-sitting app unique?",
    support
  );

  assert.equal(rendered.renderContractSelected, "aspiration_unique_feature_render");
  assert.doesNotMatch(rendered.claimText ?? "", /canonical_rebuild|unknown/i);
  assert.match(rendered.claimText ?? "", /customiz/i);
  assert.match(rendered.claimText ?? "", /preferences and needs/i);
});

test("travel report support extracts roadtrip location sets deterministically", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "travel_report",
    queryText: "Where has Evan been on roadtrips with his family?",
    fallbackSummary: null,
    results: [
      recallResult("Evan has been on family roadtrips through the Rockies and Jasper.", {
        subject_name: "Evan",
        speaker_name: "Evan"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "Where has Evan been on roadtrips with his family?",
    support
  );

  assert.equal(rendered.renderContractSelected, "travel_location_set_render");
  assert.match(rendered.claimText ?? "", /Rockies/i);
  assert.match(rendered.claimText ?? "", /Jasper/i);
});

test("travel report support suppresses noisy aggregate nouns when typed place names are available", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "travel_report",
    queryText: "Where has Evan been on roadtrips with his family?",
    fallbackSummary: null,
    results: [
      recallResult("Evan has been on family roadtrips through the Rockies and Jasper.", {
        subject_name: "Evan",
        speaker_name: "Evan"
      }),
      recallResult("A noisy aggregate mentioned beach, store again, unsurprisingly, had issues, drink, and park.", {
        subject_name: "Evan",
        speaker_name: "Evan"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "Where has Evan been on roadtrips with his family?",
    support
  );

  assert.equal(rendered.renderContractSelected, "travel_location_set_render");
  assert.match(rendered.claimText ?? "", /Rockies/i);
  assert.match(rendered.claimText ?? "", /Jasper/i);
  assert.doesNotMatch(rendered.claimText ?? "", /store|drink|unsurprisingly|issues/i);
});

test("travel report support keeps typed payload places when source-grounded evidence only has generic venues", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "travel_report",
    queryText: "Where has Evan been on roadtrips with his family?",
    fallbackSummary: "Rockies, Jasper",
    answerPayload: {
      answer_value: "Rockies, Jasper"
    },
    results: [
      recallResult("They went to the beach and the park on another trip.", {
        subject_name: "Evan",
        speaker_name: "Evan"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "Where has Evan been on roadtrips with his family?",
    support
  );

  assert.equal(rendered.renderContractSelected, "travel_location_set_render");
  assert.match(rendered.claimText ?? "", /Rockies/i);
  assert.match(rendered.claimText ?? "", /Jasper/i);
  assert.doesNotMatch(rendered.claimText ?? "", /\bbeach\b|\bpark\b/i);
});

test("travel report support filters vehicle nouns out of roadtrip place sets", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "travel_report",
    queryText: "Where has Evan been on roadtrips with his family?",
    fallbackSummary: null,
    results: [
      recallResult("Evan just got back from a trip with his family in his new Prius.", {
        subject_name: "Evan",
        speaker_name: "Evan"
      }),
      recallResult("My old prius broke down, decided to get it repaired and sell it. Glad you asked, we went to Rockies, check it out.", {
        subject_name: "Evan",
        speaker_name: "Evan",
        query: "canadian rockies sunset scenery",
        blip_caption: "a photo of a lake with rocks and mountains in the background",
        metadata: {
          source_turn_text:
            "Evan: My old prius broke down, decided to get it repaired and sell it. Glad you asked, we went to Rockies, check it out.",
          query: "canadian rockies sunset scenery",
          blip_caption: "a photo of a lake with rocks and mountains in the background"
        }
      }),
      recallResult("Last weekend, Evan took his family on a road trip to Jasper.", {
        subject_name: "Evan",
        speaker_name: "Evan"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "Where has Evan been on roadtrips with his family?",
    support
  );

  assert.equal(rendered.renderContractSelected, "travel_location_set_render");
  assert.match(rendered.claimText ?? "", /Rockies/i);
  assert.match(rendered.claimText ?? "", /Jasper/i);
  assert.doesNotMatch(rendered.claimText ?? "", /Prius/i);
});

test("travel report support prefers clause-bound roadtrip places over ambient caption geotags", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "travel_report",
    queryText: "Where has Evan been on roadtrips with his family?",
    fallbackSummary: null,
    results: [
      recallResult("Evan: Hey Sam! Good to see you! Yeah, I just got back from a trip with my family in my new Prius.", {
        subject_name: "Evan",
        speaker_name: "Evan",
        query: "Lake Tahoe mountain lake scenic drive",
        blip_caption: "a photo of Banff, Canada in the Rocky Mountains",
        metadata: {
          query: "Lake Tahoe mountain lake scenic drive",
          blip_caption: "a photo of Banff, Canada in the Rocky Mountains"
        }
      }),
      recallResult("Glad you asked, we went to Rockies, check it out.", {
        subject_name: "Evan",
        speaker_name: "Evan"
      }),
      recallResult("Last weekend, I took my family on a road trip to Jasper.", {
        subject_name: "Evan",
        speaker_name: "Evan"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "Where has Evan been on roadtrips with his family?",
    support
  );

  assert.equal(rendered.renderContractSelected, "travel_location_set_render");
  assert.match(rendered.claimText ?? "", /Rockies/i);
  assert.match(rendered.claimText ?? "", /Jasper/i);
  assert.doesNotMatch(rendered.claimText ?? "", /Lake Tahoe|Banff|Canada|Rocky Mountains/i);
});

test("travel report support suppresses romance-trip noise when grounded family roadtrip evidence is present", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "travel_report",
    queryText: "Where has Evan been on roadtrips with his family?",
    fallbackSummary: null,
    results: [
      recallResult("Last weekend, I took my family on a road trip to Jasper. It was amazing!", {
        subject_name: "Evan",
        speaker_name: "Evan"
      }),
      recallResult("Glad you asked, we went to Rockies, check it out.", {
        subject_name: "Evan",
        speaker_name: "Evan",
        query: "canadian rockies sunset scenery",
        metadata: {
          source_turn_text: "Evan: Glad you asked, we went to Rockies, check it out.",
          query: "canadian rockies sunset scenery"
        }
      }),
      recallResult("Last week I went on a trip to Canada and met someone special there.", {
        subject_name: "Evan",
        speaker_name: "Evan"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "Where has Evan been on roadtrips with his family?",
    support
  );

  assert.equal(rendered.renderContractSelected, "travel_location_set_render");
  assert.match(rendered.claimText ?? "", /Rockies/i);
  assert.match(rendered.claimText ?? "", /Jasper/i);
  assert.doesNotMatch(rendered.claimText ?? "", /Canada/i);
});

test("travel report support recovers named roadtrip places from expanded source neighborhoods and drops generic venues", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-travel-expanded-"));
  const sourcePath = join(tempDir, "conv-49-session_4.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-06-20T09:00:00.000Z",
      "",
      "Evan: My old prius broke down, decided to get it repaired and sell it. Glad you asked, we went to Rockies, check it out."
    ].join("\n"),
    "utf8"
  );

  try {
    const support = buildProfileInferenceSupport({
      reportKind: "travel_report",
      queryText: "Where has Evan been on roadtrips with his family?",
      fallbackSummary: null,
      results: [
        recallResult("No authoritative travel summary was persisted.", {
          subject_name: "Evan",
          source_uri: sourcePath
        }),
        recallResult("Last weekend, Evan took his family on a road trip to Jasper.", {
          subject_name: "Evan",
          speaker_name: "Evan"
        }),
        recallResult("They later relaxed at the beach and the park on another outing.", {
          subject_name: "Evan",
          speaker_name: "Evan"
        })
      ]
    });
    const rendered = renderProfileInferenceSupport(
      "Where has Evan been on roadtrips with his family?",
      support
    );

    assert.equal(rendered.renderContractSelected, "travel_location_set_render");
    assert.match(rendered.claimText ?? "", /Rockies/i);
    assert.match(rendered.claimText ?? "", /Jasper/i);
    assert.doesNotMatch(rendered.claimText ?? "", /\bbeach\b|\bpark\b/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("travel report support uses typed artifact payloads when source-grounded snippets are absent", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "travel_report",
    queryText: "Where has Evan been on roadtrips with his family?",
    fallbackSummary: null,
    results: [
      recallResult(
        JSON.stringify({
          answer_payload: {
            answer_value: "Rockies, Jasper"
          }
        }),
        {
          subject_name: "Evan",
          speaker_name: "Evan",
          source_table: "canonical_reports",
          metadata: {
            source_table: "canonical_reports"
          }
        },
        "2023-05-24T19:11:00.000Z",
        "artifact_derivation"
      )
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "Where has Evan been on roadtrips with his family?",
    support
  );

  assert.equal(rendered.renderContractSelected, "travel_location_set_render");
  assert.match(rendered.claimText ?? "", /Rockies/i);
  assert.match(rendered.claimText ?? "", /Jasper/i);
});

test("profile inference support synthesizes pair advice from aligned support text", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "profile_report",
    queryText: "Considering their conversations and personal growth, what advice might Evan and Sam give to someone facing a major life transition or challenge?",
    fallbackSummary: null,
    results: [
      recallResult("Evan: Big changes get easier when you take them one step at a time and lean on the people who support you.", {
        subject_name: "Evan",
        speaker_name: "Evan"
      }),
      recallResult("Sam: Hiking and road trips help me reset, and good friends make hard transitions feel manageable.", {
        subject_name: "Sam",
        speaker_name: "Sam"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "Considering their conversations and personal growth, what advice might Evan and Sam give to someone facing a major life transition or challenge?",
    support
  );

  assert.equal(rendered.renderContractSelected, "pair_advice_render");
  assert.match(rendered.claimText ?? "", /small, consistent changes|one step at a time|consistent changes/i);
  assert.match(rendered.claimText ?? "", /hiking|road trips/i);
  assert.match(rendered.claimText ?? "", /friendship|support/i);
});

test("profile inference support renders realization queries through a typed realization contract", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "profile_report",
    queryText: "What did Melanie realize after the charity race?",
    fallbackSummary: null,
    results: [
      recallResult("Melanie: After the charity race, I realized self-care is important.", {
        subject_name: "Melanie",
        speaker_name: "Melanie"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport("What did Melanie realize after the charity race?", support);

  assert.equal(rendered.renderContractSelected, "realization_render");
  assert.equal(rendered.claimText, "self-care is important");
});

test("aspiration report support returns none for time-bounded venture queries without an explicit venture cue", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "aspiration_report",
    queryText: "What is Calvin's new business venture as of 1 May, 2023?",
    fallbackSummary: null,
    answerPayload: {
      answer_value: "maintenance shop"
    },
    results: [
      recallResult("Calvin talks about performing and the rush of being onstage in front of large crowds.", {
        subject_name: "Calvin",
        speaker_name: "Calvin"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What is Calvin's new business venture as of 1 May, 2023?",
    support
  );

  assert.equal(rendered.renderContractSelected, "aspiration_venture_render");
  assert.equal(rendered.claimText, "None");
});

test("aspiration report support ignores artifact-derivation venture labels when source-grounded evidence lacks a venture cue", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "aspiration_report",
    queryText: "What is Calvin's new business venture as of 1 May, 2023?",
    fallbackSummary: null,
    answerPayload: {
      answer_value: "maintenance shop"
    },
    results: [
      recallResult(
        "{\"text\":\"maintenance shop\"}",
        {
          subject_name: "Calvin",
          source_sentence_text: ""
        },
        "2023-10-19T10:11:00.000Z",
        "artifact_derivation"
      ),
      recallResult("Calvin talks about performing and the rush of being onstage in front of large crowds.", {
        subject_name: "Calvin",
        speaker_name: "Calvin"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What is Calvin's new business venture as of 1 May, 2023?",
    support
  );

  assert.equal(rendered.renderContractSelected, "aspiration_venture_render");
  assert.equal(rendered.claimText, "None");
});

test("collection support objects consume canonical-set collection support payloads directly", () => {
  const support = buildCollectionInferenceSupport({
    queryText: "What items does John collect?",
    fallbackSummary: null,
    answerPayload: null,
    results: [
      recallResult("fantasy movie DVDs", {
        subject_name: "John",
        metadata: {
          subject_name: "John",
          source_table: "canonical_set_collection_support",
          collection_item_value: "fantasy movie DVDs",
          source_sentence_text: "fantasy movie DVDs",
          answer_payload: {
            answer_type: "collection_items",
            item_values: ["fantasy movie DVDs", "jerseys"],
            answer_value: "fantasy movie DVDs and jerseys"
          }
        }
      }),
      recallResult("jerseys", {
        subject_name: "John",
        metadata: {
          subject_name: "John",
          source_table: "canonical_set_collection_support",
          collection_item_value: "jerseys",
          source_sentence_text: "jerseys",
          answer_payload: {
            answer_type: "collection_items",
            item_values: ["jerseys"],
            answer_value: "jerseys"
          }
        }
      })
    ]
  });
  const rendered = renderCollectionInferenceSupport("What items does John collect?", support);

  assert.equal(support.supportObjectType, "CollectionSetSupport");
  assert.deepEqual(support.collectionEntries, ["fantasy movie DVDs", "jerseys"]);
  assert.equal(rendered.renderContractSelected, "collection_set_render");
  assert.equal(rendered.claimText, "fantasy movie DVDs and jerseys");
});

test("atomic memory units expand normalized collection facts into first-class units", () => {
  const queryText = "What items does John collect?";
  const predicateFamily = inferAnswerRetrievalPredicateFamily(queryText);
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily,
    supportObjectType: null,
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });
  const units = extractAtomicMemoryUnits({
    results: [
      recallResult("sneakers", {
        subject_entity_id: "person:john",
        metadata: {
          source_table: "canonical_collection_facts",
          collection_item_value: "sneakers",
          source_sentence_text: "John collects sneakers."
        }
      }),
      recallResult("fantasy movie DVDs", {
        subject_entity_id: "person:john",
        metadata: {
          source_table: "canonical_collection_facts",
          answer_payload: {
            answer_type: "collection_items",
            item_values: ["fantasy movie DVDs", "jerseys"]
          },
          source_sentence_text: "John collects fantasy movie DVDs and jerseys."
        }
      })
    ],
    retrievalPlan
  });

  const collectionUnits = units.filter((unit) => unit.unitType === "NormalizedCollectionFactSupportUnit");
  assert.deepEqual(
    collectionUnits.map((unit) => unit.canonicalText),
    ["sneakers", "fantasy movie DVDs", "jerseys"]
  );
  assert.ok(collectionUnits.every((unit) => unit.cueTypes?.includes("normalized_collection_fact")));
});

test("collection support can consume atomic normalized collection units directly", () => {
  const support = buildCollectionInferenceSupport({
    queryText: "What items does John collect?",
    fallbackSummary: null,
    answerPayload: null,
    results: [recallResult("Noisy raw text without useful collection parsing.", {})],
    atomicUnits: [
      {
        id: "unit:sneakers",
        namespace: "test",
        unitType: "NormalizedCollectionFactSupportUnit",
        sourceText: "John collects sneakers.",
        canonicalText: "sneakers",
        subjectEntityId: "person:john",
        cueTypes: ["normalized_collection_fact", "collection_cue", "subject_bound"],
        confidence: 1,
        plannerFamily: "collection_inference"
      },
      {
        id: "unit:dvds",
        namespace: "test",
        unitType: "NormalizedCollectionFactSupportUnit",
        sourceText: "John collects fantasy movie DVDs.",
        canonicalText: "fantasy movie DVDs",
        subjectEntityId: "person:john",
        cueTypes: ["normalized_collection_fact", "collection_cue", "subject_bound"],
        confidence: 1,
        plannerFamily: "collection_inference"
      },
      {
        id: "unit:jerseys",
        namespace: "test",
        unitType: "NormalizedCollectionFactSupportUnit",
        sourceText: "John collects jerseys.",
        canonicalText: "jerseys",
        subjectEntityId: "person:john",
        cueTypes: ["normalized_collection_fact", "collection_cue", "subject_bound"],
        confidence: 1,
        plannerFamily: "collection_inference"
      }
    ]
  });
  const rendered = renderCollectionInferenceSupport("What items does John collect?", support);

  assert.equal(support.supportObjectType, "CollectionSetSupport");
  assert.deepEqual(support.collectionEntries, ["sneakers", "fantasy movie DVDs", "jerseys"]);
  assert.equal(rendered.renderContractSelected, "collection_set_render");
  assert.equal(rendered.claimText, "sneakers, fantasy movie DVDs, and jerseys");
});

test("collection support objects merge subject-bound collection entries across multiple compatible cues", () => {
  const support = buildCollectionInferenceSupport({
    queryText: "What items does John collect?",
    fallbackSummary: null,
    answerPayload: null,
    results: [
      recallResult("John has a collection of sneakers and jerseys.", {
        subject_name: "John",
        speaker_name: "John"
      }),
      recallResult("John's collection includes fantasy movie DVDs.", {
        subject_name: "John",
        speaker_name: "John"
      })
    ]
  });
  const rendered = renderCollectionInferenceSupport("What items does John collect?", support);

  assert.equal(support.supportObjectType, "CollectionSetSupport");
  assert.deepEqual(support.collectionEntries, ["sneakers", "jerseys", "fantasy movie DVDs"]);
  assert.equal(rendered.renderContractSelected, "collection_set_render");
  assert.equal(rendered.claimText, "sneakers, jerseys, and fantasy movie DVDs");
});

test("generic collection reports do not normalize incidental Harry Potter mentions without collection cues", () => {
  const result = deriveRuntimeReportClaim(
    "collection_report",
    "What items does John collect?",
    [
      recallResult("John said he loves Harry Potter and wants to visit the studio tour someday.", {
        subject_name: "John",
        speaker_name: "John"
      })
    ]
  );

  assert.equal(result.claimText, null);
});

test("generic collection reports reject vague clause-based values for item queries", () => {
  const support = buildCollectionInferenceSupport({
    queryText: "What items does John collect?",
    fallbackSummary: "books that take me there",
    answerPayload: {
      answer_type: "collection_items",
      answer_value: "books that take me there",
      reason_value: "collects books that take me there"
    },
    results: [
      recallResult("John said he likes books that take me there.", {
        subject_name: "John",
        speaker_name: "John"
      })
    ]
  });
  const rendered = renderCollectionInferenceSupport("What items does John collect?", support);

  assert.equal(support.supportObjectType, "CollectionSetSupport");
  assert.deepEqual(support.collectionEntries, []);
  assert.deepEqual(support.supportNormalizationFailures, ["no_collection_entries_normalized"]);
  assert.equal(rendered.claimText, null);
  assert.equal(rendered.renderContractSelected, "collection_summary_fallback");
});

test("generic collection renders stay incomplete for plural item queries with only one strong entry", () => {
  const support = buildCollectionInferenceSupport({
    queryText: "What items does John collect?",
    fallbackSummary: null,
    answerPayload: null,
    results: [
      recallResult("John collects jerseys.", {
        subject_name: "John",
        speaker_name: "John"
      })
    ]
  });
  const rendered = renderCollectionInferenceSupport("What items does John collect?", support);

  assert.equal(support.supportObjectType, "CollectionSetSupport");
  assert.deepEqual(support.collectionEntries, ["jerseys"]);
  assert.equal(rendered.claimText, null);
  assert.equal(rendered.renderContractSelected, "collection_summary_fallback");
  assert.equal(rendered.renderContractFallbackReason, "collection_entries_incomplete");
});

test("profile inference support splits community-membership judgments from generic scalar rendering", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "profile_report",
    queryText: "Would Melanie be considered a member of the LGBTQ community?",
    fallbackSummary: "Unknown.",
    answerPayload: null,
    results: [
      recallResult("Melanie attended pride events and support groups, but she never described herself as LGBTQ.", {
        subject_name: "Melanie",
        speaker_name: "Melanie"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "Would Melanie be considered a member of the LGBTQ community?",
    support
  );

  assert.equal(support.answerValue, "Likely no");
  assert.equal(rendered.renderContractSelected, "community_membership_inference");
  assert.match(rendered.claimText ?? "", /Likely no/i);
  assert.match(rendered.claimText ?? "", /Melanie does not describe being part of the LGBTQ community/i);
});

test("profile inference support splits ally judgments from generic scalar rendering", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "profile_report",
    queryText: "Would Melanie be considered an ally to the transgender community?",
    fallbackSummary: "Unknown.",
    answerPayload: null,
    results: [
      recallResult("Melanie said she is supportive of the transgender community and attends pride events.", {
        subject_name: "Melanie",
        speaker_name: "Melanie"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "Would Melanie be considered an ally to the transgender community?",
    support
  );

  assert.equal(support.answerValue, "Yes");
  assert.equal(rendered.renderContractSelected, "ally_likelihood_judgment");
  assert.match(rendered.claimText ?? "", /^Yes/i);
  assert.match(rendered.claimText ?? "", /Melanie is supportive/i);
});

test("profile inference support promotes why-queries into a causal reason render", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "profile_report",
    queryText: "Why did Gina decide to start her own clothing store?",
    fallbackSummary: null,
    answerPayload: null,
    results: [
      recallResult("After losing her job, Gina decided to turn her passion for fashion into an online clothing store.", {
        subject_name: "Gina",
        speaker_name: "Gina"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "Why did Gina decide to start her own clothing store?",
    support
  );

  assert.equal(support.supportObjectType, "ProfileInferenceSupport");
  assert.equal(support.supportCompletenessScore, 1);
  assert.ok(support.reasonCueTypes.includes("transition_clause"));
  assert.equal(rendered.renderContractSelected, "causal_reason_render");
  assert.match(rendered.claimText ?? "", /losing her job/i);
});

test("profile inference support synthesizes startup motive reasons from trigger and fashion cues", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "profile_report",
    queryText: "Why did Gina decide to start her own clothing store?",
    fallbackSummary: null,
    answerPayload: null,
    results: [
      recallResult("Gina lost her job at Door Dash and opened an online clothing store.", {
        subject_name: "Gina",
        speaker_name: "Gina",
        metadata: {
          source_sentence_text: "Gina lost her job at Door Dash and opened an online clothing store."
        }
      }),
      recallResult("Gina always loved fashion trends and finding unique pieces.", {
        subject_name: "Gina",
        speaker_name: "Gina",
        metadata: {
          source_sentence_text: "Gina always loved fashion trends and finding unique pieces."
        }
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "Why did Gina decide to start her own clothing store?",
    support
  );

  assert.equal(rendered.renderContractSelected, "causal_reason_render");
  assert.ok(
    support.reasonCueTypes.includes("startup_fashion_motive_synthesis") ||
      support.reasonCueTypes.includes("startup_fashion_interest_synthesis")
  );
  assert.match(rendered.claimText ?? "", /fashion|unique pieces/i);
  assert.match(rendered.claimText ?? "", /job|business|store/i);
});

test("support-report inference aggregates grief-peace supports into a typed causal list", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "support_report",
    queryText: "What helped Deborah find peace when grieving deaths of her loved ones?",
    fallbackSummary: null,
    answerPayload: null,
    results: [
      recallResult("Deborah: Yoga helped me find peace during a rough time, and now I'm passionate about sharing that with others.", {
        subject_name: "Deborah",
        speaker_name: "Deborah"
      }),
      recallResult("Deborah: We looked at the family album. Photos give me peace during difficult times.", {
        subject_name: "Deborah",
        speaker_name: "Deborah"
      }),
      recallResult("Deborah: The roses and dahlias bring me peace. I lost a friend last week, so I've been spending time in the garden to find some comfort.", {
        subject_name: "Deborah",
        speaker_name: "Deborah"
      }),
      recallResult("Deborah: Nature helps me find peace every day - it's so refreshing!", {
        subject_name: "Deborah",
        speaker_name: "Deborah"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What helped Deborah find peace when grieving deaths of her loved ones?",
    support
  );

  assert.equal(support.answerValue, "yoga, old photos, the roses and dahlias in a flower garden, nature");
  assert.equal(rendered.renderContractSelected, "causal_reason_render");
  assert.match(rendered.claimText ?? "", /yoga/i);
  assert.match(rendered.claimText ?? "", /old photos/i);
  assert.match(rendered.claimText ?? "", /roses and dahlias/i);
  assert.match(rendered.claimText ?? "", /nature/i);
});

test("list-set support promotes fallback book entries into a typed book-list render", () => {
  const support = buildListSetSupport({
    queryText: "What books has Melanie read?",
    predicateFamily: "list_set",
    results: [],
    storedCanonical: {
      kind: "set",
      subjectEntityId: null,
      canonicalSubjectName: "Melanie",
      subjectBindingStatus: "resolved",
      predicateFamily: "list_set",
      supportStrength: "moderate",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValues: ["Nothing is Impossible", "Charlotte's Web"],
      sourceTable: "canonical_sets"
    },
    finalClaimText: "\"Nothing is Impossible\", \"Charlotte's Web\"",
    subjectPlan: {
      kind: "single_subject",
      canonicalSubjectName: "Melanie",
      subjectEntityId: null
    }
  });
  const rendered = renderListSetSupport(support, 2);

  assert.equal(rendered.renderContractSelected, "book_list_render");
  assert.equal(rendered.typedSetEntryType, "book_title");
  assert.equal(rendered.typedSetEntryCount, 2);
  assert.equal(rendered.targetedRetrievalAttempted, false);
  assert.equal(rendered.targetedRetrievalReason, null);
  assert.equal(rendered.claimText, "\"Nothing is Impossible\", \"Charlotte's Web\"");
});

test("profile inference evidence expansion keeps bookshelf queries out of counseling lanes", () => {
  const queryText = "Would Caroline likely have Dr. Seuss books on her bookshelf?";
  const expanded = buildProfileInferenceEvidenceQueryText(queryText, ["caroline", "bookshelf", "dr", "seuss"]);

  assert.match(expanded, /\bbookshelf\b/i);
  assert.match(expanded, /\bdr seuss\b/i);
  assert.doesNotMatch(expanded, /\bcounseling\b/i);
  assert.doesNotMatch(expanded, /\bmental\b/i);
  assert.doesNotMatch(expanded, /\bhealth\b/i);
});

test("atomic memory units expose cue types and nested temporal fields for planner lanes", () => {
  const queryText = "When did Caroline attend the art fair?";
  const predicateFamily = inferAnswerRetrievalPredicateFamily(queryText);
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily,
    supportObjectType: "TemporalEventSupport",
    subjectBindingStatus: "resolved",
    temporalEventIdentityStatus: "resolved",
    temporalGranularityStatus: "resolved",
    subjectEntityHints: ["person:caroline"]
  });
  const units = extractAtomicMemoryUnits({
    results: [
      recallResult("Caroline attended the art fair after the parade.", {
        subject_entity_id: "person:caroline",
        source_chunk_id: "chunk:art-fair"
      })
    ],
    storedCanonical: {
      kind: "temporal_fact",
      eventKey: "event:art_fair",
      eventType: "attendance",
      answerYear: 2025,
      answerMonth: 10,
      answerDay: 18,
      anchorEventKey: "event:parade",
      anchorRelation: "after",
      anchorOffsetValue: 0,
      anchorOffsetUnit: "day"
    },
    supportObjectType: "TemporalEventSupport",
    selectedEventKey: "event:art_fair",
    selectedEventType: "attendance",
    selectedTimeGranularity: "day",
    exactDetailSource: null,
    retrievalPlan
  });

  assert.equal(units.length, 1);
  assert.ok(units[0].cueTypes?.includes("planner_lane:temporal_event"));
  assert.ok(units[0].cueTypes?.includes("causal_clause"));
  assert.deepEqual(units[0].absoluteDate, { year: 2025, month: 10, day: 18 });
  assert.deepEqual(units[0].relativeAnchor, {
    anchorEventKey: "event:parade",
    relation: "after",
    offsetValue: 0,
    offsetUnit: "day"
  });
});

test("profile inference evidence expansion keeps community-membership queries out of counseling lanes", () => {
  const queryText = "Would Melanie be considered a member of the LGBTQ community?";
  const expanded = buildProfileInferenceEvidenceQueryText(queryText, ["melanie", "lgbtq", "community"]);

  assert.match(expanded, /\blgbtq\b/i);
  assert.match(expanded, /\bpride\b/i);
  assert.doesNotMatch(expanded, /\bcounseling\b/i);
  assert.doesNotMatch(expanded, /\bmental\b/i);
});

test("profile inference evidence expansion keeps counseling terms for career-option queries", () => {
  const queryText = "Would Caroline pursue writing as a career option?";
  const expanded = buildProfileInferenceEvidenceQueryText(queryText, ["caroline", "writing", "career", "option"]);

  assert.match(expanded, /\bwriting\b/i);
  assert.match(expanded, /\bcounseling\b/i);
  assert.match(expanded, /\bmental\b/i);
});

test("answer retrieval planner routes bookshelf inference into collection pools and career suppression", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    predicateFamily: "profile_state"
  });

  assert.equal(plan.family, "report");
  assert.ok(plan.candidatePools.includes("collection_support"));
  assert.ok(plan.candidatePools.includes("report_support"));
  assert.ok(plan.suppressionPools.includes("career_support"));
  assert.ok(plan.suppressionPools.includes("health_support"));
  assert.ok(plan.queryExpansionTerms.includes("bookshelf"));
  assert.ok(plan.queryExpansionTerms.includes("dr seuss"));
  assert.ok(plan.bannedExpansionTerms.includes("counseling"));
  assert.ok(plan.bannedExpansionTerms.includes("mental"));
});

test("answer retrieval planner keeps generic collection queries in collection inference without bookshelf pollution", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "What items does John collect?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("What items does John collect?", "generic_fact")
  });

  assert.equal(plan.family, "report");
  assert.equal(plan.lane, "collection_inference");
  assert.ok(plan.candidatePools.includes("normalized_collection_facts"));
  assert.ok(plan.candidatePools.includes("collection_support"));
  assert.ok(plan.requiredFields.includes("collection_entries"));
  assert.ok(plan.targetedBackfill.includes("collection_entries"));
  assert.ok(plan.targetedBackfillRequests.some((request) => request.reason === "collection_entries_missing"));
  assert.ok(plan.queryExpansionTerms.includes("collect"));
  assert.ok(plan.queryExpansionTerms.includes("items"));
  assert.ok(!plan.queryExpansionTerms.includes("bookshelf"));
  assert.ok(!plan.queryExpansionTerms.includes("dr seuss"));
  assert.ok(plan.suppressionPools.includes("exact_detail_support"));
});

test("answer retrieval planner routes book-list queries into list-set pools", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "What books has Melanie read?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("What books has Melanie read?")
  });

  assert.equal(plan.family, "list_set");
  assert.ok(plan.candidatePools.includes("book_list_support"));
  assert.ok(plan.requiredFields.includes("book_list_entries"));
  assert.ok(plan.targetedBackfill.includes("book_list_entries"));
  assert.ok(plan.queryExpansionTerms.includes("books"));
  assert.ok(plan.queryExpansionTerms.includes("read"));
});

test("answer retrieval planner routes career-option queries into report career pools", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "Would Caroline pursue writing as a career option?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("Would Caroline pursue writing as a career option?")
  });

  assert.equal(plan.family, "report");
  assert.ok(plan.candidatePools.includes("career_support"));
  assert.ok(plan.suppressionPools.includes("exact_detail_support"));
  assert.ok(plan.queryExpansionTerms.includes("counseling"));
  assert.ok(plan.queryExpansionTerms.includes("writing"));
});

test("answer retrieval planner routes motive, realization, and inferred-goal questions into report pools", () => {
  const motivePlan = buildAnswerRetrievalPlan({
    queryText: "Why did Gina decide to start her own clothing store?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("Why did Gina decide to start her own clothing store?", "generic_fact")
  });
  const realizationPlan = buildAnswerRetrievalPlan({
    queryText: "What did Melanie realize after the charity race?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("What did Melanie realize after the charity race?", "generic_fact")
  });
  const goalPlan = buildAnswerRetrievalPlan({
    queryText: "What might John's degree be in?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("What might John's degree be in?", "generic_fact")
  });
  const strategyPlan = buildAnswerRetrievalPlan({
    queryText: "How does James plan to make his dog-sitting app unique?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("How does James plan to make his dog-sitting app unique?", "generic_fact")
  });
  const advicePlan = buildAnswerRetrievalPlan({
    queryText: "What can Andrew potentially do to improve his stress and accomodate his living situation with his dogs?",
    predicateFamily: inferAnswerRetrievalPredicateFamily(
      "What can Andrew potentially do to improve his stress and accomodate his living situation with his dogs?",
      "generic_fact"
    )
  });

  assert.equal(motivePlan.family, "report");
  assert.equal(motivePlan.lane, "report");
  assert.ok(motivePlan.candidatePools.includes("report_support"));
  assert.equal(realizationPlan.family, "report");
  assert.equal(realizationPlan.lane, "report");
  assert.equal(goalPlan.family, "report");
  assert.equal(goalPlan.lane, "report");
  assert.equal(strategyPlan.family, "report");
  assert.equal(strategyPlan.lane, "report");
  assert.equal(advicePlan.family, "report");
  assert.equal(advicePlan.lane, "report");
});

test("answer retrieval planner keeps 'what helped' questions in report lanes even when upstream family is temporal", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "What helped Deborah find peace when grieving deaths of her loved ones?",
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:deborah"]
  });

  assert.equal(plan.family, "report");
  assert.equal(plan.lane, "report");
  assert.ok(plan.candidatePools.includes("report_support"));
  assert.ok(plan.suppressionPools.includes("exact_detail_support"));
});

test("answer retrieval planner keeps how-long ownership questions in the exact-detail lane", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "How long has Nate had his first two turtles?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("How long has Nate had his first two turtles?", "generic_fact"),
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:nate"]
  });

  assert.equal(plan.family, "exact_detail");
  assert.equal(plan.lane, "exact_detail");
  assert.equal(plan.rescuePolicy, "single_targeted_rescue_before_fallback");
  assert.ok(plan.requiredFields.includes("exact_detail_support"));
  assert.ok(plan.targetedBackfillRequests.some((request) => request.reason === "exact_detail_support_missing"));
  assert.ok(plan.queryExpansionTerms.includes("years"));
  assert.ok(plan.queryExpansionTerms.includes("had them"));
});

test("answer retrieval planner keeps endorsement-company queries in the exact-detail lane", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "Which outdoor gear company likely signed up John for an endorsement deal?",
    predicateFamily: inferAnswerRetrievalPredicateFamily(
      "Which outdoor gear company likely signed up John for an endorsement deal?",
      "generic_fact"
    ),
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  assert.equal(plan.family, "exact_detail");
  assert.equal(plan.lane, "exact_detail");
  assert.equal(plan.rescuePolicy, "single_targeted_rescue_before_fallback");
});

test("answer retrieval planner keeps purchased-item questions out of collection inference", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "What items did Calvin buy in March 2023?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("What items did Calvin buy in March 2023?", "generic_fact"),
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:calvin"]
  });

  assert.equal(plan.family, "exact_detail");
  assert.equal(plan.lane, "exact_detail");
});

test("answer retrieval planner keeps favorite-memory questions out of preference profile lanes", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "What was Jon's favorite dancing memory?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("What was Jon's favorite dancing memory?", "generic_fact"),
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:jon"]
  });

  assert.equal(plan.family, "exact_detail");
  assert.equal(plan.lane, "exact_detail");
});

test("answer retrieval planner keeps pet-care and travel report questions out of exact-detail fallback", () => {
  const petCarePlan = buildAnswerRetrievalPlan({
    queryText: "What kind of classes or groups has Audrey joined to take better care of her dogs?",
    predicateFamily: inferAnswerRetrievalPredicateFamily(
      "What kind of classes or groups has Audrey joined to take better care of her dogs?",
      "generic_fact"
    ),
    reportKind: "pet_care_report"
  });
  const travelPlan = buildAnswerRetrievalPlan({
    queryText: "Where has Evan been on roadtrips with his family?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("Where has Evan been on roadtrips with his family?", "generic_fact"),
    reportKind: "travel_report"
  });

  assert.equal(petCarePlan.family, "report");
  assert.equal(petCarePlan.lane, "report");
  assert.ok(petCarePlan.suppressionPools.includes("exact_detail_support"));
  assert.equal(travelPlan.family, "report");
  assert.equal(travelPlan.lane, "report");
  assert.ok(travelPlan.suppressionPools.includes("exact_detail_support"));
});

test("answer retrieval planner routes explicit year questions into temporal pools", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "What year did John start surfing?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("What year did John start surfing?", "generic_fact"),
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  assert.equal(plan.family, "temporal");
  assert.equal(plan.lane, "temporal_event");
  assert.ok(plan.candidatePools.includes("canonical_temporal_facts"));
  assert.ok(plan.candidatePools.includes("normalized_event_facts"));
});

test("relative temporal label resolution handles word-based years-ago cues", () => {
  assert.equal(
    inferRelativeTemporalAnswerLabel(
      "John: I started surfing five years ago and it's been great.",
      "2023-07-16T16:21:00.000Z"
    ),
    "2018"
  );
});

test("temporal reducer accepts explicit year questions for anchored relative cues", () => {
  const claim = deriveTemporalClaimText("What year did John start surfing?", [
    recallResult(
      "John: I started surfing five years ago and it's been great. I love the connection to nature.",
      {
        tier: "answerable_unit"
      },
      "2023-07-16T16:21:00.000Z"
    )
  ]);

  assert.equal(claim, "The best supported year is 2018.");
});

test("answer retrieval planner routes social location-history questions into list-set pools", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "Where has Maria made friends?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("Where has Maria made friends?", "generic_fact"),
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:maria"]
  });

  assert.equal(plan.family, "list_set");
  assert.equal(plan.lane, "location_history");
  assert.ok(plan.candidatePools.includes("set_entries"));
  assert.ok(plan.targetedBackfillRequests.some((request) => request.reason === "location_history_entries_missing"));
});

test("profile inference evidence expansion keeps generic collection queries out of bookshelf and counseling lanes", () => {
  const queryText = "What items does John collect?";
  const expanded = buildProfileInferenceEvidenceQueryText(queryText, ["john", "collect", "items"]);

  assert.match(expanded, /\bcollect\b/i);
  assert.match(expanded, /\bitems\b/i);
  assert.doesNotMatch(expanded, /\bbookshelf\b/i);
  assert.doesNotMatch(expanded, /\bdr seuss\b/i);
  assert.doesNotMatch(expanded, /\bcounseling\b/i);
});

test("profile inference retrieval spec penalizes counseling lanes for bookshelf inference", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    predicateFamily: "profile_state"
  });
  const spec = buildProfileInferenceRetrievalSpec(
    "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    ["caroline", "bookshelf", "dr", "seuss"],
    plan
  );

  assert.ok(spec.candidatePools.includes("collection_support"));
  assert.ok(spec.suppressionPools.includes("career_support"));
  assert.ok(spec.terms.includes("bookshelf"));
  assert.ok(spec.terms.includes("dr seuss"));
  assert.ok(spec.bannedTerms.includes("counseling"));
  assert.ok(spec.penaltyScoreExpressions.some((expression) => expression.includes("counsel")));
  assert.ok(spec.positiveScoreExpressions.some((expression) => expression.includes("bookshelf")));
});

test("answer retrieval planner routes lgbtq community inference into community pools and career suppression", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "Would Melanie be considered a member of the LGBTQ community?",
    predicateFamily: "profile_state"
  });

  assert.equal(plan.family, "report");
  assert.ok(plan.candidatePools.includes("community_membership_support"));
  assert.ok(plan.suppressionPools.includes("career_support"));
  assert.ok(plan.queryExpansionTerms.includes("lgbtq"));
  assert.ok(plan.queryExpansionTerms.includes("community"));
  assert.ok(plan.bannedExpansionTerms.includes("counseling"));
});

test("strict bookshelf inference can synthesize an aggregate candidate from fallback support text", () => {
  const candidate = buildQueryBoundRecallAggregateCandidate({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    reportKind: "collection_report",
    predicateFamily: "narrative_profile",
    subjectTexts: [],
    fallbackTexts: [
      "I'm creating a library for when I have kids.",
      "The bookcase keeps filling with children's books."
    ]
  });

  assert.ok(candidate);
  assert.equal(candidate.text, "classic children's books");
  assert.equal(candidate.sourceTable, "retrieved_text_unit_aggregate_report");
  assert.equal(candidate.answerPayload?.answer_type, "bookshelf_inference");
});

test("strict bookshelf inference recognizes classics-heavy kids book support without library wording", () => {
  const candidate = buildQueryBoundRecallAggregateCandidate({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    reportKind: "collection_report",
    predicateFamily: "narrative_profile",
    subjectTexts: [
      "I've got lots of kids' books- classics, stories from different cultures, educational books, all of that."
    ],
    fallbackTexts: []
  });

  assert.ok(candidate);
  assert.equal(candidate.text, "classic children's books");
  assert.equal(candidate.answerPayload?.answer_type, "bookshelf_inference");
});

test("institutional support questions do not route into support reports", () => {
  assert.equal(
    inferReportOnlyKindFromQuery(
      "What type of individuals does the adoption agency Melanie is considering support?",
      "generic"
    ),
    null
  );

  const route = inferNarrativeRoute(
    "What type of individuals does the adoption agency Melanie is considering support?",
    "generic"
  );
  assert.equal(route.reportKind, null);
  assert.equal(route.narrativeKind, null);
});

test("concrete pastry detail questions do not route into report-only narratives", () => {
  assert.equal(
    inferReportOnlyKindFromQuery(
      "What kind of pastries did Andrew and his girlfriend have at the cafe?",
      "generic"
    ),
    null
  );
});

test("favorite media detail questions do not route into report-only narratives", () => {
  assert.equal(
    inferReportOnlyKindFromQuery("What is Nate's favorite movie trilogy?", "generic"),
    null
  );
});

test("collection set questions do not route into report-only narratives", () => {
  assert.equal(
    inferReportOnlyKindFromQuery("What items does John collect?", "generic"),
    null
  );
});

test("strict bookshelf inference routes as broad-profile support instead of current-state lookup", () => {
  const queryText = "Would Caroline likely have Dr. Seuss books on her bookshelf?";
  const planner = planRecallQuery({
    query: queryText,
    namespaceId: "test"
  });

  assert.equal(inferQueryModeHint(queryText, planner), "broad_profile");
});

test("career support objects infer counselor preference from mixed evidence", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "career_report",
    queryText: "Would Caroline pursue writing as a career option?",
    fallbackSummary: null,
    results: [
      recallResult("Caroline loves reading and writing in her free time.", {
        subject_name: "Caroline",
        speaker_name: "Caroline"
      }),
      recallResult("Caroline wants to become a counselor and help transgender people with mental health.", {
        subject_name: "Caroline",
        speaker_name: "Caroline"
      })
    ]
  });
  const rendered = renderCounterfactualCareerSupport(
    buildCounterfactualCareerSupport({
      queryText: "Would Caroline pursue writing as a career option?",
      support
    })
  );

  assert.equal(rendered.renderContractSelected, "career_likelihood_judgment");
  assert.equal(rendered.claimText, "Likely no.");
});

test("direct career-path reports keep the concrete career phrase instead of collapsing into a judgment label", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "career_report",
    queryText: "What career path has Caroline decided to persue?",
    fallbackSummary: null,
    results: [
      recallResult("Caroline says she wants to focus on counseling and mental health support for transgender people.", {
        subject_name: "Caroline",
        source_sentence_text: "Caroline says she wants to focus on counseling and mental health support for transgender people."
      })
    ]
  });
  const rendered = renderProfileInferenceSupport("What career path has Caroline decided to persue?", support);

  assert.equal(rendered.renderContractSelected, "report_scalar_value");
  assert.equal(rendered.claimText, "counseling or mental health for transgender people");
});

test("education report support renders a dedicated education field contract", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "education_report",
    queryText: "What fields would Caroline be likely to pursue in her educaton?",
    fallbackSummary: null,
    results: [
      recallResult("Caroline wants to become a counselor and support other people.", {
        subject_name: "Caroline"
      }),
      recallResult("Helping with mental health and support groups matters a lot to Caroline.", {
        subject_name: "Caroline"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport(
    "What fields would Caroline be likely to pursue in her educaton?",
    support
  );

  assert.equal(rendered.claimText, "Psychology, counseling certification");
  assert.equal(rendered.supportObjectType, "ProfileInferenceSupport");
  assert.equal(rendered.renderContractSelected, "education_field_render");
});

test("profile reports expose runtime re-synthesis shaping traces", () => {
  const decision = adjudicateNarrativeClaim({
    queryText: "What might John's financial status be?",
    exactDetailFamily: "generic",
    results: [
      recallResult("John said he finally had extra cash and is enjoying his new job.", {
        subject_entity_id: "person:john",
        subject_name: "John",
        speaker_name: "John"
      }),
      recallResult("John said he does not have to stress about it anymore.", {
        subject_entity_id: "person:john",
        subject_name: "John",
        speaker_name: "John"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:john",
      canonicalSubjectName: "John",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValue: "job i enjoy",
      reportKind: "profile_report",
      candidateCount: 2,
      sourceTable: "assembled_graph_entity_report"
    }
  });

  assert.ok(decision.candidate);
  assert.equal(decision.candidate.formatted.claimText, "Middle-class or wealthy");
  assert.equal(decision.candidate.formatted.shapingTrace?.shapingMode, "runtime_report_resynthesis");
  assert.equal(decision.candidate.formatted.shapingTrace?.runtimeResynthesisUsed, true);
  assert.equal(decision.candidate.formatted.shapingTrace?.supportObjectType, "ProfileInferenceSupport");
  assert.equal(decision.candidate.formatted.shapingTrace?.renderContractSelected, "report_scalar_value");
});

test("temporal answers expose event-keyed shaping traces", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What year did John start surfing?",
    results: [
      recallResult("John started surfing in 2018.", {
        subject_entity_id: "person:john",
        subject_name: "John"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      temporal: "2018"
    },
    storedCanonical: {
      kind: "temporal_fact",
      subjectEntityId: "person:john",
      canonicalSubjectName: "John",
      subjectBindingStatus: "resolved",
      predicateFamily: "temporal_event_fact",
      supportStrength: "strong",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValue: "2018",
      validFrom: "2018-01-01T00:00:00.000Z",
      sourceTable: "canonical_temporal_facts",
      eventKey: "start_surfing",
      eventType: "inception",
      timeGranularity: "year",
      answerYear: 2018
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(adjudicated.formatted.claimText, "2018");
  assert.equal(adjudicated.formatted.shapingTrace?.shapingMode, "typed_temporal_event");
  assert.equal(adjudicated.formatted.shapingTrace?.selectedEventKey, "start_surfing");
  assert.equal(adjudicated.formatted.shapingTrace?.selectedTimeGranularity, "year");
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectType, "TemporalEventSupport");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "temporal_year");
});

test("temporal support prefers earliest inception year across matched event candidates", () => {
  const rendered = renderTemporalEventSupport(
    "What year did John start surfing?",
    buildTemporalEventSupport({
      queryText: "What year did John start surfing?",
      storedCanonical: null,
      fallbackClaimText: null,
      results: [
        recallResult("2023", {
          subject_entity_id: "person:john",
          subject_name: "John",
          source_table: "temporal_results",
          metadata: {
            source_table: "temporal_results",
            subject_entity_id: "person:john",
            subject_name: "John",
            event_key: "start_surfing",
            time_granularity: "day",
            answer_year: 2023,
            answer_month: 7,
            answer_day: 16,
            source_turn_text: "John was talking about surfing recently."
          }
        }),
        recallResult("John started surfing in 2018.", {
          subject_entity_id: "person:john",
          subject_name: "John",
          source_table: "canonical_temporal_facts",
          metadata: {
            source_table: "canonical_temporal_facts",
            subject_entity_id: "person:john",
            subject_name: "John",
            event_key: "start_surfing",
            event_type: "inception",
            time_granularity: "year",
            answer_year: 2018
          }
        })
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "resolved for test"
    }),
    2
  );

  assert.equal(rendered.claimText, "2018");
  assert.equal(rendered.renderContractSelected, "temporal_year");
});

test("temporal recall shaping infers canonical-event provenance from thin structured rows", () => {
  const shape = readTemporalRecallShape(
    "What year did John start surfing?",
    recallResult("2018", {
      subject_entity_id: "person:john",
      subject_name: "John",
      source_table: "canonical_temporal_facts",
      metadata: {
        source_table: "canonical_temporal_facts",
        subject_entity_id: "person:john",
        subject_name: "John",
        event_key: "start_surfing",
        answer_year: 2018,
        source_turn_text: "John started surfing in 2018."
      }
    })
  );

  assert.equal(shape.supportKind, "explicit_event_fact");
  assert.equal(shape.temporalSourceQuality, "canonical_event");
  assert.equal(shape.bindingConfidence, 0.9);
  assert.match(shape.sourceText ?? "", /started surfing in 2018/i);
});

test("temporal support prefers absolute year output over relative anchor prose when only year support is resolved", () => {
  const rendered = renderTemporalEventSupport(
    "When did Melanie paint a sunrise?",
    buildTemporalEventSupport({
      queryText: "When did Melanie paint a sunrise?",
      storedCanonical: {
        kind: "temporal_fact",
        subjectEntityId: "person:melanie",
        canonicalSubjectName: "Melanie",
        subjectBindingStatus: "resolved",
        predicateFamily: "temporal_event_fact",
        supportStrength: "strong",
        timeScopeKind: "historical",
        confidence: "confident",
        answerYear: 2022,
        answerMonth: null,
        answerDay: null,
        timeGranularity: "year",
        eventKey: "paint_sunrise",
        eventType: "event"
      },
      fallbackClaimText: "The week before August 25, 2023.",
      results: [],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "resolved for test"
    }),
    0
  );

  assert.equal(rendered.claimText, "2022");
  assert.equal(rendered.renderContractSelected, "temporal_year");
});

test("temporal support prefers source-grounded absolute backfill over reference-derived event labels for generic when queries", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-temporal-support-sunrise-"));
  const sourcePath = join(dir, "conv-26-session_7.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-08-20T10:00:00.000Z",
      "",
      "Melanie: Yeah, I painted that lake sunrise last year! It's special to me."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When did Melanie paint a sunrise?",
      buildTemporalEventSupport({
        queryText: "When did Melanie paint a sunrise?",
        storedCanonical: null,
        fallbackClaimText: null,
        results: [
          recallResult("The week of August 14th to 20th, 2023", {
            subject_entity_id: "person:melanie",
            subject_name: "Melanie",
            source_uri: sourcePath,
            source_table: "canonical_temporal_facts",
            metadata: {
              source_table: "canonical_temporal_facts",
              subject_entity_id: "person:melanie",
              subject_name: "Melanie",
              source_uri: sourcePath,
              support_kind: "reference_derived_relative",
              temporal_source_quality: "derived_relative",
              derived_from_reference: true,
              event_key: "paint_that_lake_sunrise",
              event_type: "event",
              time_granularity: "day",
              answer_year: 2023,
              answer_month: 8,
              answer_day: 17,
              source_sentence_text: "The week of August 14th to 20th, 2023"
            }
          })
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      1
    );

    assert.equal(rendered.claimText, "2022");
    assert.equal(rendered.renderContractSelected, "temporal_year");
    assert.equal(rendered.targetedRetrievalSatisfied, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal recall shaping strips event dates from unanchored media mentions", () => {
  const shape = readTemporalRecallShape(
    "When did Melanie paint a sunrise?",
    recallResult("19 October 2023", {
      source_table: "media_mentions",
      leaf_source_table: "media_mentions",
      media_kind: "painting",
      mention_kind: "share",
      event_key: "paint_that_lake_sunrise",
      answer_year: 2023,
      answer_month: 10,
      answer_day: 19
    })
  );

  assert.equal(shape.eventKey, null);
  assert.equal(shape.answerYear, null);
  assert.equal(shape.answerMonth, null);
  assert.equal(shape.answerDay, null);
  assert.equal(shape.supportKind, "generic_time_fragment");
  assert.equal(shape.eventEvidenceKind, "none");
});

test("temporal recall shaping demotes generic exact job-loss rows when the query binds an employer", () => {
  const shape = readTemporalRecallShape(
    "When Gina has lost her job at Door Dash?",
    recallResult("After losing my job, I wanted to take control of my own destiny.", {
      event_key: "lose_job",
      answer_year: 2023,
      answer_month: 4,
      answer_day: 25,
      source_table: "canonical_temporal_facts"
    })
  );

  assert.notEqual(shape.eventEvidenceKind, "exact");
});

test("temporal recall shaping ignores subject-name overlap for drums resumption queries", () => {
  const shape = readTemporalRecallShape(
    "When did John resume playing drums in his adulthood?",
    recallResult(
      "Participant-bound turn for John.\nJames: I'm super into RPGs, so I'm excited about getting this video card and playing some new games.\nJohn: Yeah, I played it - it's awesome!",
      {
        metadata: {
          participant_names: ["James", "John"],
          source_sentence_text: "Yeah, I played it - it's awesome!",
          source_table: "participant_bound_turn_v1"
        }
      }
    )
  );

  assert.equal(shape.eventEvidenceKind, "none");
});

test("temporal support keeps donate-car queries bound to donate evidence instead of generic car incidents", () => {
  const dir = mkdtempSync(join(tmpdir(), "temporal-donate-car-"));
  const sourcePath = join(dir, "maria-donate-car.txt");
  writeFileSync(
    sourcePath,
    [
      "session_2 6:10 pm on 22 December, 2022 Maria: Hey John, been a few days since we chatted. In the meantime, I donated my old car to a homeless shelter I volunteer at yesterday.",
      "session_21 8:43 pm on 3 July, 2023 Maria: A car ran a red light and hit us yesterday, but thankfully everyone is okay."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When did Maria donate her car?",
      buildTemporalEventSupport({
        queryText: "When did Maria donate her car?",
        storedCanonical: null,
        fallbackClaimText: null,
        results: [
          recallResult(
            "Maria donated my old car to a homeless shelter yesterday.",
            {
              source_table: "canonical_temporal_facts",
              subject_entity_id: "person:maria",
              subject_name: "Maria",
              event_key: "donate_car",
              source_uri: sourcePath,
              metadata: {
                source_table: "canonical_temporal_facts",
                subject_entity_id: "person:maria",
                subject_name: "Maria",
                event_key: "donate_car",
                source_uri: sourcePath
              }
            },
            "2022-12-22T18:10:00.000Z"
          ),
          recallResult(
            "A car ran a red light and hit us yesterday.",
            {
              source_table: "canonical_temporal_facts",
              subject_entity_id: "person:maria",
              subject_name: "Maria",
              source_uri: sourcePath,
              metadata: {
                source_table: "canonical_temporal_facts",
                subject_entity_id: "person:maria",
                subject_name: "Maria",
                source_uri: sourcePath
              }
            },
            "2023-07-03T20:43:00.000Z"
          )
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "Single-subject plan resolved from canonical subject binding."
      }),
      2
    );

    assert.match(rendered.claimText ?? "", /December 2022/i);
    assert.equal(rendered.renderContractSelected, "temporal_day");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical adjudication keeps help queries in report shaping even when a stored canonical row is temporal", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What helped Deborah find peace when grieving deaths of her loved ones?",
    results: [
      recallResult("Yoga, old photos, the roses and dahlias in her flower garden, and time in nature helped Deborah find peace.", {
        subject_entity_id: "person:deborah",
        subject_name: "Deborah"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Deborah"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      causal: "Yoga, old photos, the roses and dahlias in her flower garden, and time in nature helped Deborah find peace."
    },
    storedCanonical: {
      kind: "temporal_fact",
      subjectEntityId: "person:deborah",
      canonicalSubjectName: "Deborah",
      subjectBindingStatus: "resolved",
      predicateFamily: "temporal_event_fact",
      supportStrength: "strong",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValue: "22 March 2023",
      sourceTable: "canonical_temporal_facts",
      eventKey: "grief_support",
      eventType: "event",
      timeGranularity: "day",
      answerYear: 2023,
      answerMonth: 3,
      answerDay: 22
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_profile");
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectType, "ProfileInferenceSupport");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "causal_reason_render");
  assert.match(adjudicated.formatted.claimText ?? "", /yoga/i);
});

test("temporal support refuses query-only event identity when only generic dated rows exist", () => {
  const rendered = renderTemporalEventSupport(
    "What year did John start surfing?",
    buildTemporalEventSupport({
      queryText: "What year did John start surfing?",
      storedCanonical: null,
      fallbackClaimText: null,
      results: [
        recallResult("John scored 40 points last week.", {
          subject_entity_id: "person:john",
          subject_name: "John",
          source_table: "canonical_temporal_facts",
          metadata: {
            source_table: "canonical_temporal_facts",
            subject_entity_id: "person:john",
            subject_name: "John",
            time_granularity: "day",
            answer_year: 2023,
            answer_month: 7,
            answer_day: 16
          }
        })
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "resolved for test"
    }),
    1
  );

  assert.equal(rendered.renderContractSelected, "temporal_missing_event_identity");
  assert.equal(rendered.targetedRetrievalSatisfied, false);
  assert.equal(rendered.selectedEventKey, null);
});

test("temporal support accepts aligned anchor evidence when the query has no explicit event key", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-temporal-support-seattle-"));
  const sourcePath = join(dir, "conv-43-session_3.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-07-16T16:21:00.000Z",
      "",
      "John: It's Seattle, I'm stoked for my game there next month!"
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When was John in Seattle for a game?",
      buildTemporalEventSupport({
        queryText: "When was John in Seattle for a game?",
        storedCanonical: null,
        fallbackClaimText: null,
        results: [
          {
            memoryId: "john-seattle",
            memoryType: "episodic_memory",
            content: "John: It's Seattle, I'm stoked for my game there next month!",
            artifactId: "artifact-john-seattle",
            occurredAt: "2023-07-16T16:21:00.000Z",
            namespaceId: "test",
            provenance: {
              source_uri: sourcePath,
              subject_entity_id: "person:john",
              subject_name: "John",
              source_table: "canonical_temporal_facts",
              metadata: {
                source_table: "canonical_temporal_facts",
                subject_entity_id: "person:john",
                subject_name: "John",
                source_turn_text: "John: It's Seattle, I'm stoked for my game there next month!",
                source_sentence_text: "John: It's Seattle, I'm stoked for my game there next month!"
              }
            }
          }
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      1
    );

    assert.equal(rendered.claimText, "Early August, 2023");
    assert.equal(rendered.renderContractSelected, "temporal_relative_day");
    assert.ok(
      ["resolved", "resolved_from_event_neighborhood"].includes(rendered.temporalEventIdentityStatus)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal support resolves event identity from aligned neighborhoods for career-high month queries", () => {
  const rendered = renderTemporalEventSupport(
    "In which month's game did John achieve a career-high score in points?",
    buildTemporalEventSupport({
      queryText: "In which month's game did John achieve a career-high score in points?",
      storedCanonical: null,
      fallbackClaimText: null,
      results: [
        recallResult("June 2023", {
          subject_entity_id: "person:john",
          subject_name: "John",
          source_table: "canonical_temporal_facts",
          metadata: {
            source_table: "canonical_temporal_facts",
            subject_entity_id: "person:john",
            subject_name: "John",
            fact_value: "Last week I scored 40 points, my highest ever, and it feels like all my hard work's paying off.",
            anchor_text: "June 2023",
            source_sentence_text: "Last week I scored 40 points, my highest ever, and it feels like all my hard work's paying off.",
            time_granularity: "month",
            answer_year: 2023,
            answer_month: 6
          }
        })
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "resolved for test"
    }),
    1
  );

  assert.equal(rendered.claimText, "June 2023");
  assert.equal(rendered.renderContractSelected, "temporal_month");
  assert.ok(
    ["resolved_from_aligned_candidate", "resolved_from_event_neighborhood"].includes(
      rendered.temporalEventIdentityStatus
    )
  );
});

test("temporal support prefers canonical occurredAt parts over conflicting derived temporal labels", () => {
  const rendered = renderTemporalEventSupport(
    "When did Maria donate her car?",
    buildTemporalEventSupport({
      queryText: "When did Maria donate her car?",
      storedCanonical: null,
      fallbackClaimText: null,
      results: [
        recallResult("2 July 2023", {
          subject_entity_id: "person:maria",
          subject_name: "Maria",
          source_table: "canonical_temporal_facts",
          metadata: {
            source_table: "canonical_temporal_facts",
            subject_entity_id: "person:maria",
            subject_name: "Maria",
            event_key: "donate_car",
            event_type: "donation",
            fact_value: "Maria donated her old car to a homeless shelter yesterday.",
            source_sentence_text: "Maria donated her old car to a homeless shelter yesterday.",
            answer_year: 2023,
            answer_month: 7,
            answer_day: 2,
            support_kind: "explicit_event_fact",
            temporal_source_quality: "canonical_event"
          }
        }, "2022-12-21T18:10:00.000Z")
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "resolved for test"
    }),
    1
  );

  assert.equal(rendered.claimText, "21 December 2022");
  assert.equal(rendered.renderContractSelected, "temporal_day");
});

test("temporal support prefers canonical occurredAt parts over bare conflicting temporal summaries", () => {
  const rendered = renderTemporalEventSupport(
    "When Gina has lost her job at Door Dash?",
    buildTemporalEventSupport({
      queryText: "When Gina has lost her job at Door Dash?",
      storedCanonical: null,
      fallbackClaimText: null,
      results: [
        recallResult("25 April 2023", {
          subject_entity_id: "person:gina",
          subject_name: "Gina",
          source_table: "canonical_temporal_facts",
          metadata: {
            source_table: "canonical_temporal_facts",
            subject_entity_id: "person:gina",
            subject_name: "Gina",
            event_key: "lose_job",
            event_type: "event",
            fact_value: "I also lost my job at Door Dash this month.",
            source_sentence_text: "I also lost my job at Door Dash this month.",
            answer_year: 2023,
            answer_month: 4,
            answer_day: 25,
            support_kind: "explicit_event_fact",
            temporal_source_quality: "canonical_event",
            derived_from_reference: true
          }
        }, "2023-01-20T16:04:00.000Z")
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "resolved for test"
    }),
    1
  );

  assert.equal(rendered.claimText, "January 2023");
  assert.equal(rendered.renderContractSelected, "temporal_month_year");
});

test("temporal support prefers object-aligned month-level evidence over weaker exact-day event rows", () => {
  const rendered = renderTemporalEventSupport(
    "When Gina has lost her job at Door Dash?",
    buildTemporalEventSupport({
      queryText: "When Gina has lost her job at Door Dash?",
      storedCanonical: null,
      fallbackClaimText: null,
      results: [
        recallResult("25 April 2023", {
          subject_entity_id: "person:gina",
          subject_name: "Gina",
          source_table: "canonical_temporal_facts",
          metadata: {
            source_table: "canonical_temporal_facts",
            subject_entity_id: "person:gina",
            subject_name: "Gina",
            event_key: "lose_job",
            event_type: "event",
            fact_value: "Gina lost her job and had to rethink her plans.",
            source_sentence_text: "Gina lost her job and had to rethink her plans.",
            answer_year: 2023,
            answer_month: 4,
            answer_day: 25,
            support_kind: "explicit_event_fact",
            temporal_source_quality: "canonical_event"
          }
        }, "2023-04-25T16:04:00.000Z"),
        recallResult("25 April 2023", {
          subject_entity_id: "person:gina",
          subject_name: "Gina",
          source_table: "canonical_temporal_facts",
          metadata: {
            source_table: "canonical_temporal_facts",
            subject_entity_id: "person:gina",
            subject_name: "Gina",
            event_key: "lose_job",
            event_type: "event",
            fact_value: "I also lost my job at Door Dash this month.",
            source_sentence_text: "I also lost my job at Door Dash this month.",
            answer_year: 2023,
            answer_month: 4,
            answer_day: 25,
            support_kind: "explicit_event_fact",
            temporal_source_quality: "canonical_event",
            derived_from_reference: true
          }
        }, "2023-01-20T16:04:00.000Z")
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "resolved for test"
    }),
    2
  );

  assert.equal(rendered.claimText, "January 2023");
  assert.equal(rendered.renderContractSelected, "temporal_month_year");
  assert.equal(rendered.targetedFieldsRequested.includes("day"), false);
});

test("artifact-derived bare temporal labels do not outrank grounded month-level source cues", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-gina-source-"));
  const sourceUri = join(tempDir, "conv-30-session_1.md");
  writeFileSync(
    sourceUri,
    "Gina: Sorry about your job Jon, but starting your own business sounds awesome! Unfortunately, I also lost my job at Door Dash this month. What business are you thinking of?\n",
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When Gina has lost her job at Door Dash?",
      buildTemporalEventSupport({
        queryText: "When Gina has lost her job at Door Dash?",
        storedCanonical: null,
        fallbackClaimText: null,
        results: [
          recallResult("25 April 2023", {
            subject_entity_id: "person:gina",
            subject_name: "Gina",
            source_table: "artifact_derivations",
            source_uri: sourceUri,
            metadata: {
              source_table: "artifact_derivations",
              subject_entity_id: "person:gina",
              subject_name: "Gina",
              event_key: "lose_job",
              event_type: "event",
              fact_value: "Gina lost her job and had to rethink her plans.",
              source_sentence_text: "Gina lost her job and had to rethink her plans."
            }
          }, "2023-01-20T16:04:00.000Z", "artifact_derivation")
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      1
    );

    assert.equal(rendered.claimText, "January 2023");
    assert.equal(rendered.renderContractSelected, "temporal_month_year");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support backfills year answers from anchored relative year cues", () => {
  const rendered = renderTemporalEventSupport(
    "What year did John start surfing?",
    buildTemporalEventSupport({
      queryText: "What year did John start surfing?",
      storedCanonical: null,
      fallbackClaimText: null,
      results: [
        {
          memoryId: "john-surfing-relative",
          memoryType: "episodic_memory",
          content: "John: I started surfing five years ago and it's been great.",
          artifactId: "artifact-john-surfing-relative",
          occurredAt: "2023-07-16T16:21:00.000Z",
          namespaceId: "test",
          provenance: {
            metadata: {
              source_turn_text: "John: I started surfing five years ago and it's been great."
            }
          }
        }
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "resolved for test"
    }),
    1
  );

  assert.equal(rendered.claimText, "2018");
  assert.equal(rendered.renderContractSelected, "temporal_year");
  assert.equal(rendered.targetedRetrievalSatisfied, true);
});

test("temporal support prefers source-grounded adoption year over conflicting stored canonical year", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-adoption-source-grounded-"));
  const sourcePath = join(tempDir, "conv-44-session_17.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-08-24T00:24:00.000Z",
      "",
      "Audrey: I've had them for 3 years! Their names are Pepper, Precious and Panda."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "Which year did Audrey adopt the first three of her dogs?",
      buildTemporalEventSupport({
        queryText: "Which year did Audrey adopt the first three of her dogs?",
        storedCanonical: {
          kind: "temporal_fact",
          subjectEntityId: "person:audrey",
          canonicalSubjectName: "Audrey",
          subjectBindingStatus: "resolved",
          predicateFamily: "temporal_event_fact",
          supportStrength: "moderate",
          timeScopeKind: "event",
          confidence: "confident",
          objectValue: "2023",
          eventKey: "adopt_first_three_dogs",
          eventType: "adoption",
          timeGranularity: "year",
          answerYear: 2023,
          answerMonth: null,
          answerDay: null,
          sourceTable: "canonical_temporal_facts"
        },
        fallbackClaimText: null,
        results: [
          recallResult(
            "Audrey: I've had them for 3 years! Their names are Pepper, Precious and Panda.",
            {
              source_uri: sourcePath,
              metadata: {
                source_turn_text: "Audrey: I've had them for 3 years! Their names are Pepper, Precious and Panda."
              }
            },
            "2023-08-24T00:24:00.000Z"
          )
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      1
    );

    assert.equal(rendered.claimText, "2020");
    assert.equal(rendered.renderContractSelected, "temporal_year");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support keeps the adopt-first-three query event key when generic year facts are present", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-adoption-event-key-"));
  const sourcePath = join(tempDir, "conv-44-session_18.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-08-24T00:24:00.000Z",
      "",
      "Audrey: I've had them for 3 years! Their names are Pepper, Precious and Panda."
    ].join("\n"),
    "utf8"
  );

  try {
    const support = buildTemporalEventSupport({
      queryText: "Which year did Audrey adopt the first three of her dogs?",
      storedCanonical: null,
      fallbackClaimText: null,
      results: [
        recallResult("2023", {
          subject_entity_id: "person:audrey",
          subject_name: "Audrey",
          source_table: "canonical_temporal_facts",
          metadata: {
            source_table: "canonical_temporal_facts",
            subject_entity_id: "person:audrey",
            subject_name: "Audrey",
            event_key: "all",
            answer_year: 2023,
            time_granularity: "year",
            source_sentence_text: "They're all 3-year-old and they are a great pack."
          }
        }),
        recallResult(
          "Audrey: I've had them for 3 years! Their names are Pepper, Precious and Panda.",
          {
            source_uri: sourcePath,
            metadata: {
              source_turn_text: "Audrey: I've had them for 3 years! Their names are Pepper, Precious and Panda."
            }
          },
          "2023-08-24T00:24:00.000Z"
        )
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "resolved for test"
    });

    const rendered = renderTemporalEventSupport(
      "Which year did Audrey adopt the first three of her dogs?",
      support,
      2
    );

    assert.equal(support.eventKey, "adopt_first_three_dogs");
    assert.equal(rendered.claimText, "2020");
    assert.equal(rendered.renderContractSelected, "temporal_year");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support backfills aligned source dates for generic when queries without explicit relative cues", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-temporal-donate-"));
  const sourcePath = join(tempDir, "maria-donate-session_1.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2022-12-21T09:00:00.000Z",
      "",
      "Maria donated her old car to a homeless shelter where she volunteers."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When did Maria donate her car?",
      buildTemporalEventSupport({
        queryText: "When did Maria donate her car?",
        storedCanonical: {
          kind: "temporal_fact",
          subjectEntityId: "person:maria",
          canonicalSubjectName: "Maria",
          subjectBindingStatus: "resolved",
          predicateFamily: "temporal_event_fact",
          supportStrength: "strong",
          timeScopeKind: "historical",
          confidence: "confident",
          eventKey: "donate_car",
          eventType: "event",
          answerYear: 2022,
          timeGranularity: "year"
        },
        fallbackClaimText: null,
        results: [
          recallResult("Maria donated her old car to a homeless shelter where she volunteers.", {
            subject_entity_id: "person:maria",
            subject_name: "Maria",
            source_uri: sourcePath,
            metadata: {
              source_sentence_text: "Maria donated her old car to a homeless shelter where she volunteers."
            }
          })
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      1
    );

    assert.equal(rendered.claimText, "21 December 2022");
    assert.equal(rendered.renderContractSelected, "temporal_day");
    assert.equal(rendered.targetedRetrievalSatisfied, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support recovers first-person event sentences from subject-aligned session sources", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-temporal-ad-campaign-"));
  const sourcePath = join(tempDir, "gina-store-session_1.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-01-29T10:00:00.000Z",
      "",
      "I just launched an ad campaign for my clothing store in hopes of growing the business."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When did Gina launch an ad campaign for her store?",
      buildTemporalEventSupport({
        queryText: "When did Gina launch an ad campaign for her store?",
        storedCanonical: {
          kind: "temporal_fact",
          subjectEntityId: "person:gina",
          canonicalSubjectName: "Gina",
          subjectBindingStatus: "resolved",
          predicateFamily: "temporal_event_fact",
          supportStrength: "strong",
          timeScopeKind: "historical",
          confidence: "confident",
          eventKey: "launch_ad_campaign",
          eventType: "event",
          answerYear: null,
          answerMonth: null,
          answerDay: null,
          timeGranularity: null
        },
        fallbackClaimText: null,
        results: [
          recallResult("Planning more marketing work for the store.", {
            subject_entity_id: "person:gina",
            subject_name: "Gina",
            source_uri: sourcePath,
            metadata: {
              source_sentence_text: "Planning more marketing work for the store."
            }
          })
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      1
    );

    assert.equal(rendered.claimText, "29 January 2023");
    assert.equal(rendered.renderContractSelected, "temporal_day");
    assert.equal(rendered.targetedRetrievalSatisfied, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support prefers week-range relative renders over forced single-day fallbacks", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-temporal-muffins-"));
  const sourcePath = join(tempDir, "audrey-muffins-session_1.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-04-10T12:00:00.000Z",
      "",
      "Audrey made muffins for herself last week."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When did Audrey make muffins for herself?",
      buildTemporalEventSupport({
        queryText: "When did Audrey make muffins for herself?",
        storedCanonical: null,
        fallbackClaimText: null,
        results: [
          recallResult("Audrey made muffins for herself last week.", {
            subject_entity_id: "person:audrey",
            subject_name: "Audrey",
            source_uri: sourcePath,
            metadata: {
              source_sentence_text: "Audrey made muffins for herself last week."
            }
          })
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      1
    );

    assert.equal(rendered.renderContractSelected, "temporal_relative_day");
    assert.equal(rendered.claimText, "The week of April 3rd to 9th, 2023");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support prefers query-aligned muffin windows over unrelated absolute dates", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-temporal-muffins-conflict-"));
  const sourcePath = join(tempDir, "audrey-muffins-session_2.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-04-10T12:00:00.000Z",
      "",
      "Audrey made muffins for herself last week."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When did Audrey make muffins for herself?",
      buildTemporalEventSupport({
        queryText: "When did Audrey make muffins for herself?",
        storedCanonical: null,
        fallbackClaimText: null,
        results: [
          recallResult("18 August 2023", {
            subject_entity_id: "person:audrey",
            subject_name: "Audrey",
            source_table: "canonical_temporal_facts",
            metadata: {
              source_table: "canonical_temporal_facts",
              subject_entity_id: "person:audrey",
              subject_name: "Audrey",
              answer_year: 2023,
              answer_month: 8,
              answer_day: 18,
              time_granularity: "day",
              source_sentence_text: "Audrey went somewhere else on 18 August 2023."
            }
          }),
          recallResult("Audrey made muffins for herself last week.", {
            subject_entity_id: "person:audrey",
            subject_name: "Audrey",
            source_uri: sourcePath,
            metadata: {
              source_sentence_text: "Audrey made muffins for herself last week."
            }
          })
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      2
    );

    assert.equal(rendered.renderContractSelected, "temporal_relative_day");
    assert.equal(rendered.claimText, "The week of April 3rd to 9th, 2023");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support keeps muffins-for-herself rows on the relative week path", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-temporal-muffins-herself-"));
  const sourcePath = join(tempDir, "audrey-muffins-session_3.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-04-10T12:00:00.000Z",
      "",
      "Audrey baked muffins for herself last week."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When did Audrey make muffins for herself?",
      buildTemporalEventSupport({
        queryText: "When did Audrey make muffins for herself?",
        storedCanonical: null,
        fallbackClaimText: null,
        results: [
          recallResult("19 August 2023", {
            subject_entity_id: "person:audrey",
            subject_name: "Audrey",
            source_table: "canonical_temporal_facts",
            metadata: {
              source_table: "canonical_temporal_facts",
              subject_entity_id: "person:audrey",
              subject_name: "Audrey",
              answer_year: 2023,
              answer_month: 8,
              answer_day: 19,
              time_granularity: "day",
              source_sentence_text: "Audrey went somewhere else on 19 August 2023."
            }
          }),
          recallResult("Audrey baked muffins for herself last week.", {
            subject_entity_id: "person:audrey",
            subject_name: "Audrey",
            source_uri: sourcePath,
            metadata: {
              source_sentence_text: "Audrey baked muffins for herself last week."
            }
          })
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      2
    );

    assert.equal(rendered.renderContractSelected, "temporal_relative_day");
    assert.equal(rendered.claimText, "The week of April 3rd to 9th, 2023");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support keeps just-for-myself muffin rows on the relative week path", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-temporal-muffins-myself-"));
  const sourcePath = join(tempDir, "audrey-muffins-session_4.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-04-10T12:00:00.000Z",
      "",
      "I baked muffins just for myself last week."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When did Audrey make muffins for herself?",
      buildTemporalEventSupport({
        queryText: "When did Audrey make muffins for herself?",
        storedCanonical: null,
        fallbackClaimText: null,
        results: [
          recallResult("19 August 2023", {
            subject_entity_id: "person:audrey",
            subject_name: "Audrey",
            source_table: "canonical_temporal_facts",
            metadata: {
              source_table: "canonical_temporal_facts",
              subject_entity_id: "person:audrey",
              subject_name: "Audrey",
              answer_year: 2023,
              answer_month: 8,
              answer_day: 19,
              time_granularity: "day",
              source_sentence_text: "Audrey went somewhere else on 19 August 2023."
            }
          }),
          recallResult("I baked muffins just for myself last week.", {
            subject_entity_id: "person:audrey",
            subject_name: "Audrey",
            source_uri: sourcePath,
            metadata: {
              source_turn_text: "I baked muffins just for myself last week."
            }
          })
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      2
    );

    assert.equal(rendered.renderContractSelected, "temporal_relative_day");
    assert.equal(rendered.claimText, "The week of April 3rd to 9th, 2023");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support recovers muffin week windows from same-observation pastry metadata", () => {
  const rendered = renderTemporalEventSupport(
    "When did Audrey make muffins for herself?",
    buildTemporalEventSupport({
      queryText: "When did Audrey make muffins for herself?",
      storedCanonical: null,
      fallbackClaimText: null,
      results: [
        recallResult(
          "Wow, sounds amazing! Glad you got to enjoy them. Since you metioned pastries, I made some of my favorite treats last week. Let's have a pastry party sometime!",
          {
            subject_entity_id: "person:audrey",
            subject_name: "Audrey",
            speaker_name: "Audrey",
            query: "homemade blueberry muffin pastry",
            blip_caption: "a photo of a muffin pan filled with blueberries and muffins",
            metadata: {
              source_turn_text:
                "Audrey: Wow, sounds amazing! Glad you got to enjoy them. Since you metioned pastries, I made some of my favorite treats last week. Let's have a pastry party sometime!",
              query: "homemade blueberry muffin pastry",
              blip_caption: "a photo of a muffin pan filled with blueberries and muffins"
            }
          },
          "2023-04-10T12:00:00.000Z"
        )
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "resolved for test"
    }),
    1
  );

  assert.equal(rendered.renderContractSelected, "temporal_relative_day");
  assert.equal(rendered.claimText, "The week of April 3rd to 9th, 2023");
});

test("temporal support recovers muffin week windows from sibling pastry turns in the same source session", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-temporal-muffins-sibling-"));
  const sourcePath = join(tempDir, "conv-44-session_3.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-04-10T12:00:00.000Z",
      "",
      "Andrew: They taste great too! We had some delicious croissants, muffins, and tarts! It was amazing!",
      "Audrey: Wow, sounds amazing! Glad you got to enjoy them. Since you metioned pastries, I made some of my favorite treats last week. Let's have a pastry party sometime!"
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When did Audrey make muffins for herself?",
      buildTemporalEventSupport({
        queryText: "When did Audrey make muffins for herself?",
        storedCanonical: {
          kind: "temporal_fact",
          subjectEntityId: "person:audrey",
          canonicalSubjectName: "Audrey",
          subjectBindingStatus: "resolved",
          predicateFamily: "temporal_event_fact",
          supportStrength: "moderate",
          timeScopeKind: "event",
          confidence: "confident",
          objectValue: "19 August 2023",
          eventKey: "make_muffins_self",
          eventType: "activity",
          timeGranularity: "day",
          answerYear: 2023,
          answerMonth: 8,
          answerDay: 19,
          sourceTable: "canonical_temporal_facts",
          supportKind: "reference_derived_relative",
          temporalSourceQuality: "derived_relative",
          derivedFromReference: true
        },
        fallbackClaimText: null,
        results: [
          recallResult(
            "19 August 2023",
            {
              subject_entity_id: "person:audrey",
              subject_name: "Audrey",
              source_uri: sourcePath,
              metadata: {
                source_turn_text:
                  "Audrey: Wow, sounds amazing! Glad you got to enjoy them. Since you metioned pastries, I made some of my favorite treats last week. Let's have a pastry party sometime!"
              }
            },
            "2023-04-10T12:00:00.000Z"
          )
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      1
    );

    assert.equal(rendered.renderContractSelected, "temporal_relative_day");
    assert.equal(rendered.claimText, "The week of April 3rd to 9th, 2023");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support uses month-year renders for generic when queries when day support is unavailable", () => {
  const rendered = renderTemporalEventSupport(
    "When did Melanie go camping in June?",
    buildTemporalEventSupport({
      queryText: "When did Melanie go camping in June?",
      storedCanonical: {
        kind: "temporal_fact",
        subjectEntityId: "person:melanie",
        canonicalSubjectName: "Melanie",
        subjectBindingStatus: "resolved",
        predicateFamily: "temporal_event_fact",
        supportStrength: "strong",
        timeScopeKind: "historical",
        confidence: "confident",
        objectValue: "The best supported year is 2023.",
        answerYear: 2023,
        answerMonth: 6
      },
      fallbackClaimText: "The best supported year is 2023.",
      results: [],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "Canonical subject resolved from provenance-backed candidates."
    }),
    1
  );

  assert.equal(rendered.supportObjectType, "TemporalEventSupport");
  assert.equal(rendered.claimText, "June 2023");
  assert.equal(rendered.renderContractSelected, "temporal_month_year");
  assert.equal(rendered.renderContractFallbackReason, null);
  assert.equal(rendered.temporalGranularityStatus, "missing_day");
  assert.equal(rendered.targetedRetrievalAttempted, true);
  assert.deepEqual(rendered.targetedFieldsRequested, ["day"]);
});

test("temporal support reports subject-binding misses explicitly", () => {
  const rendered = renderTemporalEventSupport(
    "When did Caroline go to the adoption meeting?",
    buildTemporalEventSupport({
      queryText: "When did Caroline go to the adoption meeting?",
      storedCanonical: {
        kind: "temporal_fact",
        subjectEntityId: "person:caroline",
        canonicalSubjectName: "Caroline",
        subjectBindingStatus: "ambiguous",
        predicateFamily: "temporal_event_fact",
        supportStrength: "weak",
        timeScopeKind: "historical",
        confidence: "weak",
        objectValue: "The best supported date is 5 July 2023."
      },
      fallbackClaimText: "The best supported date is 5 July 2023.",
      results: [],
      subjectBindingStatus: "ambiguous",
      subjectBindingReason: "Multiple plausible subject candidates remained after subject binding."
    }),
    1
  );

  assert.equal(rendered.renderContractSelected, "temporal_subject_binding_missing");
  assert.equal(rendered.renderContractFallbackReason, "subject_binding_unresolved");
  assert.equal(rendered.subjectBindingStatus, "ambiguous");
  assert.equal(rendered.temporalEventIdentityStatus, "blocked_by_subject_binding");
});

test("temporal support prefers query-aligned backfill when stored event identity mismatches", () => {
  const rendered = renderTemporalEventSupport(
    "When did Caroline join a mentorship program?",
    buildTemporalEventSupport({
      queryText: "When did Caroline join a mentorship program?",
      storedCanonical: {
        kind: "temporal_fact",
        subjectEntityId: "person:caroline",
        canonicalSubjectName: "Caroline",
        subjectBindingStatus: "resolved",
        predicateFamily: "temporal_event_fact",
        supportStrength: "strong",
        timeScopeKind: "historical",
        confidence: "confident",
        objectValue: "20 July 2023",
        eventKey: "join_lgbtq_activist_group",
        eventType: "milestone",
        timeGranularity: "day",
        answerYear: 2023,
        answerMonth: 7,
        answerDay: 20
      },
      fallbackClaimText: "The best supported date is 14 July 2023.",
      results: [],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "Stored canonical subject matched the explicit named query anchor."
    }),
    1
  );

  assert.equal(rendered.supportObjectType, "TemporalEventSupport");
  assert.equal(rendered.renderContractSelected, "temporal_day");
  assert.equal(rendered.selectedEventKey, "join_mentorship_program");
  assert.equal(rendered.temporalEventIdentityStatus, "resolved_from_query_backfill");
  assert.equal(rendered.targetedRetrievalAttempted, true);
  assert.equal(rendered.targetedRetrievalReason, "temporal_event_identity_mismatch");
  assert.deepEqual(rendered.targetedFieldsRequested, ["event_identity"]);
  assert.equal(rendered.claimText, "14 July 2023");
});

test("temporal support prefers absolute dates over relative phrasing once day-granularity facts are resolved", () => {
  const relativeResult = recallResult("Caroline joined a new activist group the Tuesday before.");
  relativeResult.occurredAt = "2023-07-20T12:00:00.000Z";
  const rendered = renderTemporalEventSupport(
    "When did Caroline join a new activist group?",
    buildTemporalEventSupport({
      queryText: "When did Caroline join a new activist group?",
      storedCanonical: {
        kind: "temporal_fact",
        subjectEntityId: "person:caroline",
        canonicalSubjectName: "Caroline",
        subjectBindingStatus: "resolved",
        predicateFamily: "temporal_event_fact",
        supportStrength: "strong",
        timeScopeKind: "historical",
        confidence: "confident",
        objectValue: "18 July 2023",
        eventKey: "join_activist_group",
        eventType: "milestone",
        timeGranularity: "day",
        answerYear: 2023,
        answerMonth: 7,
        answerDay: 18
      },
      fallbackClaimText: "The best supported date is 18 July 2023.",
      results: [relativeResult],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "Stored canonical subject matched the explicit named query anchor."
    }),
    1
  );

  assert.equal(rendered.supportObjectType, "TemporalEventSupport");
  assert.equal(rendered.renderContractSelected, "temporal_day");
  assert.equal(rendered.claimText, "18 July 2023");
  assert.equal(rendered.relativeAnchorStatus, "resolved");
});

test("temporal support trusts explicit-event occurredAt values when persisted date parts conflict", () => {
  const rendered = renderTemporalEventSupport(
    "When did Maria donate her car?",
    buildTemporalEventSupport({
      queryText: "When did Maria donate her car?",
      storedCanonical: {
        kind: "temporal_fact",
        subjectEntityId: "person:maria",
        canonicalSubjectName: "Maria",
        subjectBindingStatus: "resolved",
        predicateFamily: "temporal_event_fact",
        supportStrength: "strong",
        timeScopeKind: "historical",
        confidence: "confident",
        objectValue: "2 July 2023",
        eventKey: "donate_car",
        eventType: "milestone",
        timeGranularity: "day",
        answerYear: 2023,
        answerMonth: 7,
        answerDay: 2,
        mentionedAt: "2022-12-21T00:00:00.000Z",
        sourceTable: "canonical_temporal_facts",
        supportKind: "explicit_event_fact",
        temporalSourceQuality: "canonical_event"
      },
      fallbackClaimText: "2 July 2023",
      results: [],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "Stored canonical subject matched the explicit named query anchor."
    }),
    1
  );

  assert.equal(rendered.renderContractSelected, "temporal_day");
  assert.equal(rendered.claimText, "21 December 2022");
});

test("temporal support prefers anchored relative year phrases over provenance day dates", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-mother-pass-away-"));
  const sourcePath = join(tempDir, "conv-48-session_5.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-01-16T09:00:00.000Z",
      "",
      "Deborah: My mother passed away a few years ago, and I still think about her every day."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When did Deborah`s mother pass away?",
      buildTemporalEventSupport({
        queryText: "When did Deborah`s mother pass away?",
        storedCanonical: {
          kind: "temporal_fact",
          subjectEntityId: "person:deborah",
          canonicalSubjectName: "Deborah",
          subjectBindingStatus: "resolved",
          predicateFamily: "temporal_event_fact",
          supportStrength: "moderate",
          timeScopeKind: "event",
          confidence: "confident",
          objectValue: "16 January 2023",
          eventKey: "mother_pass_away",
          eventType: "loss",
          timeGranularity: "day",
          answerYear: 2023,
          answerMonth: 1,
          answerDay: 16,
          sourceTable: "canonical_temporal_facts"
        },
        fallbackClaimText: null,
        results: [
          recallResult(
            "Deborah: My mother passed away a few years ago, and I still think about her every day.",
            {
              source_uri: sourcePath,
              metadata: {
                source_turn_text: "Deborah: My mother passed away a few years ago, and I still think about her every day."
              }
            },
            "2023-01-16T09:00:00.000Z"
          )
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      1
    );

    assert.match(rendered.claimText ?? "", /few years before 2023/i);
    assert.equal(rendered.renderContractSelected, "temporal_relative_day");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support resolves mother-last-year rows to a year render instead of the anchor day", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-jolene-mother-last-year-"));
  const sourcePath = join(tempDir, "conv-48-session_6.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-03-17T09:00:00.000Z",
      "",
      "Jolene: My mother also passed away last year."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When did Jolene`s mother pass away?",
      buildTemporalEventSupport({
        queryText: "When did Jolene`s mother pass away?",
        storedCanonical: {
          kind: "temporal_fact",
          subjectEntityId: "person:jolene",
          canonicalSubjectName: "Jolene",
          subjectBindingStatus: "resolved",
          predicateFamily: "temporal_event_fact",
          supportStrength: "moderate",
          timeScopeKind: "event",
          confidence: "confident",
          objectValue: "17 March 2023",
          eventKey: "mother_pass_away",
          eventType: "loss",
          timeGranularity: "day",
          answerYear: 2023,
          answerMonth: 3,
          answerDay: 17,
          sourceTable: "canonical_temporal_facts",
          supportKind: "reference_derived_relative",
          temporalSourceQuality: "derived_relative",
          derivedFromReference: true
        },
        fallbackClaimText: null,
        results: [
          recallResult(
            "Jolene: My mother also passed away last year.",
            {
              subject_entity_id: "person:jolene",
              subject_name: "Jolene",
              source_uri: sourcePath,
              source_table: "canonical_temporal_facts",
              metadata: {
                source_table: "canonical_temporal_facts",
                source_turn_text: "Jolene: My mother also passed away last year."
              }
            },
            "2023-03-17T09:00:00.000Z"
          )
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      1
    );

    assert.equal(rendered.renderContractSelected, "temporal_year");
    assert.equal(rendered.claimText, "2022");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal derivation recovers mother-last-year cues from result-level source text without a source file", () => {
  const claimText = deriveTemporalClaimText(
    "When did Jolene`s mother pass away?",
    [
      recallResult("17 March 2023", {
        subject_entity_id: "person:jolene",
        subject_name: "Jolene",
        metadata: {
          source_turn_text: "Jolene: My mother also passed away last year."
        }
      }, "2023-03-17T09:00:00.000Z")
    ]
  );

  assert.equal(claimText, "The best supported year is 2022.");
});

test("temporal derivation recovers muffin week windows from result-level source text without a source file", () => {
  const claimText = deriveTemporalClaimText(
    "When did Audrey make muffins for herself?",
    [
      recallResult("19 August 2023", {
        subject_entity_id: "person:audrey",
        subject_name: "Audrey",
        metadata: {
          source_turn_text: "I baked muffins just for myself last week."
        }
      }, "2023-04-10T12:00:00.000Z")
    ]
  );

  assert.match(claimText ?? "", /(?:week of April 3rd to 9th, 2023|3 April 2023)/i);
});

test("temporal support prefers metadata-only muffin source turns over conflicting derived day facts", () => {
  const rendered = renderTemporalEventSupport(
    "When did Audrey make muffins for herself?",
    buildTemporalEventSupport({
      queryText: "When did Audrey make muffins for herself?",
      storedCanonical: {
        kind: "temporal_fact",
        subjectEntityId: "person:audrey",
        canonicalSubjectName: "Audrey",
        subjectBindingStatus: "resolved",
        predicateFamily: "temporal_event_fact",
        supportStrength: "moderate",
        timeScopeKind: "event",
        confidence: "confident",
        objectValue: "19 August 2023",
        eventKey: "make_muffins_self",
        eventType: "activity",
        timeGranularity: "day",
        answerYear: 2023,
        answerMonth: 8,
        answerDay: 19,
        sourceTable: "canonical_temporal_facts",
        supportKind: "reference_derived_relative",
        temporalSourceQuality: "derived_relative",
        derivedFromReference: true
      },
      fallbackClaimText: null,
      results: [
        recallResult("19 August 2023", {
          subject_entity_id: "person:audrey",
          subject_name: "Audrey",
          query: "homemade blueberry muffin pastry",
          blip_caption: "a photo of a muffin pan filled with blueberries and muffins",
          metadata: {
            source_turn_text:
              "Audrey: Wow, sounds amazing! Glad you got to enjoy them. Since you metioned pastries, I made some of my favorite treats last week. Let's have a pastry party sometime!",
            query: "homemade blueberry muffin pastry",
            blip_caption: "a photo of a muffin pan filled with blueberries and muffins"
          }
        }, "2023-04-10T12:00:00.000Z")
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "resolved for test"
    }),
    1
  );

  assert.equal(rendered.renderContractSelected, "temporal_relative_day");
  assert.equal(rendered.claimText, "The week of April 3rd to 9th, 2023");
});

test("temporal support prefers anchored financial-analyst start cues over conflicting generic year facts", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-andrew-financial-analyst-"));
  const sourcePath = join(tempDir, "conv-44-session_1.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-03-27T13:10:00.000Z",
      "",
      "Andrew: I started a new job as a Financial Analyst last week - it's been quite a change."
    ].join("\n"),
    "utf8"
  );

  try {
    const rendered = renderTemporalEventSupport(
      "When did Andrew start his new job as a financial analyst?",
      buildTemporalEventSupport({
        queryText: "When did Andrew start his new job as a financial analyst?",
        storedCanonical: {
          kind: "temporal_fact",
          subjectEntityId: "person:andrew",
          canonicalSubjectName: "Andrew",
          subjectBindingStatus: "resolved",
          predicateFamily: "temporal_event_fact",
          supportStrength: "moderate",
          timeScopeKind: "event",
          confidence: "confident",
          objectValue: "2020",
          eventKey: "start_financial_analyst_job",
          eventType: "milestone",
          timeGranularity: "year",
          answerYear: 2020,
          answerMonth: null,
          answerDay: null,
          sourceTable: "canonical_temporal_facts",
          supportKind: "generic_time_fragment",
          temporalSourceQuality: "generic",
          derivedFromReference: false
        },
        fallbackClaimText: null,
        results: [
          recallResult(
            "Andrew: I started a new job as a Financial Analyst last week - it's been quite a change.",
            {
              subject_entity_id: "person:andrew",
              subject_name: "Andrew",
              source_uri: sourcePath,
              source_table: "canonical_temporal_facts",
              metadata: {
                source_table: "canonical_temporal_facts",
                source_turn_text: "Andrew: I started a new job as a Financial Analyst last week - it's been quite a change."
              }
            },
            "2023-03-20T00:00:00.000Z"
          )
        ],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "resolved for test"
      }),
      1
    );

    assert.equal(rendered.renderContractSelected, "temporal_relative_day");
    assert.equal(rendered.claimText, "The week before March 27, 2023");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support prefers metadata-only mother-last-year cues over derived day facts", () => {
  const rendered = renderTemporalEventSupport(
    "When did Jolene`s mother pass away?",
    buildTemporalEventSupport({
      queryText: "When did Jolene`s mother pass away?",
      storedCanonical: {
        kind: "temporal_fact",
        subjectEntityId: "person:jolene",
        canonicalSubjectName: "Jolene",
        subjectBindingStatus: "resolved",
        predicateFamily: "temporal_event_fact",
        supportStrength: "moderate",
        timeScopeKind: "event",
        confidence: "confident",
        objectValue: "17 March 2023",
        eventKey: "mother_pass_away",
        eventType: "loss",
        timeGranularity: "day",
        answerYear: 2023,
        answerMonth: 3,
        answerDay: 17,
        sourceTable: "canonical_temporal_facts",
        supportKind: "reference_derived_relative",
        temporalSourceQuality: "derived_relative",
        derivedFromReference: true
      },
      fallbackClaimText: null,
      results: [
        recallResult("17 March 2023", {
          subject_entity_id: "person:jolene",
          subject_name: "Jolene",
          metadata: {
            source_turn_text: "Jolene: My mother also passed away last year."
          }
        }, "2023-03-17T09:00:00.000Z")
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "resolved for test"
    }),
    1
  );

  assert.equal(rendered.renderContractSelected, "temporal_year");
  assert.equal(rendered.claimText, "2022");
});

test("temporal renderer keeps generic mother-pass-away queries at year granularity when relative provenance is stronger than the day", () => {
  const rendered = renderTemporalEventSupport(
    "When did Jolene`s mother pass away?",
    {
      supportObjectType: "TemporalEventSupport",
      eventKey: "mother_pass_away",
      eventType: "loss",
      timeGranularity: "day",
      answerYear: 2022,
      answerMonth: 3,
      answerDay: 17,
      relativeClaimText: null,
      relativeAnchorOnlyResolution: false,
      fallbackClaimText: "17 March 2023",
      subjectBindingStatus: "resolved",
      subjectBindingReason: "resolved for test",
      targetedRetrievalAttempted: true,
      targetedRetrievalReason: "temporal_fields_missing",
      targetedFieldsRequested: ["year"],
      targetedRetrievalSatisfied: true,
      temporalEventIdentityStatus: "resolved_from_query_backfill",
      temporalGranularityStatus: "resolved",
      relativeAnchorStatus: "resolved",
      selectedSupportKind: "reference_derived_relative",
      selectedTemporalSourceQuality: "derived_relative",
      selectedDerivedFromReference: true,
      explicitTemporalFactSatisfied: false,
      supportNormalizationFailures: []
    },
    1
  );

  assert.equal(rendered.renderContractSelected, "temporal_year");
  assert.equal(rendered.claimText, "2022");
});

test("temporal claim derivation resolves mother-pass-away relative labels from source capture time", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-mother-year-"));
  const sourcePath = join(tempDir, "conv-48-session_1.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-01-23T16:06:00.000Z",
      "",
      "Conversation between Deborah and Jolene",
      "Jolene: Sorry about your loss, Deb. My mother also passed away last year."
    ].join("\n")
  );
  try {
    const claimText = deriveTemporalClaimText(
      "When did Jolene`s mother pass away?",
      [
        recallResult("My mother also passed away last year.", {
          subject_name: "Jolene",
          speaker_name: "Jolene",
          source_uri: sourcePath,
          metadata: {
            source_turn_text: "Jolene: Sorry about your loss, Deb. My mother also passed away last year."
          }
        }, "2023-01-23T16:06:00.000Z")
      ]
    );

    assert.match(claimText ?? "", /2022/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support can recover anchored relative cues from structured source files", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-temporal-"));
  const sourcePath = join(tempDir, "source.md");
  writeFileSync(
    sourcePath,
    "---\nstarted_at: 2023-07-15T12:00:00.000Z\n---\nCaroline went to a pottery workshop the Friday before.\n",
    "utf8"
  );
  const structuredResult = recallResult(
    JSON.stringify({
      text: "24 August 2023",
      sourceUri: sourcePath
    })
  );
  structuredResult.occurredAt = "2023-07-15T12:00:00.000Z";

  try {
    const rendered = renderTemporalEventSupport(
      "When did Caroline go to a pottery workshop?",
      buildTemporalEventSupport({
        queryText: "When did Caroline go to a pottery workshop?",
        storedCanonical: {
          kind: "temporal_fact",
          subjectEntityId: "person:caroline",
          canonicalSubjectName: "Caroline",
          subjectBindingStatus: "resolved",
          predicateFamily: "temporal_event_fact",
          supportStrength: "strong",
          timeScopeKind: "historical",
          confidence: "confident",
          objectValue: "24 August 2023",
          eventKey: "pottery_workshop",
          eventType: "milestone",
          timeGranularity: "day",
          answerYear: 2023,
          answerMonth: 8,
          answerDay: 24,
          sourceTable: "canonical_temporal_facts",
          supportKind: "explicit_event_fact",
          temporalSourceQuality: "canonical_event"
        },
        fallbackClaimText: "The best supported date is 24 August 2023.",
        results: [structuredResult],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "Stored canonical subject matched the explicit named query anchor."
      }),
      1
    );

    assert.equal(rendered.renderContractSelected, "temporal_day");
    assert.equal(rendered.claimText, "24 August 2023");
    assert.equal(rendered.relativeAnchorStatus, "resolved");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support can render anchored relative cues even when the event day stays unresolved", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-temporal-camping-"));
  const sourcePath = join(tempDir, "melanie-camping-session_1.md");
  writeFileSync(
    sourcePath,
    "---\nstarted_at: 2023-07-17T12:00:00.000Z\n---\nMelanie went camping two weekends before.\n",
    "utf8"
  );
  const structuredResult = recallResult(
    JSON.stringify({
      text: "The best supported year is 2023.",
      sourceUri: sourcePath
    })
  );
  structuredResult.occurredAt = "2023-06-20T20:56:00.000Z";

  try {
    const rendered = renderTemporalEventSupport(
      "When did Melanie go camping in July?",
      buildTemporalEventSupport({
        queryText: "When did Melanie go camping in July?",
        storedCanonical: {
          kind: "temporal_fact",
          subjectEntityId: "person:melanie",
          canonicalSubjectName: "Melanie",
          subjectBindingStatus: "resolved",
          predicateFamily: "temporal_event_fact",
          supportStrength: "strong",
          timeScopeKind: "historical",
          confidence: "confident",
          objectValue: "The best supported year is 2023.",
          eventKey: "camping_july",
          timeGranularity: "unknown",
          answerYear: 2023
        },
        fallbackClaimText: "The best supported year is 2023.",
        results: [structuredResult],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "Stored canonical subject matched the explicit named query anchor."
      }),
      1
    );

    assert.equal(rendered.renderContractSelected, "temporal_relative_day");
    assert.equal(rendered.claimText, "Two weekends before 17 July 2023");
    assert.equal(rendered.relativeAnchorStatus, "resolved");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support prefers event-aligned relative cues over unrelated source-file cues", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-temporal-event-match-"));
  const sourcePath = join(tempDir, "caroline-mixed-session_1.md");
  writeFileSync(
    sourcePath,
    [
      "---",
      "started_at: 2023-07-15T12:00:00.000Z",
      "---",
      "Caroline joined a new activist group the Tuesday before.",
      "Caroline went to a pottery workshop the Friday before."
    ].join("\n"),
    "utf8"
  );
  const structuredResult = recallResult(
    JSON.stringify({
      text: "The Week before August 25, 2023",
      sourceUri: sourcePath
    })
  );
  structuredResult.occurredAt = "2023-07-15T12:00:00.000Z";

  try {
    const rendered = renderTemporalEventSupport(
      "When did Caroline go to a pottery workshop?",
      buildTemporalEventSupport({
        queryText: "When did Caroline go to a pottery workshop?",
        storedCanonical: {
          kind: "temporal_fact",
          subjectEntityId: "person:caroline",
          canonicalSubjectName: "Caroline",
          subjectBindingStatus: "resolved",
          predicateFamily: "temporal_event_fact",
          supportStrength: "strong",
          timeScopeKind: "historical",
          confidence: "confident",
          objectValue: "24 August 2023",
          eventKey: "pottery_workshop",
          eventType: "milestone",
          timeGranularity: "day",
          answerYear: 2023,
          answerMonth: 8,
          answerDay: 24,
          sourceTable: "canonical_temporal_facts",
          supportKind: "explicit_event_fact",
          temporalSourceQuality: "canonical_event"
        },
        fallbackClaimText: "The best supported date is 24 August 2023.",
        results: [structuredResult],
        subjectBindingStatus: "resolved",
        subjectBindingReason: "Stored canonical subject matched the explicit named query anchor."
      }),
      1
    );

    assert.equal(rendered.renderContractSelected, "temporal_day");
    assert.equal(rendered.claimText, "24 August 2023");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("temporal support renders month-year for generic when queries when day support is unavailable", () => {
  const rendered = renderTemporalEventSupport(
    "When is Jon's group performing at a festival?",
    {
      supportObjectType: "TemporalEventSupport",
      eventKey: "perform_festival",
      eventType: "milestone",
      timeGranularity: "month",
      answerYear: 2023,
      answerMonth: 2,
      answerDay: null,
      relativeClaimText: "Early 2022",
      fallbackClaimText: "Early 2022",
      subjectBindingStatus: "resolved",
      subjectBindingReason: "Primary name anchor Jon kept the subject plan single-subject.",
      targetedRetrievalAttempted: true,
      targetedRetrievalReason: "temporal_fields_missing",
      targetedFieldsRequested: ["month", "day"],
      targetedRetrievalSatisfied: false,
      temporalEventIdentityStatus: "resolved_from_aligned_candidate",
      temporalGranularityStatus: "missing_day",
      relativeAnchorStatus: "resolved",
      supportNormalizationFailures: []
    },
    1
  );

  assert.equal(rendered.claimText, "February 2023");
  assert.equal(rendered.renderContractSelected, "temporal_month_year");
});

test("temporal support prefers the earliest aligned event-neighborhood date for generic when queries", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-temporal-neighborhood-"));
  const sourcePath = join(dir, "conv-30-session_1.md");
  writeFileSync(
    sourcePath,
    "Captured: 2023-01-19T16:21:00.000Z\nJon: Finishing up choreography to perform at a nearby festival next month.\nJon: We also have another festival performance scheduled for Early May, 2023.\n"
  );
  try {
    const support = buildTemporalEventSupport({
      queryText: "When is Jon's group performing at a festival?",
      storedCanonical: null,
      fallbackClaimText: null,
      results: [
        recallResult("Jon mentioned the group schedule.", {
          subject_name: "Jon",
          subject_entity_id: "person:jon",
          source_uri: sourcePath
        })
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "Primary name anchor Jon kept the subject plan single-subject."
    });
    const rendered = renderTemporalEventSupport(
      "When is Jon's group performing at a festival?",
      support,
      1
    );

    assert.equal(support.answerYear, 2023);
    assert.equal(support.answerMonth, 2);
    assert.equal(rendered.claimText, "February 2023");
    assert.equal(rendered.renderContractSelected, "temporal_month_year");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal support prefers the earliest anchored relative claim when multiple scheduled event dates exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-temporal-relative-order-"));
  const sourcePath = join(dir, "conv-30-session_1.md");
  writeFileSync(
    sourcePath,
    "Captured: 2023-01-19T16:21:00.000Z\nJon: We also have another festival performance scheduled for Early May, 2023.\nJon: Finishing up choreography to perform at a nearby festival next month.\n"
  );
  try {
    const support = buildTemporalEventSupport({
      queryText: "When is Jon's group performing at a festival?",
      storedCanonical: null,
      fallbackClaimText: null,
      results: [
        recallResult("Jon mentioned the group schedule.", {
          subject_name: "Jon",
          subject_entity_id: "person:jon",
          source_uri: sourcePath
        })
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "Primary name anchor Jon kept the subject plan single-subject."
    });
    const rendered = renderTemporalEventSupport(
      "When is Jon's group performing at a festival?",
      support,
      1
    );

    assert.equal(support.relativeClaimText, "Early February, 2023");
    assert.equal(rendered.claimText, "February 2023");
    assert.equal(rendered.renderContractSelected, "temporal_month_year");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal support trusts subject-bound event neighborhoods even when the source sentence omits the subject name", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-temporal-subject-bound-festival-"));
  const sourcePath = join(dir, "conv-30-session_1.md");
  writeFileSync(
    sourcePath,
    "Captured: 2023-01-19T16:21:00.000Z\nFinishing up choreography to perform at a nearby festival next month.\nWe also have another festival performance scheduled for Early May, 2023.\n"
  );
  try {
    const support = buildTemporalEventSupport({
      queryText: "When is Jon's group performing at a festival?",
      storedCanonical: null,
      fallbackClaimText: null,
      results: [
        recallResult("Jon mentioned the group schedule.", {
          subject_name: "Jon",
          subject_entity_id: "person:jon",
          source_uri: sourcePath
        })
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "Primary name anchor Jon kept the subject plan single-subject."
    });
    const rendered = renderTemporalEventSupport(
      "When is Jon's group performing at a festival?",
      support,
      1
    );

    assert.equal(rendered.claimText, "February 2023");
    assert.equal(rendered.renderContractSelected, "temporal_month_year");
    assert.ok(
      ["resolved", "resolved_from_event_neighborhood"].includes(rendered.temporalEventIdentityStatus)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planner keeps concrete chef-advice questions in the exact-detail lane", () => {
  const planner = buildAnswerRetrievalPlan({
    queryText: "What advice did Calvin receive from the chef at the music festival?",
    predicateFamily: inferAnswerRetrievalPredicateFamily("What advice did Calvin receive from the chef at the music festival?", "generic_fact"),
    subjectBindingStatus: "resolved"
  });

  assert.equal(planner.family, "exact_detail");
  assert.equal(planner.lane, "exact_detail");
});

test("exact-detail derivation extracts pastry items from cafe detail questions", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What kind of pastries did Andrew and his girlfriend have at the cafe?",
    [
      recallResult("Andrew: At the cafe, my girlfriend and I had croissants, muffins, and tarts.", {
        subject_entity_id: "person:andrew",
        subject_name: "Andrew",
        primary_speaker_name: "Andrew",
        metadata: {
          subject_entity_id: "person:andrew",
          subject_name: "Andrew",
          primary_speaker_name: "Andrew",
          source_sentence_text: "Andrew: At the cafe, my girlfriend and I had croissants, muffins, and tarts."
        }
      })
    ],
    true
  );

  assert.match(derivation.candidate?.text ?? "", /croissants/i);
  assert.match(derivation.candidate?.text ?? "", /muffins/i);
  assert.match(derivation.candidate?.text ?? "", /tarts/i);
});

test("exact-detail derivation extracts owned-duration answers for how-long questions", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "How long has Nate had his first two turtles?",
    [
      recallResult("Nate: I've had them for 3 years now and they bring me tons of joy!", {
        subject_entity_id: "person:nate",
        subject_name: "Nate",
        primary_speaker_name: "Nate",
        metadata: {
          subject_entity_id: "person:nate",
          subject_name: "Nate",
          primary_speaker_name: "Nate",
          source_sentence_text: "Nate: I've had them for 3 years now and they bring me tons of joy!"
        }
      })
    ],
    true
  );

  assert.match(derivation.candidate?.text ?? "", /\b(?:3|three) years\b/i);
});

test("exact-detail derivation extracts duration answers from structured support snippets", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "How long has Nate had his first two turtles?",
    [
      recallResult(
        "{\"memoryType\":\"episodic_memory\",\"text\":\"3 years\",\"source_sentence_text\":\"Nate: I've had them for 3 years now and they bring me tons of joy!\"}",
        {
          subject_entity_id: "person:nate",
          subject_name: "Nate",
          primary_speaker_name: "Nate",
          metadata: {
            subject_entity_id: "person:nate",
            subject_name: "Nate",
            primary_speaker_name: "Nate"
          }
        }
      )
    ],
    true
  );

  assert.match(derivation.candidate?.text ?? "", /\b(?:3|three) years\b/i);
});

test("exact-detail derivation extracts endorsement-company answers from source-bound evidence", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "Which outdoor gear company likely signed up John for an endorsement deal?",
    [
      recallResult("John: Under Armour reached out about an endorsement deal after my season.", {
        subject_entity_id: "person:john",
        subject_name: "John",
        primary_speaker_name: "John",
        metadata: {
          subject_entity_id: "person:john",
          subject_name: "John",
          primary_speaker_name: "John",
          source_sentence_text: "John: Under Armour reached out about an endorsement deal after my season."
        }
      })
    ],
    true
  );

  assert.equal(derivation.candidate?.text, "Under Armour");
});

test("exact-detail derivation keeps the endorsement brand tied to the source cue when multiple brands appear", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "Which outdoor gear company likely signed up John for an endorsement deal?",
    [
      recallResult(
        "John: The Nike and Gatorade deals have me stoked. I've always liked Under Armour, and working with them after my season would be really cool.",
        {
          subject_entity_id: "person:john",
          subject_name: "John",
          primary_speaker_name: "John",
          metadata: {
            subject_entity_id: "person:john",
            subject_name: "John",
            primary_speaker_name: "John",
            source_turn_text:
              "John: The Nike and Gatorade deals have me stoked. I've always liked Under Armour, and working with them after my season would be really cool."
          }
        }
      )
    ],
    true
  );

  assert.equal(derivation.candidate?.text, "Under Armour");
});

test("exact-detail derivation extracts endorsement-company answers from structured support snippets", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "Which outdoor gear company likely signed up John for an endorsement deal?",
    [
      recallResult(
        "{\"memoryType\":\"episodic_memory\",\"text\":\"Under Armour\",\"source_sentence_text\":\"John: Under Armour reached out about an endorsement deal after my season.\"}",
        {
          subject_entity_id: "person:john",
          subject_name: "John",
          primary_speaker_name: "John",
          metadata: {
            subject_entity_id: "person:john",
            subject_name: "John",
            primary_speaker_name: "John"
          }
        }
      )
    ],
    true
  );

  assert.equal(derivation.candidate?.text, "Under Armour");
});

test("exact-detail derivation extracts stress-buster activities without requiring a doing-phrase", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What did Evan start doing a few years back as a stress-buster?",
    [
      recallResult("Evan: I started watercolor painting a few years back as a stress-buster.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan",
        primary_speaker_name: "Evan",
        metadata: {
          subject_entity_id: "person:evan",
          subject_name: "Evan",
          primary_speaker_name: "Evan",
          source_sentence_text: "Evan: I started watercolor painting a few years back as a stress-buster."
        }
      })
    ],
    true
  );

  assert.equal(derivation.candidate?.text, "watercolor painting");
});

test("exact-detail derivation extracts stress-buster activities from structured support snippets", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What did Evan start doing a few years back as a stress-buster?",
    [
      recallResult(
        "{\"memoryType\":\"episodic_memory\",\"text\":\"watercolor painting\",\"source_sentence_text\":\"Evan: I started watercolor painting a few years back as a stress-buster.\"}",
        {
          subject_entity_id: "person:evan",
          subject_name: "Evan",
          primary_speaker_name: "Evan",
          metadata: {
            subject_entity_id: "person:evan",
            subject_name: "Evan",
            primary_speaker_name: "Evan"
          }
        }
      )
    ],
    true
  );

  assert.equal(derivation.candidate?.text, "watercolor painting");
});

test("exact-detail derivation uses answerable-unit backfill metadata for owned-duration answers", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "How long has Nate had his first two turtles?",
    [],
    true,
    [
      {
        text: "3 years",
        sourceSentenceText: "Nate: I've had them for 3 years now and they bring me tons of joy!",
        sourceTurnText: null,
        metadata: {
          subject_entity_id: "person:nate",
          subject_name: "Nate",
          primary_speaker_name: "Nate"
        },
        exactDetailSource: "artifact_source",
        derivationType: "source_sentence",
        namespaceId: "ns_answer_backfill",
        artifactId: null,
        occurredAt: "2022-11-10T00:00:00.000Z",
        sourceUri: null
      }
    ]
  );

  assert.match(derivation.candidate?.text ?? "", /\b(?:3|three) years\b/i);
});

test("exact-detail derivation uses answerable-unit backfill metadata for endorsement companies", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "Which outdoor gear company likely signed up John for an endorsement deal?",
    [],
    true,
    [
      {
        text: "Under Armour",
        sourceSentenceText: "John: Under Armour reached out about an endorsement deal after my season.",
        sourceTurnText: null,
        metadata: {
          subject_entity_id: "person:john",
          subject_name: "John",
          primary_speaker_name: "John"
        },
        exactDetailSource: "artifact_source",
        derivationType: "source_sentence",
        namespaceId: "ns_answer_backfill",
        artifactId: null,
        occurredAt: "2024-01-08T00:24:00.000Z",
        sourceUri: null
      }
    ]
  );

  assert.equal(derivation.candidate?.text, "Under Armour");
});

test("exact-detail derivation uses answerable-unit backfill metadata for stress-buster activities", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What did Evan start doing a few years back as a stress-buster?",
    [],
    true,
    [
      {
        text: "watercolor painting",
        sourceSentenceText: "Evan: I started watercolor painting a few years back as a stress-buster.",
        sourceTurnText: null,
        metadata: {
          subject_entity_id: "person:evan",
          subject_name: "Evan",
          primary_speaker_name: "Evan"
        },
        exactDetailSource: "artifact_source",
        derivationType: "source_sentence",
        namespaceId: "ns_answer_backfill",
        artifactId: null,
        occurredAt: "2023-06-01T00:00:00.000Z",
        sourceUri: null
      }
    ]
  );

  assert.equal(derivation.candidate?.text, "watercolor painting");
});

test("exact-detail derivation resolves observation-backed stress-buster pronoun references", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What did Evan start doing a few years back as a stress-buster?",
    [
      recallResult("Yep, it's a great stress-buster. I started doing this a few years back.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan",
        primary_speaker_name: "Evan",
        query: "watercolor painting sunset",
        blip_caption: "a photo of a painting of a cactus in the desert",
        metadata: {
          source_turn_text: "Evan: Yep, it's a great stress-buster. I started doing this a few years back.",
          query: "watercolor painting sunset",
          blip_caption: "a photo of a painting of a cactus in the desert"
        }
      })
    ],
    true
  );

  assert.equal(derivation.candidate?.text, "watercolor painting");
});

test("exact-detail derivation enriches generic painting starts with richer watercolor evidence from the same speaker", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What did Evan start doing a few years back as a stress-buster?",
    [
      recallResult("Evan: Painting is a great way to relieve stress and be creative. I've been doing it for a few years now.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan",
        speaker_name: "Evan",
        metadata: {
          source_sentence_text:
            "Evan: Painting is a great way to relieve stress and be creative. I've been doing it for a few years now."
        }
      }),
      recallResult("Evan: I do my favorite watercolor painting to keep me busy. It's a chill way to relax.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan",
        speaker_name: "Evan",
        metadata: {
          source_sentence_text: "Evan: I do my favorite watercolor painting to keep me busy. It's a chill way to relax."
        }
      })
    ],
    true
  );

  assert.equal(derivation.candidate?.text, "watercolor painting");
});

test("generic stress-buster painting answers are marked for subtype rescue", () => {
  assert.equal(
    exactDetailCandidateNeedsSubtypeRescue(
      "What did Evan start doing a few years back as a stress-buster?",
      {
        text: "painting",
        source: "artifact_source",
        strongSupport: true
      }
    ),
    true
  );
  assert.equal(
    exactDetailCandidateNeedsSubtypeRescue(
      "What did Evan start doing a few years back as a stress-buster?",
      {
        text: "watercolor painting",
        source: "artifact_source",
        strongSupport: true
      }
    ),
    false
  );
});

test("exact-detail derivation upgrades pronoun stress-buster turns from linked source-session evidence", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "habit-start-linked-source-"));
  const sourcePath = join(tempDir, "conv-49-session_1.md");
  writeFileSync(
    sourcePath,
    `Conversation between Evan and Sam
Sam: Nothing so far, but I was thinking about trying painting. Do you have any hobbies you love?
Evan: Yep, it's a great stress-buster. I started doing this a few years back. [image: a photo of a painting of a cactus in the desert]
--- image_query: watercolor painting sunset
--- image_caption: a photo of a painting of a cactus in the desert
Sam: Wow, that's impressive! How did you get into watercolor painting?
Evan: My friend got me into it and gave me some advice, and I was hooked right away!`,
    "utf8"
  );

  try {
    const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
      "What did Evan start doing a few years back as a stress-buster?",
      [
        {
          ...recallResult(
            "Evan: Yep, it's a great stress-buster. I started doing this a few years back. [image: a photo of a painting of a cactus in the desert]",
            {
              tier: "answerable_unit",
              artifact_observation_id: "obs:session1",
              source_chunk_id: "chunk:session1",
              metadata: {
                speaker_name: "Evan",
                source_metadata: {
                  session_key: "session_1"
                }
              }
            },
            "2023-05-18T13:47:00.000Z"
          ),
          artifactId: "artifact:session1"
        },
        {
          ...recallResult(
            "Do you have any hobbies you love? Evan: Cool idea, Sam! I love it.",
            {
              tier: "derivation_source_support",
              source_uri: sourcePath
            },
            "2023-05-18T13:47:00.000Z"
          ),
          artifactId: "artifact:session1"
        }
      ],
      true
    );

    assert.equal(derivation.candidate?.text, "watercolor painting");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("exact-detail derivation does not admit bare activities for stress-buster queries without start or stress cues", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What did Sam start doing a few years back as a stress-buster?",
    [
      recallResult("Sam: Yoga keeps me limber every weekend.", {
        subject_entity_id: "person:sam",
        subject_name: "Sam",
        speaker_name: "Sam",
        metadata: {
          source_sentence_text: "Sam: Yoga keeps me limber every weekend."
        }
      })
    ],
    true
  );

  assert.equal(derivation.candidate, null);
});

test("exact-detail derivation keeps stress-buster answers speaker-scoped when another speaker has the completed habit", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What did Sam start doing a few years back as a stress-buster?",
    [
      recallResult("Sam: I've been thinking about trying painting. Do you think it will help me de-stress?", {
        subject_entity_id: "person:sam",
        subject_name: "Sam",
        speaker_name: "Sam",
        metadata: {
          source_sentence_text:
            "Sam: I've been thinking about trying painting. Do you think it will help me de-stress?"
        }
      }),
      recallResult("Evan: I started watercolor painting a few years back as a stress-buster.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan",
        speaker_name: "Evan",
        metadata: {
          source_sentence_text: "Evan: I started watercolor painting a few years back as a stress-buster."
        }
      })
    ],
    true
  );

  assert.equal(derivation.candidate, null);
});

test("exact-detail derivation does not treat admired watercolor hobbies as completed self-owned stress-busters", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What did Sam start doing a few years back as a stress-buster?",
    [
      recallResult("Sam: Wow! I hope I can find something I'm as passionate about as you are with watercolor painting.", {
        subject_entity_id: "person:sam",
        subject_name: "Sam",
        speaker_name: "Sam",
        metadata: {
          source_sentence_text:
            "Sam: Wow! I hope I can find something I'm as passionate about as you are with watercolor painting."
        }
      }),
      recallResult("Sam: Wow, that's impressive! How did you get into watercolor painting?", {
        subject_entity_id: "person:sam",
        subject_name: "Sam",
        speaker_name: "Sam",
        metadata: {
          source_sentence_text: "Sam: Wow, that's impressive! How did you get into watercolor painting?"
        }
      }),
      recallResult("Sam: Thanks, Evan. I've been thinking about trying painting. Do you think it will help me de-stress?", {
        subject_entity_id: "person:sam",
        subject_name: "Sam",
        speaker_name: "Sam",
        metadata: {
          source_sentence_text:
            "Sam: Thanks, Evan. I've been thinking about trying painting. Do you think it will help me de-stress?"
        }
      }),
      recallResult("Evan: I started watercolor painting a few years back as a stress-buster.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan",
        speaker_name: "Evan",
        metadata: {
          source_sentence_text: "Evan: I started watercolor painting a few years back as a stress-buster."
        }
      })
    ],
    true
  );

  assert.equal(derivation.candidate, null);
});

test("exact-detail derivation does not promote prospective stress-buster activities into completed habits", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What did Sam start doing a few years back as a stress-buster?",
    [
      recallResult(
        "Sam: Thanks, Evan. Like you said, I've been looking for a hobby to stay motivated. I've been thinking about trying painting. Do you think it will help me de-stress?",
        {
          subject_entity_id: "person:sam",
          subject_name: "Sam",
          speaker_name: "Sam",
          metadata: {
            source_sentence_text:
              "Sam: Thanks, Evan. Like you said, I've been looking for a hobby to stay motivated. I've been thinking about trying painting. Do you think it will help me de-stress?"
          }
        }
      )
    ],
    true
  );

  assert.equal(derivation.candidate, null);
});

test("exact-detail derivation does not treat speaker-bound conversation questions as completed stress-buster starts", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What did Sam start doing a few years back as a stress-buster?",
    [
      recallResult(
        `Conversation between Evan and Sam
Sam: Nothing so far, but I was thinking about trying painting. Do you have any hobbies you love?
Evan: Cool idea, Sam! I love it. Have you tried it before?
Sam: Not yet, but I'm keen to give it a go. It looks like a nice way to chill and get creative.
Evan: Yep, it's a great stress-buster. I started doing this a few years back.
Sam: Wow, that's impressive! How did you get into watercolor painting?
Evan: My friend got me into it and gave me some advice, and I was hooked right away!
Sam: Wow! I hope I can find something I'm as passionate about as you are with watercolor painting.`,
        {
          subject_entity_id: "person:sam",
          subject_name: "Sam",
          speaker_name: "Sam",
          metadata: {
            source_sentence_text: "Sam: Wow, that's impressive! How did you get into watercolor painting?"
          }
        }
      )
    ],
    true
  );

  assert.equal(derivation.candidate, null);
});

test("duality keeps habit-start exact detail on the strict owned-support lane", () => {
  const results = [
    recallResult(
      "Sam: Wow! I hope I can find something I'm as passionate about as you are with watercolor painting.",
      {
        subject_entity_id: "person:sam",
        subject_name: "Sam",
        speaker_name: "Sam",
        metadata: {
          source_sentence_text:
            "Sam: Wow! I hope I can find something I'm as passionate about as you are with watercolor painting."
        }
      }
    ),
    recallResult(
      "Sam: Thanks, Evan. Like you said, I've been looking for a hobby to stay motivated. I've been thinking about trying painting. Do you think it will help me de-stress?",
      {
        subject_entity_id: "person:sam",
        subject_name: "Sam",
        speaker_name: "Sam",
        metadata: {
          source_sentence_text:
            "Sam: Thanks, Evan. Like you said, I've been looking for a hobby to stay motivated. I've been thinking about trying painting. Do you think it will help me de-stress?"
        }
      }
    ),
    recallResult("Evan: I started watercolor painting a few years back as a stress-buster.", {
      subject_entity_id: "person:evan",
      subject_name: "Evan",
      speaker_name: "Evan",
      metadata: {
        source_sentence_text: "Evan: I started watercolor painting a few years back as a stress-buster."
      }
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "confident",
      reason: "test",
      lexicalCoverage: 1,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: true,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["sam"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "test",
    "What did Sam start doing a few years back as a stress-buster?"
  );

  assert.equal(duality.claim.text, "None.");
});

test("exact-detail derivation uses source-turn text when sentence text is unavailable", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "Which outdoor gear company likely signed up John for an endorsement deal?",
    [
      recallResult("John mentioned a post-season brand opportunity.", {
        subject_entity_id: "person:john",
        subject_name: "John",
        primary_speaker_name: "John",
        metadata: {
          subject_entity_id: "person:john",
          subject_name: "John",
          primary_speaker_name: "John",
          source_turn_text: "John: Under Armour reached out about an endorsement deal after my season."
        }
      })
    ],
    true
  );

  assert.equal(derivation.candidate?.text, "Under Armour");
});

test("exact-detail derivation abstains when favorite-memory queries only have preference-style evidence", () => {
  const derivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What was Jon's favorite dancing memory?",
    [
      recallResult("Jon: My favorite style of dance is contemporary.", {
        subject_entity_id: "person:jon",
        subject_name: "Jon",
        primary_speaker_name: "Jon",
        metadata: {
          subject_entity_id: "person:jon",
          subject_name: "Jon",
          primary_speaker_name: "Jon",
          source_sentence_text: "Jon: My favorite style of dance is contemporary."
        }
      })
    ],
    true
  );

  assert.equal(derivation.candidate, null);
});

test("temporal support does not treat provenance timestamps as answer dates when relative evidence exists", () => {
  const rendered = renderTemporalEventSupport(
    "When is Jon's group performing at a festival?",
    buildTemporalEventSupport({
      queryText: "When is Jon's group performing at a festival?",
      storedCanonical: {
        kind: "temporal_fact",
        subjectEntityId: "person:jon",
        canonicalSubjectName: "Jon",
        subjectBindingStatus: "resolved",
        predicateFamily: "temporal_event_fact",
        supportStrength: "strong",
        timeScopeKind: "future",
        confidence: "confident",
        objectValue: "Festival timing still being finalized.",
        eventKey: "perform_festival",
        timeGranularity: "unknown",
        answerYear: 2023
      },
      fallbackClaimText: "Festival timing still being finalized.",
      results: [
        {
          memoryId: "jon-festival-relative",
          memoryType: "episodic_memory",
          content: "Jon: Finishing up choreography to perform at a nearby festival next month.",
          artifactId: "artifact-jon-festival-relative",
          occurredAt: "2023-04-03T13:26:00.000Z",
          namespaceId: "test",
          provenance: {
            occurredAt: "2023-01-20T00:00:00.000Z",
            source_uri: null,
            subject_entity_id: "person:jon",
            subject_name: "Jon",
            metadata: {
              source_turn_text: "Jon: Finishing up choreography to perform at a nearby festival next month."
            }
          }
        }
      ],
      subjectBindingStatus: "resolved",
      subjectBindingReason: "Primary name anchor Jon kept the subject plan single-subject."
    }),
    1
  );

  assert.equal(rendered.claimText, "May 2023");
  assert.equal(rendered.renderContractSelected, "temporal_month_year");
});

test("list/set answers expose typed-entry shaping traces", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "Which country did Calvin and Dave plan to meet in?",
    results: [
      recallResult("Calvin and Dave planned to meet in Japan.", {
        subject_entity_id: "person:calvin",
        subject_name: "Calvin"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Calvin", "Dave"] }),
    exactDetailFamily: "country",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      placeShopCountry: "Japan"
    },
    storedCanonical: {
      kind: "set",
      subjectEntityId: "person:calvin",
      canonicalSubjectName: "Calvin",
      subjectBindingStatus: "resolved",
      predicateFamily: "list_set",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValues: ["The Fireworks, Tokyo, and Japan"],
      typedSetEntryValues: ["Japan"],
      typedSetEntryType: "country",
      sourceTable: "canonical_sets"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_list_set");
  assert.equal(adjudicated.formatted.claimText, "Japan");
  assert.equal(adjudicated.formatted.shapingTrace?.shapingMode, "typed_set_entries");
  assert.equal(adjudicated.formatted.shapingTrace?.typedSetEntryCount, 1);
  assert.equal(adjudicated.formatted.shapingTrace?.typedSetEntryType, "country");
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectType, "ListSetSupport");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "location_list_render");
});

test("profile support renders venue-fit questions as yes-because judgments", () => {
  const support = buildProfileInferenceSupport({
    queryText: "Would Calvin enjoy performing at the Hollywood Bowl?",
    reportKind: "profile_report",
    fallbackSummary: "he enjoys the rush of performing onstage to large crowds",
    answerPayload: null,
    runtimeClaimText: null,
    results: [
      recallResult("Calvin loves the rush of performing onstage to large crowds.", {
        subject_name: "Calvin"
      })
    ]
  });
  const rendered = renderProfileInferenceSupport("Would Calvin enjoy performing at the Hollywood Bowl?", support);

  assert.equal(rendered.renderContractSelected, "comparative_fit_render");
  assert.equal(rendered.claimText, "Yes, because he enjoys the rush of performing onstage to large crowds.");
});

test("profile support maps crowd-connection performance language into comparative-fit reasons", () => {
  const support = buildProfileInferenceSupport({
    queryText: "Would Calvin enjoy performing at the Hollywood Bowl?",
    reportKind: "profile_report",
    fallbackSummary: null,
    answerPayload: null,
    runtimeClaimText: null,
    results: [
      recallResult(
        "Performing live always fuels my soul! I love the rush and connection with the crowd, the feeling's indescribable—it's an absolute high!",
        {
          subject_name: "Calvin"
        }
      )
    ]
  });
  const rendered = renderProfileInferenceSupport("Would Calvin enjoy performing at the Hollywood Bowl?", support);

  assert.equal(rendered.renderContractSelected, "comparative_fit_render");
  assert.equal(rendered.claimText, "Yes, because he enjoys the rush of performing onstage to large crowds.");
});

test("book-list answers infer typed titles from live support text", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What books has Melanie read?",
    results: [
      recallResult("Melanie read Nothing is Impossible and Charlotte's Web.", {
        source_uri: "/tmp/conv-26-session_12.md"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Melanie"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      hobbies: "\"Nothing is Impossible\", \"Charlotte's Web\""
    },
    storedCanonical: {
      kind: "set",
      subjectEntityId: null,
      canonicalSubjectName: null,
      subjectBindingStatus: "unresolved",
      predicateFamily: "list_set",
      supportStrength: "moderate",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValues: ["Nothing is Impossible", "Charlotte's Web"],
      sourceTable: "canonical_sets"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_list_set");
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectType, "ListSetSupport");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "book_list_render");
  assert.equal(adjudicated.formatted.shapingTrace?.typedSetEntryType, "book_title");
  assert.equal(adjudicated.formatted.shapingTrace?.typedSetEntryCount, 2);
});

test("book-list support can recover typed titles from source-backed artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-book-source-"));
  const sourcePath = join(dir, "conv-26-session_2.md");
  writeFileSync(
    sourcePath,
    'Captured: 2023-07-05T00:00:00.000Z\nMelanie said she read "Nothing is Impossible" and later mentioned "Charlotte\'s Web".\n'
  );
  try {
    const support = buildListSetSupport({
      queryText: "What books has Melanie read?",
      predicateFamily: "list_set",
      finalClaimText: null,
      subjectPlan: {
        kind: "single_subject",
        subjectEntityId: null,
        canonicalSubjectName: "Melanie",
        candidateEntityIds: [],
        candidateNames: ["Melanie"],
        reason: "test"
      },
      results: [
        recallResult("No authoritative book list found.", {
          subject_name: "Melanie",
          source_uri: sourcePath
        })
      ]
    });
    const rendered = renderListSetSupport(support, 1);

    assert.deepEqual(support.typedEntries, ["Nothing is Impossible", "Charlotte's Web"]);
    assert.equal(rendered.renderContractSelected, "book_list_render");
    assert.equal(rendered.claimText, "\"Nothing is Impossible\", \"Charlotte's Web\"");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("book-list support can recover typed titles from metadata-only cues", () => {
  const support = buildListSetSupport({
    queryText: "What books has Melanie read?",
    predicateFamily: "list_set",
    results: [
      recallResult("No direct titles normalized.", {
        subject_name: "Melanie",
        metadata: {
          leaf_fact_text: "Melanie read The Great Gatsby and To Kill a Mockingbird."
        }
      })
    ],
    finalClaimText: null,
    subjectPlan: {
      kind: "single_subject",
      subjectEntityId: "person:melanie",
      canonicalSubjectName: "Melanie",
      candidateEntityIds: ["person:melanie"],
      candidateNames: ["Melanie"],
      reason: "test_subject"
    }
  });

  assert.deepEqual(support.typedEntries, ["The Great Gatsby", "To Kill a Mockingbird"]);
  assert.equal(support.typedEntryType, "book_title");
});

test("child-support event lists infer typed event entries from support text", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What events has Caroline participated in to help children?",
    results: [
      recallResult("Caroline participated in a school speech and a mentoring program to help children.", {
        source_uri: "/tmp/conv-26-session_11.md"
      }),
      recallResult("Caroline also attended a support group.", {
        source_uri: "/tmp/conv-26-session_10.md"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      genericEnumerative: "school speech, mentoring program, support group"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_list_set");
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectType, "ListSetSupport");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "event_list_render");
  assert.equal(adjudicated.formatted.shapingTrace?.typedSetEntryType, "event_name");
  assert.equal(adjudicated.formatted.shapingTrace?.typedSetEntryCount, 2);
  assert.match(adjudicated.formatted.claimText ?? "", /school speech/i);
  assert.match(adjudicated.formatted.claimText ?? "", /mentoring program/i);
  assert.doesNotMatch(adjudicated.formatted.claimText ?? "", /support group/i);
});

test("support-network list answers infer typed contacts for friends-besides queries", () => {
  const support = buildListSetSupport({
    queryText: "Is it likely that Nate has friends besides Joanna?",
    predicateFamily: "list_set",
    results: [
      recallResult("Definitely! And some old friends and teamates from other tournaments.", {
        subject_name: "Nate",
        speaker_name: "Nate"
      }),
      recallResult("The game was called Counter-Strike: Global Offensive, and me and my team had a blast to the very end!", {
        subject_name: "Nate",
        speaker_name: "Nate"
      })
    ],
    storedCanonical: null,
    finalClaimText: null,
    subjectPlan: {
      kind: "single_subject",
      subjectEntityId: null,
      canonicalSubjectName: "Nate",
      candidateEntityIds: [],
      candidateNames: ["Nate"],
      reason: "explicit_subject"
    }
  });
  const rendered = renderListSetSupport(support, 2);

  assert.equal(support.typedEntryType, "support_contact");
  assert.ok(support.typedEntries.includes("teammates on his video game team"));
  assert.equal(rendered.renderContractSelected, "support_network_render");
  assert.match(rendered.claimText ?? "", /^Yes, /);
  assert.match(rendered.claimText ?? "", /teammates on his video game team/i);
  assert.doesNotMatch(rendered.claimText ?? "", /old friends from other tournaments/i);
});

test("exact-detail answers expose direct-detail support-object shaping traces", () => {
  const support = buildDirectDetailSupport({
    finalClaimText: "home for these kids",
    exactDetailCandidate: {
      text: "Nothing Is Impossible",
      source: "mixed",
      strongSupport: true
    }
  });
  const rendered = renderDirectDetailSupport(support, 1);

  assert.equal(rendered.claimText, "Nothing Is Impossible");
  assert.equal(rendered.supportObjectType, "DirectDetailSupport");
  assert.equal(rendered.renderContractSelected, "exact_support_span");
  assert.equal(rendered.exactDetailSource, "mixed");
});

test("canonical exact-detail winners enter direct-detail shaping even with strong stored canonical facts", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "How long did it take for Jon to open his studio?",
    results: [
      recallResult("It took Jon six months to open his studio.", {
        subject_entity_id: "person:jon",
        subject_name: "Jon"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jon"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      residualExact: "six months"
    },
    storedCanonical: {
      kind: "fact",
      subjectEntityId: "person:jon",
      canonicalSubjectName: "Jon",
      subjectBindingStatus: "resolved",
      predicateFamily: "generic_fact",
      supportStrength: "strong",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValue: "six months",
      sourceTable: "canonical_facts"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_exact_detail");
  assert.equal(adjudicated.formatted.claimText, "six months");
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectType, "DirectDetailSupport");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "exact_canonical_value");
  assert.equal(adjudicated.formatted.shapingTrace?.shapingPipelineEntered, true);
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectAttempted, true);
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractAttempted, true);
  assert.equal(adjudicated.formatted.shapingTrace?.bypassReason, null);
});

test("support-backed exact-detail families promote residual derived values into support-span rendering", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "How long has Nate had his first two turtles?",
    results: [
      recallResult("Nate: I've had them for 3 years now and they bring me tons of joy!", {
        subject_entity_id: "person:nate",
        subject_name: "Nate"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Nate"] }),
    exactDetailFamily: "duration",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      residualExact: "3 years"
    },
    storedCanonical: {
      kind: "fact",
      subjectEntityId: "person:nate",
      canonicalSubjectName: "Nate",
      subjectBindingStatus: "resolved",
      predicateFamily: "generic_fact",
      supportStrength: "strong",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValue: "3 years",
      sourceTable: "canonical_facts"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.claimText, "3 years");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_exact_detail");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "exact_support_span");
  assert.equal(adjudicated.formatted.shapingTrace?.typedValueUsed, true);
  assert.equal(adjudicated.formatted.shapingTrace?.supportTextsSelected, 1);
});

test("support-backed exact-detail families prefer structured support candidates over weaker stored canonical values", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "Which outdoor gear company likely signed up John for an endorsement deal?",
    results: [
      recallResult("John: Under Armour reached out about an endorsement deal after my season.", {
        subject_entity_id: "person:john",
        subject_name: "John",
        primary_speaker_name: "John",
        metadata: {
          subject_entity_id: "person:john",
          subject_name: "John",
          primary_speaker_name: "John",
          source_sentence_text: "John: Under Armour reached out about an endorsement deal after my season."
        }
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    exactDetailFamily: "endorsement_company",
    exactDetailCandidateText: "Under Armour",
    exactDetailCandidateStrongSupport: false,
    exactDetailCandidatePredicateFit: true,
    abstentionClaimText: "Unknown.",
    derived: {
      residualExact: "Nike"
    },
    storedCanonical: {
      kind: "fact",
      subjectEntityId: "person:john",
      canonicalSubjectName: "John",
      subjectBindingStatus: "resolved",
      predicateFamily: "generic_fact",
      supportStrength: "strong",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValue: "Nike",
      sourceTable: "canonical_facts"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.claimText, "Under Armour");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_exact_detail");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "exact_support_span");
  assert.equal(adjudicated.formatted.shapingTrace?.typedValueUsed, true);
  assert.equal(adjudicated.formatted.shapingTrace?.supportTextsSelected, 1);
});

test("generic report families enter normalization instead of bypassing into stored report summaries", () => {
  const decision = adjudicateNarrativeClaim({
    queryText: "What kind of art does Caroline make?",
    exactDetailFamily: "generic",
    results: [recallResult("Caroline's art explores her trans experience.", { subject_name: "Caroline" })],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValue:
        "{\"memoryId\":\"x\",\"memoryType\":\"episodic_memory\",\"text\":\"abstract art exploring her trans experience\",\"occurredAt\":\"2023-01-01T00:00:00.000Z\"}",
      reportKind: "creative_work_report",
      candidateCount: 2,
      sourceTable: "assembled_graph_entity_report"
    }
  });

  assert.ok(decision.candidate);
  assert.equal(decision.candidate.formatted.claimText, "abstract art exploring her trans experience");
  assert.equal(decision.candidate.formatted.shapingTrace?.shapingPipelineEntered, true);
  assert.equal(decision.candidate.formatted.shapingTrace?.supportObjectAttempted, true);
  assert.equal(decision.candidate.formatted.shapingTrace?.renderContractAttempted, true);
  assert.equal(decision.candidate.formatted.shapingTrace?.supportObjectType, "ProfileInferenceSupport");
  assert.equal(decision.candidate.formatted.shapingTrace?.renderContractSelected, "report_scalar_value");
  assert.equal(decision.candidate.formatted.shapingTrace?.bypassReason, null);
});

test("generic report families can use the binary preference choice contract", () => {
  const decision = adjudicateNarrativeClaim({
    queryText: "Would Melanie be more interested in going to a national park or a theme park?",
    exactDetailFamily: "generic",
    results: [recallResult("Melanie loves the outdoors and hiking.", { subject_name: "Melanie" })],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Melanie"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:melanie",
      canonicalSubjectName: "Melanie",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValue: "National park; she likes the outdoors",
      reportKind: "travel_report",
      candidateCount: 2,
      sourceTable: "retrieved_text_unit_report"
    }
  });

  assert.ok(decision.candidate);
  assert.equal(decision.candidate.formatted.claimText, "national park");
  assert.equal(decision.candidate.formatted.shapingTrace?.supportObjectType, "PreferenceChoiceSupport");
  assert.equal(decision.candidate.formatted.shapingTrace?.renderContractSelected, "binary_preference_choice");
  assert.equal(decision.candidate.formatted.shapingTrace?.bypassReason, null);
});

test("preference choice support can resolve from normalized support texts when the fallback summary is noisy", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "profile_report",
    queryText: "Would Melanie be more interested in going to a national park or a theme park?",
    fallbackSummary:
      "{\"memoryId\":\"x\",\"memoryType\":\"episodic_memory\",\"text\":\"Conversation unit between Melanie and Caroline.\",\"occurredAt\":\"2023-01-01T00:00:00.000Z\"}",
    answerPayload: null,
    results: [recallResult("Melanie loves the outdoors and hiking.", { subject_name: "Melanie" })]
  });
  const rendered = renderPreferenceChoiceSupport(
    buildPreferenceChoiceSupport({
      queryText: "Would Melanie be more interested in going to a national park or a theme park?",
      support
    })
  );

  assert.equal(rendered.claimText, "national park");
  assert.equal(rendered.supportObjectType, "PreferenceChoiceSupport");
  assert.equal(rendered.renderContractSelected, "binary_preference_choice");
});

test("generic report families can use the career likelihood contract", () => {
  const decision = adjudicateNarrativeClaim({
    queryText: "Would Caroline pursue writing as a career option?",
    exactDetailFamily: "generic",
    results: [recallResult("Caroline would likely stay focused on counseling and mental health support.", { subject_name: "Caroline" })],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValue: "Likely no",
      reportKind: "aspiration_report",
      candidateCount: 2,
      sourceTable: "retrieved_text_unit_report"
    }
  });

  assert.ok(decision.candidate);
  assert.equal(decision.candidate.formatted.claimText, "Likely no.");
  assert.equal(decision.candidate.formatted.shapingTrace?.supportObjectType, "CounterfactualCareerSupport");
  assert.equal(decision.candidate.formatted.shapingTrace?.renderContractSelected, "career_likelihood_judgment");
  assert.equal(decision.candidate.formatted.shapingTrace?.bypassReason, null);
});

test("generic profile reports enter support normalization instead of falling back to stored report summary", () => {
  const decision = adjudicateNarrativeClaim({
    queryText: "Would Melanie be more interested in going to a national park or a theme park?",
    exactDetailFamily: "generic",
    results: [recallResult("Melanie loves the outdoors and hiking.", { subject_name: "Melanie" })],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Melanie"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:melanie",
      canonicalSubjectName: "Melanie",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValue: "National park; she likes the outdoors",
      reportKind: "profile_report",
      candidateCount: 2,
      sourceTable: "assembled_graph_entity_report"
    }
  });

  assert.ok(decision.candidate);
  assert.equal(decision.candidate.formatted.claimText, "national park");
  assert.equal(decision.candidate.formatted.shapingTrace?.supportObjectType, "PreferenceChoiceSupport");
  assert.equal(decision.candidate.formatted.shapingTrace?.renderContractSelected, "binary_preference_choice");
  assert.equal(decision.candidate.formatted.shapingTrace?.shapingPipelineEntered, true);
  assert.equal(decision.candidate.formatted.shapingTrace?.supportObjectAttempted, true);
  assert.equal(decision.candidate.formatted.shapingTrace?.renderContractAttempted, true);
  assert.equal(decision.candidate.formatted.shapingTrace?.bypassReason, null);
});

test("report winners reuse canonical report shaping traces when narrative adjudication is absent", () => {
  const canonical = adjudicateCanonicalClaim({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    results: [
      recallResult("Caroline collects classic children's books.", {
        subject_entity_id: "person:caroline",
        subject_name: "Caroline"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({
      confidence: "missing",
      sufficiency: "contradicted",
      subjectMatch: "mismatched",
      matchedParticipants: ["Caroline"]
    }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      profile: "Yes, since she collects classic children's books"
    },
    storedCanonical: {
      kind: "state",
      subjectEntityId: null,
      canonicalSubjectName: null,
      subjectBindingStatus: "ambiguous",
      predicateFamily: "profile_state",
      supportStrength: "weak",
      timeScopeKind: "historical",
      confidence: "weak",
      objectValue: "Yes, since she collects classic children's books",
      sourceTable: "canonical_states"
    }
  });

  const trace = resolveAnswerShapingTrace({
    family: "report",
    winner: "canonical_report",
    canonicalAdjudication: canonical,
    narrativeAdjudication: null,
    exactDetailCandidate: null,
    supportRowsSelected: 1,
    claimText: canonical?.formatted.claimText ?? null
  });

  assert.equal(trace.supportObjectType, "CollectionInferenceSupport");
  assert.equal(trace.renderContractSelected, "collection_yes_since_collects");
  assert.equal(trace.bypassReason, null);
});

test("report winners prefer canonical report shaping traces over narrative abstention traces", () => {
  const canonical = adjudicateCanonicalClaim({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    results: [
      recallResult("Caroline collects classic children's books.", {
        subject_entity_id: "person:caroline",
        subject_name: "Caroline"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({
      confidence: "missing",
      sufficiency: "contradicted",
      subjectMatch: "mismatched",
      matchedParticipants: ["Caroline"]
    }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      profile: "Yes, since she collects classic children's books"
    },
    storedCanonical: {
      kind: "state",
      subjectEntityId: null,
      canonicalSubjectName: null,
      subjectBindingStatus: "ambiguous",
      predicateFamily: "profile_state",
      supportStrength: "weak",
      timeScopeKind: "historical",
      confidence: "weak",
      objectValue: "Yes, since she collects classic children's books",
      sourceTable: "canonical_states"
    }
  });

  const trace = resolveAnswerShapingTrace({
    family: "report",
    winner: "canonical_report",
    canonicalAdjudication: canonical,
    narrativeAdjudication: {
      canonical: {
        kind: "abstention",
        subjectEntityId: "person:caroline",
        canonicalSubjectName: "Caroline",
        subjectBindingStatus: "resolved",
        predicateFamily: "narrative_profile",
        supportStrength: "weak",
        timeScopeKind: "historical",
        confidence: "missing",
        abstainReason: "insufficient_support",
        sourceTable: "canonical_entity_reports"
      },
      formatted: {
        claimText: "Unknown.",
        finalClaimSource: "canonical_abstention",
        shapingTrace: {
          selectedFamily: "abstention",
          shapingMode: "abstention",
          supportRowsSelected: 1
        }
      },
      bundle: {
        ownerSourceTable: "canonical_entity_reports"
      }
    },
    exactDetailCandidate: null,
    supportRowsSelected: 1,
    claimText: canonical?.formatted.claimText ?? null
  });

  assert.equal(trace.selectedFamily, "report");
  assert.equal(trace.supportObjectType, "CollectionInferenceSupport");
  assert.equal(trace.renderContractSelected, "collection_yes_since_collects");
});

test("runtime shaping traces preserve planner metadata from canonical adjudication", () => {
  const trace = resolveAnswerShapingTrace({
    family: "exact_detail",
    winner: "runtime_exact_detail",
    canonicalAdjudication: {
      canonical: {
        kind: "fact",
        subjectEntityId: "person:nate",
        canonicalSubjectName: "Nate",
        subjectBindingStatus: "resolved",
        predicateFamily: "generic_fact",
        supportStrength: "strong",
        timeScopeKind: "active",
        confidence: "confident",
        objectValue: "Lord of the Rings",
        sourceTable: "canonical_facts"
      },
      formatted: {
        claimText: "Lord of the Rings",
        finalClaimSource: "canonical_exact_detail",
        shapingTrace: {
          selectedFamily: "exact_detail",
          retrievalPlanFamily: "exact_detail",
          retrievalPlanLane: "exact_detail",
          retrievalPlanCandidatePools: ["canonical_facts", "direct_detail_support"],
          retrievalPlanSuppressionPools: ["generic_snippet_support"],
          retrievalPlanRequiredFields: ["direct_detail_support"],
          retrievalPlanTargetedBackfill: [],
          retrievalPlanQueryExpansionTerms: ["favorite", "movie", "trilogy"],
          retrievalPlanBannedExpansionTerms: ["career"],
          retrievalPlanFamilyConfidence: 0.92,
          retrievalPlanSupportCompletenessTarget: 1,
          retrievalPlanRescuePolicy: "allow_immediate_abstention",
          ownerEligibilityHints: ["runtime_exact_detail", "canonical_exact_detail"],
          suppressionHints: ["canonical_report"],
          shapingMode: "stored_canonical_fact",
          shapingPipelineEntered: false,
          supportObjectAttempted: false,
          renderContractAttempted: false,
          typedValueUsed: false,
          generatedProseUsed: false,
          runtimeResynthesisUsed: false,
          supportRowsSelected: 1,
          supportTextsSelected: 0,
          supportSelectionMode: null,
          supportObjectsBuilt: 0,
          supportObjectType: null,
          supportNormalizationFailures: [],
          renderContractSelected: null,
          renderContractFallbackReason: null
        },
        answerBundle: null
      },
      bundle: {
        subjectEntityId: "person:nate",
        canonicalSubjectName: "Nate",
        subjectBindingStatus: "resolved",
        subjectPlan: {
          kind: "single_subject",
          subjectEntityId: "person:nate",
          canonicalSubjectName: "Nate",
          candidateEntityIds: ["person:nate"],
          candidateNames: ["Nate"],
          reason: "test"
        },
        predicateFamily: "generic_fact",
        provenanceRows: [],
        evidenceItems: [],
        supportStrength: "strong",
        timeScopeKind: "active",
        ownerSourceTable: "canonical_facts"
      }
    },
    narrativeAdjudication: null,
    exactDetailCandidate: {
      text: "Lord of the Rings",
      source: "artifact_source",
      strongSupport: true,
      predicateFit: true
    },
    supportRowsSelected: 1,
    claimText: "Lord of the Rings"
  });

  assert.equal(trace.retrievalPlanLane, "exact_detail");
  assert.equal(trace.retrievalPlanFamily, "exact_detail");
  assert.deepEqual(trace.retrievalPlanCandidatePools, ["canonical_facts", "direct_detail_support"]);
  assert.deepEqual(trace.retrievalPlanSuppressionPools, ["generic_snippet_support"]);
  assert.deepEqual(trace.suppressionHints, ["canonical_report"]);
});

test("runtime shaping traces fall back to the runtime retrieval plan when candidate traces are missing", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "What items does John collect?",
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });
  const trace = resolveAnswerShapingTrace({
    family: "report",
    winner: "top_snippet",
    canonicalAdjudication: null,
    narrativeAdjudication: null,
    runtimeRetrievalPlan: retrievalPlan,
    exactDetailCandidate: null,
    supportRowsSelected: 2,
    claimText: "Harry Potter items"
  });

  assert.equal(trace.retrievalPlanLane, "collection_inference");
  assert.equal(trace.retrievalPlanFamily, "report");
  assert.deepEqual(trace.retrievalPlanCandidatePools, retrievalPlan.candidatePools);
  assert.deepEqual(trace.retrievalPlanSuppressionPools, retrievalPlan.suppressionPools);
  assert.deepEqual(trace.suppressionHints, retrievalPlan.suppressionHints);
});

test("runtime shaping traces preserve planner targeted backfill telemetry when candidate traces are missing", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "What items does John collect?",
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });
  const trace = resolveAnswerShapingTrace({
    family: "report",
    winner: "top_snippet",
    canonicalAdjudication: null,
    narrativeAdjudication: null,
    runtimeRetrievalPlan: retrievalPlan,
    exactDetailCandidate: null,
    supportRowsSelected: 2,
    claimText: "jerseys",
    plannerTargetedBackfillApplied: true,
    plannerTargetedBackfillReason: "collection_entries_missing",
    plannerTargetedBackfillSubqueries: ["what else does John collect?"],
    plannerTargetedBackfillSatisfied: false
  });

  assert.equal(trace.plannerTargetedBackfillApplied, true);
  assert.equal(trace.plannerTargetedBackfillReason, "collection_entries_missing");
  assert.deepEqual(trace.plannerTargetedBackfillSubqueries, ["what else does John collect?"]);
  assert.equal(trace.plannerTargetedBackfillSatisfied, false);
});

test("narrative adjudication emits planner metadata for collection reports", () => {
  const decision = adjudicateNarrativeClaim({
    queryText: "What items does John collect?",
    exactDetailFamily: "generic",
    results: [
      recallResult("John collects Harry Potter items and related memorabilia.", {
        subject_entity_id: "person:john",
        subject_name: "John"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:john",
      canonicalSubjectName: "John",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "moderate",
      timeScopeKind: "active",
      confidence: "weak",
      objectValue: "Harry Potter items",
      reportKind: "collection_report",
      sourceTable: "canonical_entity_reports",
      answerPayload: {
        answer_type: "collection_items",
        answer_value: "Harry Potter items"
      },
      candidateCount: 1,
      selectionScoreMargin: 0.7
    }
  });

  assert.equal(decision.candidate?.formatted.shapingTrace?.retrievalPlanLane, "collection_inference");
  assert.equal(decision.candidate?.formatted.shapingTrace?.retrievalPlanFamily, "report");
  assert.ok(decision.candidate?.formatted.shapingTrace?.retrievalPlanSuppressionPools?.includes("exact_detail_support"));
});

test("preference choice support narrows profile reports into binary choice contracts", () => {
  const profileSupport = buildProfileInferenceSupport({
    reportKind: "profile_report",
    queryText: "Would Melanie be more interested in going to a national park or a theme park?",
    fallbackSummary: "National park; she likes the outdoors",
    answerPayload: null,
    results: [recallResult("Melanie loves the outdoors and hiking.", { subject_name: "Melanie" })]
  });
  const rendered = renderPreferenceChoiceSupport(
    buildPreferenceChoiceSupport({
      queryText: "Would Melanie be more interested in going to a national park or a theme park?",
      support: profileSupport
    })
  );

  assert.equal(rendered.claimText, "national park");
  assert.equal(rendered.supportObjectType, "PreferenceChoiceSupport");
  assert.equal(rendered.renderContractSelected, "binary_preference_choice");
});

test("preference choice support resolves books-by-author questions from fantasy reading evidence", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "preference_report",
    queryText: "Would Tim enjoy reading books by C. S. Lewis or John Greene?",
    fallbackSummary: null,
    answerPayload: null,
    results: [
      recallResult(
        "Tim: I'm currently reading a fantasy novel called The Name of the Wind. I love fantasy series and book recommendations.",
        {
          subject_name: "Tim",
          speaker_name: "Tim",
          subject_entity_id: "person:tim"
        }
      )
    ]
  });
  const rendered = renderPreferenceChoiceSupport(
    buildPreferenceChoiceSupport({
      queryText: "Would Tim enjoy reading books by C. S. Lewis or John Greene?",
      support
    })
  );

  assert.equal(rendered.claimText, "c. s. lewis");
  assert.equal(rendered.supportObjectType, "PreferenceChoiceSupport");
  assert.equal(rendered.renderContractSelected, "binary_preference_choice");
});

test("profile inference support strips serialized structured summaries before rendering", () => {
  const support = buildProfileInferenceSupport({
    reportKind: "travel_report",
    queryText: "What did Jon take a trip to Rome for?",
    fallbackSummary:
      "{\"memoryId\":\"x\",\"memoryType\":\"episodic_memory\",\"text\":\"He went to Rome for a dance workshop.\",\"occurredAt\":\"2023-01-01T00:00:00.000Z\"}",
    answerPayload: null,
    results: []
  });

  assert.equal(support.supportObjectType, "ProfileInferenceSupport");
  assert.equal(support.fallbackSummary, "He went to Rome for a dance workshop.");
});

test("top snippet shaping enters snippet fact support instead of silent fallback", () => {
  const rendered = renderSnippetFactSupport(
    buildSnippetFactSupport({
      finalClaimText: "The recommendation was Becoming Nicole."
    }),
    3
  );

  assert.equal(rendered.claimText, "The recommendation was Becoming Nicole.");
  assert.equal(rendered.supportObjectType, "SnippetFactSupport");
  assert.equal(rendered.renderContractSelected, "support_span_extract");
  assert.equal(rendered.supportObjectsBuilt, 1);
});

test("direct-detail support extracts text from serialized structured claim payloads", () => {
  const rendered = renderDirectDetailSupport(
    buildDirectDetailSupport({
      finalClaimText:
        "{\"memoryId\":\"x\",\"memoryType\":\"episodic_memory\",\"text\":\"six months\",\"occurredAt\":\"2023-01-01T00:00:00.000Z\"}",
      exactDetailCandidate: null
    }),
    1
  );

  assert.equal(rendered.claimText, "six months");
  assert.equal(rendered.supportObjectType, "DirectDetailSupport");
  assert.equal(rendered.renderContractSelected, "exact_canonical_value");
});

test("canonical exact-detail facts enter direct-detail shaping even when stored canonical value is serialized", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "How long did it take for Jon to open his studio?",
    results: [
      recallResult("It took Jon six months to open his studio.", {
        subject_entity_id: "person:jon",
        subject_name: "Jon"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jon"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      residualExact:
        "{\"memoryId\":\"x\",\"memoryType\":\"episodic_memory\",\"text\":\"six months\",\"occurredAt\":\"2023-01-01T00:00:00.000Z\"}"
    },
    storedCanonical: {
      kind: "fact",
      subjectEntityId: "person:jon",
      canonicalSubjectName: "Jon",
      subjectBindingStatus: "resolved",
      predicateFamily: "generic_fact",
      supportStrength: "strong",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValue:
        "{\"memoryId\":\"x\",\"memoryType\":\"episodic_memory\",\"text\":\"six months\",\"occurredAt\":\"2023-01-01T00:00:00.000Z\"}",
      sourceTable: "canonical_facts"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_exact_detail");
  assert.equal(adjudicated.formatted.claimText, "six months");
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectType, "DirectDetailSupport");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "exact_canonical_value");
  assert.equal(adjudicated.formatted.shapingTrace?.shapingPipelineEntered, true);
  assert.equal(adjudicated.formatted.shapingTrace?.bypassReason, null);
});

test("benchmark shaping diagnosis distinguishes owner, support, and rendering failures", () => {
  assert.equal(
    classifyAnswerShapingDiagnosis({
      question: "What books has Melanie read?",
      failureClass: "answer_shaping",
      finalClaimSource: "top_snippet",
      answerOwnerTrace: {
        family: "list_set",
        winner: "top_snippet",
        resolvedSubject: { bindingStatus: "resolved" }
      },
      answerShapingTrace: {
        selectedFamily: "list_set",
        shapingMode: "snippet_fallback",
        supportRowsSelected: 2
      }
    }),
    "wrong_owner"
  );

  assert.equal(
    classifyAnswerShapingDiagnosis({
      question: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
      failureClass: "abstention",
      finalClaimSource: "canonical_abstention",
      answerOwnerTrace: {
        family: "report",
        winner: "canonical_abstention",
        resolvedSubject: { bindingStatus: "resolved" }
      },
      answerShapingTrace: {
        selectedFamily: "abstention",
        shapingMode: "abstention",
        supportRowsSelected: 3
      }
    }),
    "honest_abstention_but_support_missing"
  );

  assert.equal(
    classifyAnswerShapingDiagnosis({
      question: "Would Caroline pursue writing as a career option?",
      failureClass: "answer_shaping",
      finalClaimSource: "canonical_report",
      answerOwnerTrace: {
        family: "report",
        winner: "canonical_report",
        resolvedSubject: { bindingStatus: "resolved" }
      },
      answerShapingTrace: {
        selectedFamily: "report",
        shapingMode: "stored_report_summary",
        supportRowsSelected: 4
      }
    }),
    "report_semantics_wrong"
  );
});

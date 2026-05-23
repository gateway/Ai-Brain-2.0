import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  normalizeExternalIeExtractorResult,
  runExternalRelationExtractionShadow,
  shutdownRelationIeSidecarWorker
} from "../dist/relationships/external-ie.js";

const SUPPORTED_RELATIONS = new Set([
  "friend_of",
  "works_with",
  "works_at",
  "worked_at",
  "works_on",
  "lives_in",
  "lived_in",
  "member_of",
  "met_through",
  "sibling_of",
  "was_with"
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");

async function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (typeof value === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

after(async () => {
  await shutdownRelationIeSidecarWorker();
});

test("GLiNER2 sidecar returns valid JSON with classifications and structures", async () => {
  const result = await runExternalRelationExtractionShadow(
    [
      {
        sceneIndex: 0,
        text: "Lauren and I no longer talk. Omi and I have become close friends, and I work for him as adviser slash CTO of Two Way."
      }
    ],
    { extractors: ["gliner2"] }
  );

  assert.equal(result.scenes.length, 1);
  const extractor = result.scenes[0].extractors[0];
  assert.equal(extractor.extractor, "gliner2");
  assert.ok(extractor.classifications && typeof extractor.classifications === "object");
  assert.ok(extractor.structures && typeof extractor.structures === "object");
  if (extractor.structures && typeof extractor.structures === "object") {
    const structureMeta = extractor.structures.__meta;
    if (structureMeta && typeof structureMeta === "object") {
      assert.ok("structure_confidence" in structureMeta);
    }
  }
});

test("GLiNER2 sidecar filters self-relations and normalizes predicates", async () => {
  const result = await runExternalRelationExtractionShadow(
    [
      {
        sceneIndex: 0,
        text: "Steve and Dan are close friends. Steve works at Two Way and works with Dan on Preset Kitchen in Chiang Mai."
      }
    ],
    { extractors: ["gliner2"] }
  );

  const extractor = result.scenes[0].extractors[0];
  for (const relation of extractor.relations ?? []) {
    assert.notEqual((relation.source ?? "").toLowerCase(), (relation.target ?? "").toLowerCase());
    assert.ok(SUPPORTED_RELATIONS.has(relation.relation), `unsupported predicate ${relation.relation}`);
  }
});

test("GLiNER2 failure leaves sidecar intact and falls through to spacy", async () => {
  await withEnv({ BRAIN_RELATION_IE_GLINER2_MODEL: "fastino/does-not-exist" }, async () => {
    const result = await runExternalRelationExtractionShadow(
      [
        {
          sceneIndex: 0,
          text: "Steve works at Two Way with Omi in Chiang Mai."
        }
      ],
      { extractors: ["gliner2", "spacy"] }
    );

    const gliner2 = result.scenes[0].extractors.find((entry) => entry.extractor === "gliner2");
    const spacy = result.scenes[0].extractors.find((entry) => entry.extractor === "spacy");
    assert.ok(gliner2);
    assert.ok((gliner2.warnings ?? []).length >= 1);
    assert.ok(spacy);
    assert.ok(Array.isArray(spacy.entities));
  });
});

test("external IE schema includes exact-detail and self-binding contracts", () => {
  const source = readFileSync(join(repoRoot, "src/relationships/external-ie.ts"), "utf8");
  assert.match(source, /ownership_mode/u);
  assert.match(source, /exact_detail_family/u);
  assert.match(source, /eventness/u);
  assert.match(source, /scalar_value_support/u);
  assert.match(source, /event_value_support/u);
  assert.match(source, /self_binding_support/u);
  assert.match(source, /confidence_summary/u);
  assert.match(source, /label_descriptions/u);
  assert.match(source, /classification: config\.relationIeClassificationThreshold/u);
  assert.match(source, /structure: config\.relationIeStructureThreshold/u);
  assert.match(source, /--daemon/u);
  assert.match(source, /relation_ie_mode/u);
  assert.match(source, /forceRun/u);
});

test("config exposes separate GLiNER classification and structure thresholds", () => {
  const source = readFileSync(join(repoRoot, "src/config.ts"), "utf8");
  assert.match(source, /relationIeClassificationThreshold/u);
  assert.match(source, /relationIeStructureThreshold/u);
  assert.match(source, /BRAIN_RELATION_IE_CLASSIFICATION_THRESHOLD/u);
  assert.match(source, /BRAIN_RELATION_IE_STRUCTURE_THRESHOLD/u);
});

test("config exposes GLiNER-Relex v1 flags and leaves promotion opt-in", () => {
  const source = readFileSync(join(repoRoot, "src/config.ts"), "utf8");
  const schemaSource = readFileSync(join(repoRoot, "src/relationships/relex-schema.ts"), "utf8");
  assert.match(source, /BRAIN_RELATION_IE_GLINER_RELEX_ENABLED/u);
  assert.match(source, /BRAIN_RELATION_IE_GLINER_RELEX_PROMOTE/u);
  assert.match(source, /BRAIN_RELATION_IE_GLINER_RELEX_SCHEMA_VERSION/u);
  assert.match(schemaSource, /knowledgator\/gliner-relex-large-v1\.0/u);
  assert.match(source, /parseBoolean\(env\.BRAIN_RELATION_IE_GLINER_RELEX_PROMOTE, false\)/u);
});

test("GLiNER-Relex v1 is normalized into relationship candidate buffer metadata", () => {
  const source = readFileSync(join(repoRoot, "src/relationships/external-ie.ts"), "utf8");
  assert.match(source, /gliner_relex_v1/u);
  assert.match(source, /candidate_buffer:\s*"relationship_candidates"/u);
  assert.match(source, /source_quote:\s*scene\.text/u);
  assert.match(source, /promotion_allowed/u);
  assert.match(source, /relation_schema_version/u);
});

test("GLiNER-Relex schema maps broad labels without open taxonomy promotion", () => {
  const source = readFileSync(join(repoRoot, "src/relationships/relex-schema.ts"), "utf8");
  assert.match(source, /RELEX_RELATION_LABELS/u);
  assert.match(source, /causal_reason/u);
  assert.match(source, /identity_support/u);
  assert.match(source, /return null/u);
});

test("GLiNER-Relex adoption exposes cross-ingest benchmark gates", () => {
  const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");
  const source = readFileSync(join(repoRoot, "src/benchmark/gliner-relex-bakeoff.ts"), "utf8");
  assert.match(packageJson, /benchmark:gliner-relex-cross-ingest-bakeoff/u);
  assert.match(packageJson, /benchmark:gliner-relex-promotion-dry-run/u);
  assert.match(packageJson, /benchmark:gliner-relex-cache-profile/u);
  assert.match(source, /sourceType:\s*"locomo"/u);
  assert.match(source, /sourceType:\s*"longmem"/u);
  assert.match(source, /sourceType:\s*"omi"/u);
  assert.match(source, /queryTimeModelCalls:\s*0/u);
});

test("GLiNER normalization demotes self-owned and exact-detail labels without truth-promotion support", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText: "I met Dan at a weekly coworking meetup and he introduced Gumi.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        ownership_mode: "self_owned",
        exact_detail_family: "pet_name",
        support_family: ["relationship"],
        narrative_frame: ["relationship", "activity"]
      },
      structures: {
        relationship_support: [{ subject: "Dan", other_person: "Gumi" }]
      }
    }
  });

  assert.equal(normalized.classifications?.ownership_mode, "unknown");
  assert.equal(normalized.classifications?.exact_detail_family, "none");
});

test("GLiNER normalization prunes noisy routine and project structures from plan-like scenes", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText: "Likely plans for tomorrow include brunch with Omi and Dan, and in April there is a planned trip to Istanbul for a conference.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["relationship", "project_focus", "temporal_event"],
        narrative_frame: ["temporal", "plan", "relationship"],
        eventness: "event_like"
      },
      structures: {
        relationship_support: [{ subject: "Omi", other_person: "Dan", time: "tomorrow" }],
        project_support: [{ project: "Pilots Association conference", time: "April" }],
        routine_support: [{ subject: "Omi", time_of_day: "tomorrow", activity: "brunch" }]
      }
    }
  });

  assert.equal(normalized.structures?.relationship_support, undefined);
  assert.equal(normalized.structures?.project_support, undefined);
  assert.equal(normalized.structures?.routine_support, undefined);
});

test("GLiNER normalization prunes routine-adjacent transition noise and upgrades routine frames to fact", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText: "I usually wake around 7 to 8 AM, make coffee, and start work around 10 AM while splitting time across Two Way and Well Inked.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["routine", "activity_participation"],
        narrative_frame: ["temporal", "activity"],
        eventness: "mixed"
      },
      structures: {
        routine_support: [{ subject: "I", time_of_day: "7 to 8 AM", activity: "make coffee" }],
        transition_support: [{ subject: "I", change: "split work across Two Way", time: "10 AM" }]
      }
    }
  });

  assert.ok(normalized.structures?.routine_support);
  assert.equal(normalized.structures?.transition_support, undefined);
  assert.ok(normalized.classifications?.narrative_frame.includes("fact"));
});

test("GLiNER normalization suppresses plan-only pair relationship structures", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText: "Likely plans for tomorrow include brunch with Omi and Dan, and later an April trip to Istanbul.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["relationship", "temporal_event"],
        narrative_frame: ["plan", "temporal", "relationship"],
        eventness: "event_like"
      },
      structures: {
        relationship_support: [{ subject: "Omi", other_person: "Dan", time: "tomorrow" }]
      }
    }
  });

  assert.equal(normalized.structures?.relationship_support, undefined);
});

test("GLiNER normalization converts ownership-role project rows into relationship support and project classification when appropriate", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText: "John is the owner of the Samui Experience in Koh Samui.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["activity_participation"],
        narrative_frame: ["fact", "activity"],
        eventness: "event_like"
      },
      structures: {
        project_support: [{ subject: "John", project: "Samui Experience", role: "owner" }]
      }
    }
  });

  assert.equal(normalized.structures?.project_support, undefined);
  assert.ok(normalized.structures?.relationship_support);
  assert.ok(normalized.classifications?.support_family.includes("relationship"));
});

test("LongMem exact-detail normalization keeps matched value support for shop, venue, duration, and pets", () => {
  const cases = [
    {
      text: "user: The new bookshelf is from IKEA, and I'm really happy with it.",
      kind: "event_value_support",
      key: "object_value",
      expected: "IKEA",
      support: /bookshelf is from IKEA/iu
    },
    {
      text: "user: I completed my undergrad in CS from UCLA before applying to graduate programs.",
      kind: "event_value_support",
      key: "object_value",
      expected: "UCLA",
      support: /undergrad in CS from UCLA/iu
    },
    {
      text: "user: I spent two weeks traveling solo around the country when I was in Japan.",
      kind: "event_value_support",
      key: "object_value",
      expected: "two weeks",
      support: /spent two weeks traveling solo/iu
    },
    {
      text: "user: I actually visited Fushimi Inari Shrine when I was in Japan a few months ago. I spent two weeks traveling solo around the country and it was an incredible experience.",
      kind: "event_value_support",
      key: "object_value",
      expected: "two weeks",
      support: /spent two weeks traveling solo/iu
    },
    {
      text: "user: I've been averaging around 2 hours of screen time on Instagram per day for the past two weeks.",
      kind: "event_value_support",
      key: "object_value",
      expected: "2 hours",
      support: /2 hours of screen time on Instagram/iu
    },
    {
      text: "user: By the way, my cat's name is Luna, and she's been such a sweetie.",
      kind: "scalar_value_support",
      key: "answer_value",
      expected: "Luna",
      support: /cat's name is Luna/iu
    },
    {
      text: "user: My cat, Luna, has been adjusting well to the changes at home.",
      kind: "scalar_value_support",
      key: "answer_value",
      expected: "Luna",
      support: /cat, Luna/iu
    },
    {
      text: "user: What collar brand would suit a Golden Retriever like Max?",
      kind: "scalar_value_support",
      key: "answer_value",
      expected: "Golden Retriever",
      support: /Golden Retriever like Max/iu
    },
    {
      text: "user: It took me and my friends around 5 hours to move everything into the new apartment.",
      kind: "event_value_support",
      key: "object_value",
      expected: "5 hours",
      support: /5 hours to move everything/iu
    },
    {
      text: "user: Before the RAM upgrade to 16GB, I was getting around 6-7 hours of battery life.",
      kind: "scalar_value_support",
      key: "answer_value",
      expected: "16GB",
      support: /RAM upgrade to 16GB/iu
    }
  ];

  for (const scenario of cases) {
    const normalized = normalizeExternalIeExtractorResult({
      sceneText: scenario.text,
      extractor: {
        extractor: "gliner2",
        classifications: { ownership_mode: "self_owned", exact_detail_family: "none", support_family: ["other"], narrative_frame: ["fact"] },
        structures: {}
      }
    });
    const entry = normalized.structures?.[scenario.kind]?.[0];
    assert.ok(entry, `missing ${scenario.kind} for ${scenario.text}`);
    assert.equal(entry[scenario.key], scenario.expected);
    assert.match(entry.support_phrase, scenario.support);
  }
});

test("GLiNER normalization upgrades project structures into project_focus support", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText: "Omi and I work together and I now work for Two Way as adviser slash CTO.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["relationship", "activity_participation"],
        narrative_frame: ["relationship", "activity"],
        eventness: "mixed"
      },
      structures: {
        project_support: [{ subject: "Omi", project: "Two Way", role: "CTO", organization: "Two Way" }]
      }
    }
  });

  assert.ok(normalized.structures?.project_support);
  assert.ok(normalized.classifications?.support_family.includes("project_focus"));
  assert.ok(normalized.classifications?.narrative_frame.includes("fact"));
});

test("GLiNER normalization rejects relationship rows where the subject collapses into the organization", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText: "Yesterday I worked on Two Way with Omi Gummi and kept pushing the AI brain work forward.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["relationship", "project_focus"],
        narrative_frame: ["activity", "fact"],
        eventness: "mixed"
      },
      structures: {
        relationship_support: [{ subject: "Two Way", other_person: "Omi Gummi", organization: "Two Way", time: "Yesterday" }]
      }
    }
  });

  assert.equal(normalized.structures?.relationship_support, undefined);
});

test("GLiNER normalization rejects coarse year-only pair transitions without an explicit change", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText: "Lauren and I no longer talk. Omi and I have become close friends, and in 2026 we worked together on Two Way.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["relationship", "temporal_event"],
        narrative_frame: ["temporal", "relationship", "fact"],
        eventness: "mixed"
      },
      structures: {
        transition_support: [{ subject: "Lauren", counterparty: "Omi", time: "2026" }]
      }
    }
  });

  assert.equal(normalized.structures?.transition_support, undefined);
});

test("GLiNER normalization derives multiple project support rows from project-stack scenes", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText:
      "I am working with Well Inked on a memoir-style engine, with Omi on Two Way for a pilot association platform, personally on Preset Kitchen, and also on an AI brain to help with memory and organization.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["project_focus"],
        narrative_frame: ["activity"],
        eventness: "mixed"
      },
      structures: {
        project_support: [{ subject: "Omi", project: "Two Way", role: null, organization: null, time: null }]
      }
    }
  });

  const haystack = JSON.stringify(normalized.structures?.project_support ?? []);
  assert.match(haystack, /Well Inked/);
  assert.match(haystack, /memoir-style engine/);
  assert.match(haystack, /Two Way/);
  assert.match(haystack, /pilot association platform/);
  assert.ok(normalized.classifications?.support_family.includes("project_focus"));
  assert.ok(normalized.classifications?.narrative_frame.includes("fact"));
});

test("GLiNER normalization derives project recap support without treating tools as organizations", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText:
      "Yesterday I worked on an AI brain using Postgres and relationship graphs, on Preset Kitchen, on Bumblebee for Well Inked, and as CTO for Two Way owned by Omi Gummi while redesigning the website and planning a Webflow migration.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["project_focus"],
        narrative_frame: ["activity"],
        eventness: "mixed"
      },
      structures: {
        project_support: [{ subject: null, project: "Well Inked", role: null, organization: "Bumblebee", time: "Yesterday" }]
      }
    }
  });

  const entries = normalized.structures?.project_support ?? [];
  const haystack = JSON.stringify(entries);
  assert.match(haystack, /AI brain/);
  assert.match(haystack, /Preset Kitchen/);
  assert.match(haystack, /Bumblebee/);
  assert.match(haystack, /Well Inked/);
  assert.match(haystack, /Two Way/);
  assert.match(haystack, /CTO/);
  assert.ok(entries.some((entry) => entry.project === "AI brain" && /Postgres/.test(String(entry.tool_substrate ?? ""))));
  assert.ok(entries.some((entry) => entry.project === "Bumblebee" && entry.organization === "Well Inked"));
  assert.ok(entries.some((entry) => entry.project === "Two Way" && entry.role === "CTO"));
  assert.ok(!entries.some((entry) => entry.organization === "Postgres"));
  assert.ok(!entries.some((entry) => /Webflow/.test(String(entry.organization ?? ""))));
});

test("GLiNER normalization derives extra routine and project support from routine scenes", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText:
      "I usually wake around 7 to 8 AM, make coffee, check AI news on Reddit, review emails and tasks, and start work around 10 AM either at home or a coworking space. I split work across Two Way and Well Inked and take a midday break for the gym, yoga, or a walk.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["routine", "activity_participation"],
        narrative_frame: ["temporal", "activity"],
        eventness: "mixed"
      },
      structures: {
        routine_support: [{ subject: "I", time_of_day: "7 to 8 AM", activity: "make coffee", context: null }]
      }
    }
  });

  const routineHaystack = JSON.stringify(normalized.structures?.routine_support ?? []);
  const projectHaystack = JSON.stringify(normalized.structures?.project_support ?? []);
  assert.match(routineHaystack, /Reddit/);
  assert.match(projectHaystack, /Two Way/);
  assert.match(projectHaystack, /Well Inked/);
  assert.doesNotMatch(projectHaystack, /midday break/);
  assert.ok(normalized.classifications?.support_family.includes("project_focus"));
  assert.ok(normalized.classifications?.narrative_frame.includes("fact"));
});

test("GLiNER normalization derives community relationship support from friend-network scenes", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText:
      "I attended a two-hour AI and LLM meetup at the Canass Hotel in Chiang Mai, made friends through coworking and meetups including Dan, Gumi, Tim, and Ben, then rode my scooter to Living a Dream coffee and caught up with Tim.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["relationship", "activity_participation"],
        narrative_frame: ["relationship", "activity"],
        eventness: "mixed"
      },
      structures: {}
    }
  });

  const relationshipHaystack = JSON.stringify(normalized.structures?.relationship_support ?? []);
  assert.match(relationshipHaystack, /Dan/);
  assert.match(relationshipHaystack, /Tim/);
  assert.doesNotMatch(relationshipHaystack, /tomorrow/);
  assert.ok(normalized.classifications?.support_family.includes("relationship"));
});

test("GLiNER normalization derives project graph support without treating tools as organizations", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText:
      "Ben and I talked about the memoir AI engine and how to create the knowledge graph using a Postgres database and entity extraction to build a life graph for the memoirs project.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["project_focus"],
        narrative_frame: ["plan"],
        eventness: "mixed"
      },
      structures: {
        project_support: [{ subject: "Ben", project: "memoirs", role: null, organization: "Postgres", time: null }]
      }
    }
  });

  const entries = normalized.structures?.project_support ?? [];
  const haystack = JSON.stringify(entries);
  assert.match(haystack, /memoir AI engine/);
  assert.match(haystack, /knowledge graph/);
  assert.match(haystack, /Postgres database/);
  assert.ok(entries.some((entry) => entry.tool_substrate === "Postgres database and entity extraction"));
  assert.ok(entries.some((entry) => entry.project === "memoir AI engine" && entry.organization === null));
  assert.ok(!entries.some((entry) => entry.organization === "Postgres"));
  assert.ok(normalized.classifications?.support_family.includes("project_focus"));
  assert.ok(normalized.classifications?.narrative_frame.includes("fact"));
});

test("GLiNER normalization does not create project support from generic tech chatter without a project cue", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText: "We mentioned Postgres, vector indexes, and entity extraction during a general technical conversation.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["activity_participation"],
        narrative_frame: ["activity"],
        eventness: "mixed"
      },
      structures: {
        project_support: []
      }
    }
  });

  assert.equal(normalized.structures?.project_support, undefined);
});

test("GLiNER normalization derives planned trip transition support with place and time", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText:
      "Likely plans for tomorrow include brunch with Omi and Dan, and in April there is a planned trip to Istanbul, Turkey at the end of April for a Pilots Association conference.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["relationship", "project_focus", "temporal_event"],
        narrative_frame: ["temporal", "plan", "relationship"],
        eventness: "event_like"
      },
      structures: {
        relationship_support: [{ subject: "Omi", other_person: "Dan", time: "tomorrow" }]
      }
    }
  });

  const transitionHaystack = JSON.stringify(normalized.structures?.transition_support ?? []);
  assert.match(transitionHaystack, /Istanbul/);
  assert.match(transitionHaystack, /April/);
  assert.doesNotMatch(transitionHaystack, /Istanbul, Turkey at the end of/);
  assert.doesNotMatch(transitionHaystack, /"counterparty":"Istanbul/);
  assert.equal(normalized.structures?.relationship_support, undefined);
  assert.ok(normalized.classifications?.support_family.includes("temporal_event"));
  assert.ok(normalized.classifications?.narrative_frame.includes("temporal"));
});

test("GLiNER normalization derives departure transition support with destination location", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText: "On October 18, 2025, Lauren left Chiang Mai, Thailand to fly back to the United States, specifically to Bend, Oregon.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["temporal_event"],
        narrative_frame: ["fact", "temporal"],
        eventness: "event_like"
      },
      structures: {
        transition_support: [{ subject: "Lauren", change: null, counterparty: null, time: "October 18, 2025", reason: null }]
      }
    }
  });

  const transitionHaystack = JSON.stringify(normalized.structures?.transition_support ?? []);
  assert.match(transitionHaystack, /Lauren/);
  assert.match(transitionHaystack, /October 18, 2025/);
  assert.match(transitionHaystack, /Bend, Oregon/);
  assert.doesNotMatch(transitionHaystack, /"counterparty":"Bend/);
});

test("GLiNER normalization preserves CTO role from adviser slash CTO clauses", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText:
      "Lauren and I no longer talk. Omi and I have become close friends, and I now work for him as adviser slash CTO of his company Two Way. We have grown the friendship by working together and hiking over the last few months in 2026.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["relationship", "activity_participation", "project_focus"],
        narrative_frame: ["temporal", "relationship", "activity"],
        eventness: "mixed"
      },
      structures: {
        relationship_support: [{ subject: "Lauren", other_person: "Omi", relation: "close friends", organization: "Two Way", time: null }],
        project_support: [{ subject: "Omi", project: "Two Way", role: "adviser", organization: "Two Way", time: null }]
      }
    }
  });

  const projectHaystack = JSON.stringify(normalized.structures?.project_support ?? []);
  assert.match(projectHaystack, /Two Way/);
  assert.match(projectHaystack, /CTO/);
  assert.ok((normalized.structures?.project_support ?? []).some((entry) => entry.project === "Two Way" && entry.role === "CTO"));
  assert.equal(normalized.structures?.transition_support, undefined);
});

test("GLiNER normalization derives coupon store context from Cartwheel app support", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText: "I've been using the Cartwheel app from Target and it's been helpful for coupons.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["activity_participation"],
        narrative_frame: ["fact"],
        eventness: "mixed"
      },
      structures: {}
    }
  });

  const eventHaystack = JSON.stringify(normalized.structures?.event_value_support ?? []);
  assert.match(eventHaystack, /Target/);
  assert.match(eventHaystack, /purchase_source/);
  assert.ok(normalized.structures?.self_binding_support);
});

test("GLiNER normalization derives LongMem playlist and previous-last-name scalar support", () => {
  const playlist = normalizeExternalIeExtractorResult({
    sceneText: "I've been listening to this one playlist on Spotify that I created, called Summer Vibes, and it's perfect for relaxing.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["activity_participation"],
        narrative_frame: ["fact"],
        eventness: "mixed"
      },
      structures: {}
    }
  });
  const playlistHaystack = JSON.stringify(playlist.structures?.scalar_value_support ?? []);
  assert.match(playlistHaystack, /spotify_playlist_name/);
  assert.match(playlistHaystack, /Summer Vibes/);
  assert.ok(playlist.structures?.self_binding_support);

  const lastName = normalizeExternalIeExtractorResult({
    sceneText: "I just recently changed my last name, and I'm still getting used to it - it's funny, my old name was Johnson, but now it's Winters.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["identity"],
        narrative_frame: ["fact"],
        eventness: "event_like"
      },
      structures: {}
    }
  });
  const lastNameHaystack = JSON.stringify(lastName.structures?.scalar_value_support ?? []);
  assert.match(lastNameHaystack, /previous_last_name/);
  assert.match(lastNameHaystack, /Johnson/);
  assert.ok(lastName.structures?.self_binding_support);
});

test("GLiNER normalization derives LongMem wall-color scalar support", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText:
      "By the way, I've been doing some redecorating and recently repainted my bedroom walls a lighter shade of gray - it's made the room feel so much brighter!",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["activity_participation"],
        narrative_frame: ["fact", "activity"],
        eventness: "mixed"
      },
      structures: {}
    }
  });

  const scalarHaystack = JSON.stringify(normalized.structures?.scalar_value_support ?? []);
  assert.match(scalarHaystack, /wall_color/);
  assert.match(scalarHaystack, /lighter shade of gray/);
  assert.ok(normalized.structures?.self_binding_support);
});

test("GLiNER normalization derives destination support from later flew-back clauses", () => {
  const normalized = normalizeExternalIeExtractorResult({
    sceneText:
      "My recent relationship change was when Lauren left Thailand on 10/18/2025. We spent much of 2025 together in Chiang Mai, then she flew back to the US to Bend, Oregon and we have not really talked since.",
    extractor: {
      extractor: "gliner2",
      classifications: {
        support_family: ["relationship", "temporal_event"],
        narrative_frame: ["temporal", "relationship"],
        eventness: "event_like"
      },
      structures: {
        transition_support: [{ subject: "Lauren", change: null, counterparty: null, time: "10/18/2025", reason: null }]
      }
    }
  });

  const transitionHaystack = JSON.stringify(normalized.structures?.transition_support ?? []);
  assert.match(transitionHaystack, /Lauren/);
  assert.match(transitionHaystack, /10\/18\/2025/);
  assert.match(transitionHaystack, /Bend, Oregon/);
  assert.doesNotMatch(transitionHaystack, /"counterparty":"Bend/);
});

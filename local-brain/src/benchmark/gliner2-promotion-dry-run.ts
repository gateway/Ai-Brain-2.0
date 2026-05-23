import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { withTransaction } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { upsertNamespaceSelfProfileForClient } from "../identity/service.js";
import { rebuildExactDetailFactKeysNamespace } from "../retrieval/exact-detail-fact-keys.js";
import {
  analyzeSceneStructuredExactDetailRows,
  type SceneExactDetailPromotionDiagnostic
} from "../retrieval/exact-detail-fact-keys.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type JsonRecord = Record<string, unknown>;

interface PromotionDryRunCase {
  readonly name: string;
  readonly sourceKind: "omi_shadow_support" | "longmem_exact_detail_fixture";
  readonly sceneId: string;
  readonly sourceSceneId: string;
  readonly sceneText: string;
  readonly occurredAt: string;
  readonly sceneMetadata: JsonRecord;
  readonly selfEntityId: string;
  readonly selfAliases: readonly string[];
}

interface PromotionDryRunRow {
  readonly source_scene_id: string | null;
  readonly support_phrase: string | null;
  readonly inferredFamily: string;
  readonly familyHint: string | null;
  readonly promotionRejectedReason: null;
  readonly factTable: string;
  readonly factRowId: string;
  readonly propertyKey: string | null;
  readonly keyType: string;
  readonly keyText: string;
  readonly truthStatus: string;
  readonly confidence: number | null;
  readonly extractorConfidence: number | null;
  readonly ownershipEvidenceStatus: string | null;
  readonly familyEvidenceStatus: string | null;
  readonly valueAdmissibilityStatus: string | null;
}

interface PromotionDryRunDiagnosticRow {
  readonly source_scene_id: string;
  readonly support_phrase: string | null;
  readonly inferredFamily: string | null;
  readonly familyHint: string | null;
  readonly promotionEligible: boolean;
  readonly promotionRejectedReason: string | null;
  readonly ownershipEvidenceStatus: string;
  readonly familyEvidenceStatus: string;
  readonly valueAdmissibilityStatus: string;
  readonly extractorConfidence: number | null;
  readonly structureKind: string;
}

interface PromotionDryRunCaseResult {
  readonly name: string;
  readonly sourceKind: PromotionDryRunCase["sourceKind"];
  readonly source_scene_id: string;
  readonly relationIeMode: "support_and_promote";
  readonly eligibleCount: number;
  readonly rejectedCount: number;
  readonly rows: readonly PromotionDryRunRow[];
  readonly diagnostics: readonly PromotionDryRunDiagnosticRow[];
}

interface DbPromotionFixtureRow {
  readonly exact_detail_family: string;
  readonly key_type: string;
  readonly key_text: string;
  readonly source_scene_id: string | null;
  readonly support_phrase: string | null;
  readonly model_id: string | null;
  readonly schema_version: string | null;
  readonly extractor_confidence: number | null;
  readonly ownershipEvidenceStatus: string | null;
  readonly familyEvidenceStatus: string | null;
  readonly valueAdmissibilityStatus: string | null;
  readonly scene_structure_kind: string | null;
}

interface DbPromotionFixtureResult {
  readonly namespaceId: string;
  readonly expectedEligibleFamilies: readonly string[];
  readonly insertedValueFamilies: readonly string[];
  readonly insertedValueCount: number;
  readonly rejectedGenericSupport: boolean;
  readonly rowsHaveRequiredProvenance: boolean;
  readonly promotionReviewPromotedRowCount: number;
  readonly promotionReviewRejectedCount: number;
  readonly rows: readonly DbPromotionFixtureRow[];
  readonly passed: boolean;
}

export interface Gliner2PromotionDryRunReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly mode: "dry_run";
  readonly relationIeMode: "support_and_promote";
  readonly eligibleCount: number;
  readonly rejectedCount: number;
  readonly rejectionBreakdown: Readonly<Record<string, number>>;
  readonly eligibleByFamily: Readonly<Record<string, number>>;
  readonly rejectedByFamily: Readonly<Record<string, number>>;
  readonly ownershipEvidenceStatus: Readonly<Record<string, number>>;
  readonly familyEvidenceStatus: Readonly<Record<string, number>>;
  readonly valueAdmissibilityStatus: Readonly<Record<string, number>>;
  readonly extractorConfidence: {
    readonly count: number;
    readonly min: number | null;
    readonly max: number | null;
    readonly average: number | null;
  };
  readonly promotionConfidence: {
    readonly count: number;
    readonly min: number | null;
    readonly max: number | null;
    readonly average: number | null;
    readonly source: "extractorConfidence_placeholder";
  };
  readonly dbFixture: DbPromotionFixtureResult;
  readonly cases: readonly PromotionDryRunCaseResult[];
  readonly passed: boolean;
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function rootDir(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function bucketIncrement(bucket: Record<string, number>, key: string | null | undefined): void {
  const normalized = key && key.trim().length > 0 ? key : "null";
  bucket[normalized] = (bucket[normalized] ?? 0) + 1;
}

function confidenceSummary(values: readonly (number | null)[]): {
  readonly count: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly average: number | null;
} {
  const finiteValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finiteValues.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      average: null
    };
  }
  return {
    count: finiteValues.length,
    min: Math.min(...finiteValues),
    max: Math.max(...finiteValues),
    average: finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length
  };
}

function withSupportAndPromoteMode(sceneMetadata: JsonRecord): JsonRecord {
  const externalIe = sceneMetadata.external_relation_ie;
  if (!externalIe || typeof externalIe !== "object" || Array.isArray(externalIe)) {
    return sceneMetadata;
  }
  const externalRecord = externalIe as JsonRecord;
  const extractors = Array.isArray(externalRecord.extractors)
    ? externalRecord.extractors.map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? {
              ...(entry as JsonRecord),
              relation_ie_mode: "support_and_promote"
            }
          : entry
      )
    : [];
  return {
    ...sceneMetadata,
    external_relation_ie: {
      ...externalRecord,
      relation_ie_mode: "support_and_promote",
      extractors
    }
  };
}

function gliner2SceneMetadata(params: {
  readonly structures: JsonRecord;
  readonly classifications?: JsonRecord;
  readonly sourceMemoryId?: string;
  readonly sourceChunkId?: string;
}): JsonRecord {
  return {
    external_relation_ie: {
      relation_ie_mode: "support_and_promote",
      source_memory_id: params.sourceMemoryId ?? "33333333-3333-7333-8333-333333333333",
      source_chunk_id: params.sourceChunkId ?? "44444444-4444-7444-8444-444444444444",
      extractors: [
        {
          extractor: "gliner2",
          model_id: "fastino/gliner2-base-v1",
          schema_version: "gliner2_native_v2",
          relation_ie_mode: "support_and_promote",
          classifications: params.classifications ?? {},
          structures: params.structures
        }
      ]
    }
  };
}

function dryRunCases(): PromotionDryRunCase[] {
  const selfEntityId = "22222222-2222-7222-8222-222222222222";
  return [
    {
      name: "omi_project_support_two_way_cto",
      sourceKind: "omi_shadow_support",
      sceneId: "11111111-1111-7111-8111-111111111201",
      sourceSceneId: "omi_two_way_role_shift",
      sceneText: "I now work for him as adviser slash CTO of his company Two Way.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          support_family: ["project_focus"],
          exact_detail_family: ["role"]
        },
        structures: {
          project_support: [{ subject: "I", project: "Two Way", role: "CTO", support_phrase: "adviser slash CTO of his company Two Way" }]
        }
      })
    },
    {
      name: "omi_transition_support_istanbul",
      sourceKind: "omi_shadow_support",
      sceneId: "11111111-1111-7111-8111-111111111202",
      sourceSceneId: "istanbul_pilot_trip",
      sceneText: "I planned a trip to Istanbul at the end of April.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          support_family: ["temporal_event"],
          narrative_frame: ["plan"]
        },
        structures: {
          transition_support: [{ subject: "I", change: "planned trip to Istanbul", time: "end of April", support_phrase: "planned a trip to Istanbul at the end of April" }]
        }
      })
    },
    {
      name: "longmem_music_service_scalar",
      sourceKind: "longmem_exact_detail_fixture",
      sceneId: "11111111-1111-7111-8111-111111111203",
      sourceSceneId: "longmem_music_service_scalar",
      sceneText: "My current music service is Spotify.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          ownership_mode: ["self_owned"],
          exact_detail_family: ["service_name"]
        },
        structures: {
          scalar_value_support: [
            {
              subject: "Steve",
              property_key: "music_service",
              answer_value: "Spotify",
              ownership_cue: "my",
              support_phrase: "My current music service is Spotify."
            }
          ],
          __meta: {
            structure_confidence: {
              scalar_value_support: 0.93
            }
          }
        }
      })
    },
    {
      name: "longmem_bookshelf_shop_event",
      sourceKind: "longmem_exact_detail_fixture",
      sceneId: "11111111-1111-7111-8111-111111111204",
      sourceSceneId: "longmem_bookshelf_shop_event",
      sceneText: "I bought the bookshelf from IKEA.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          ownership_mode: ["self_owned"],
          exact_detail_family: ["shop"]
        },
        structures: {
          event_value_support: [
            {
              subject: "Steve",
              predicate_family: "purchase_source",
              ownership_cue: "I",
              support_phrase: "I bought the bookshelf from IKEA."
            }
          ],
          __meta: {
            structure_confidence: {
              event_value_support: 0.88
            }
          }
        }
      })
    },
    {
      name: "longmem_broad_service_prose_rejected",
      sourceKind: "longmem_exact_detail_fixture",
      sceneId: "11111111-1111-7111-8111-111111111205",
      sourceSceneId: "longmem_broad_service_prose_rejected",
      sceneText: "Lately I have been balancing playlists, messages, travel planning, and work across a few apps.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          ownership_mode: ["self_owned"],
          exact_detail_family: ["service_name"]
        },
        structures: {
          scalar_value_support: [
            {
              subject: "Steve",
              property_key: "music_service",
              ownership_cue: "my",
              support_phrase: "Lately I have been balancing playlists, messages, travel planning, and work across a few apps."
            }
          ],
          __meta: {
            structure_confidence: {
              scalar_value_support: 0.76
            }
          }
        }
      })
    },
    {
      name: "longmem_weak_ownership_shop_rejected",
      sourceKind: "longmem_exact_detail_fixture",
      sceneId: "11111111-1111-7111-8111-111111111206",
      sourceSceneId: "longmem_weak_ownership_shop_rejected",
      sceneText: "Someone bought a bookshelf from IKEA.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          exact_detail_family: ["shop"]
        },
        structures: {
          event_value_support: [
            {
              subject: "Someone",
              predicate_family: "purchase_source",
              support_phrase: "Someone bought a bookshelf from IKEA."
            }
          ],
          __meta: {
            structure_confidence: {
              event_value_support: 0.74
            }
          }
        }
      })
    },
    {
      name: "longmem_internet_speed_scalar",
      sourceKind: "longmem_exact_detail_fixture",
      sceneId: "11111111-1111-7111-8111-111111111207",
      sourceSceneId: "longmem_internet_speed_scalar",
      sceneText: "My home internet speed is 200 Mbps.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          ownership_mode: ["self_owned"],
          exact_detail_family: ["speed"]
        },
        structures: {
          scalar_value_support: [
            {
              subject: "Steve",
              property_key: "internet_speed",
              answer_value: "200 Mbps",
              ownership_cue: "my",
              support_phrase: "My home internet speed is 200 Mbps."
            }
          ],
          __meta: {
            structure_confidence: {
              scalar_value_support: 0.91
            }
          }
        }
      })
    },
    {
      name: "longmem_running_shoe_brand_scalar",
      sourceKind: "longmem_exact_detail_fixture",
      sceneId: "11111111-1111-7111-8111-111111111208",
      sourceSceneId: "longmem_running_shoe_brand_scalar",
      sceneText: "My running shoe brand is Hoka.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          ownership_mode: ["self_owned"],
          exact_detail_family: ["brand"]
        },
        structures: {
          scalar_value_support: [
            {
              subject: "Steve",
              property_key: "running_shoe_brand",
              answer_value: "Hoka",
              ownership_cue: "my",
              support_phrase: "My running shoe brand is Hoka."
            }
          ],
          __meta: {
            structure_confidence: {
              scalar_value_support: 0.9
            }
          }
        }
      })
    },
    {
      name: "longmem_dog_breed_scalar",
      sourceKind: "longmem_exact_detail_fixture",
      sceneId: "11111111-1111-7111-8111-111111111209",
      sourceSceneId: "longmem_dog_breed_scalar",
      sceneText: "My dog is a golden retriever.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          ownership_mode: ["self_owned"],
          exact_detail_family: ["breed"]
        },
        structures: {
          scalar_value_support: [
            {
              subject: "Steve",
              property_key: "dog_breed",
              answer_value: "golden retriever",
              ownership_cue: "my",
              support_phrase: "My dog is a golden retriever."
            }
          ],
          __meta: {
            structure_confidence: {
              scalar_value_support: 0.9
            }
          }
        }
      })
    },
    {
      name: "longmem_bike_count_scalar",
      sourceKind: "longmem_exact_detail_fixture",
      sceneId: "11111111-1111-7111-8111-111111111210",
      sourceSceneId: "longmem_bike_count_scalar",
      sceneText: "I own 2 bikes.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          ownership_mode: ["self_owned"],
          exact_detail_family: ["count"]
        },
        structures: {
          scalar_value_support: [
            {
              subject: "Steve",
              property_key: "bike_count",
              answer_value: "2",
              ownership_cue: "I",
              support_phrase: "I own 2 bikes."
            }
          ],
          __meta: {
            structure_confidence: {
              scalar_value_support: 0.88
            }
          }
        }
      })
    },
    {
      name: "longmem_vintage_camera_duration_event",
      sourceKind: "longmem_exact_detail_fixture",
      sceneId: "11111111-1111-7111-8111-111111111211",
      sourceSceneId: "longmem_vintage_camera_duration_event",
      sceneText: "I have had the vintage camera for 8 years.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          ownership_mode: ["self_owned"],
          exact_detail_family: ["duration"]
        },
        structures: {
          event_value_support: [
            {
              subject: "Steve",
              predicate_family: "duration_held",
              object_value: "8 years",
              ownership_cue: "I",
              support_phrase: "I have had the vintage camera for 8 years."
            }
          ],
          __meta: {
            structure_confidence: {
              event_value_support: 0.87
            }
          }
        }
      })
    },
    {
      name: "longmem_yoga_class_venue_event",
      sourceKind: "longmem_exact_detail_fixture",
      sceneId: "11111111-1111-7111-8111-111111111212",
      sourceSceneId: "longmem_yoga_class_venue_event",
      sceneText: "I take yoga classes at Blue Lotus Yoga.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          ownership_mode: ["self_owned"],
          exact_detail_family: ["venue"]
        },
        structures: {
          event_value_support: [
            {
              subject: "Steve",
              predicate_family: "class_venue",
              object_value: "Blue Lotus Yoga",
              ownership_cue: "I",
              support_phrase: "I take yoga classes at Blue Lotus Yoga."
            }
          ],
          __meta: {
            structure_confidence: {
              event_value_support: 0.86
            }
          }
        }
      })
    },
    {
      name: "longmem_degree_certification_event",
      sourceKind: "longmem_exact_detail_fixture",
      sceneId: "11111111-1111-7111-8111-111111111213",
      sourceSceneId: "longmem_degree_certification_event",
      sceneText: "I graduated with a Business Administration degree.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          ownership_mode: ["self_owned"],
          exact_detail_family: ["certification"]
        },
        structures: {
          event_value_support: [
            {
              subject: "Steve",
              predicate_family: "degree_awarded",
              object_value: "Business Administration degree",
              ownership_cue: "I",
              support_phrase: "I graduated with a Business Administration degree."
            }
          ],
          __meta: {
            structure_confidence: {
              event_value_support: 0.86
            }
          }
        }
      })
    },
    {
      name: "longmem_last_name_family_gap_rejected",
      sourceKind: "longmem_exact_detail_fixture",
      sceneId: "11111111-1111-7111-8111-111111111214",
      sourceSceneId: "longmem_last_name_family_gap_rejected",
      sceneText: "My last name before I changed it was Rivers.",
      occurredAt: "2026-04-26T10:00:00.000Z",
      selfEntityId,
      selfAliases: ["Steve", "I"],
      sceneMetadata: gliner2SceneMetadata({
        classifications: {
          ownership_mode: ["self_owned"],
          exact_detail_family: ["last_name"]
        },
        structures: {
          scalar_value_support: [
            {
              subject: "Steve",
              property_key: "last_name",
              answer_value: "Rivers",
              ownership_cue: "my",
              support_phrase: "My last name before I changed it was Rivers."
            }
          ],
          __meta: {
            structure_confidence: {
              scalar_value_support: 0.86
            }
          }
        }
      })
    }
  ];
}

function rowDiagnosticForFamily(
  diagnostics: readonly SceneExactDetailPromotionDiagnostic[],
  family: string
): SceneExactDetailPromotionDiagnostic | null {
  return diagnostics.find((diagnostic) => diagnostic.promotionEligible && diagnostic.inferredFamily === family) ?? null;
}

function toRow(
  row: ReturnType<typeof analyzeSceneStructuredExactDetailRows>["rows"][number],
  diagnostics: readonly SceneExactDetailPromotionDiagnostic[]
): PromotionDryRunRow {
  const diagnostic = rowDiagnosticForFamily(diagnostics, row.family);
  const metadata = row.metadata;
  return {
    source_scene_id: typeof metadata.source_scene_id === "string" ? metadata.source_scene_id : null,
    support_phrase: typeof metadata.support_phrase === "string" ? metadata.support_phrase : null,
    inferredFamily: row.family,
    familyHint: typeof metadata.family_hint === "string" ? metadata.family_hint : null,
    promotionRejectedReason: null,
    factTable: row.factTable,
    factRowId: row.factRowId,
    propertyKey: row.propertyKey,
    keyType: row.keyType,
    keyText: row.keyText,
    truthStatus: row.truthStatus,
    confidence: row.confidence,
    extractorConfidence: typeof metadata.extractor_confidence === "number" ? metadata.extractor_confidence : null,
    ownershipEvidenceStatus: diagnostic?.ownershipEvidenceStatus ?? (typeof metadata.ownershipEvidenceStatus === "string" ? metadata.ownershipEvidenceStatus : null),
    familyEvidenceStatus: diagnostic?.familyEvidenceStatus ?? (typeof metadata.familyEvidenceStatus === "string" ? metadata.familyEvidenceStatus : null),
    valueAdmissibilityStatus: diagnostic?.valueAdmissibilityStatus ?? (typeof metadata.valueAdmissibilityStatus === "string" ? metadata.valueAdmissibilityStatus : null)
  };
}

function toDiagnosticRow(
  caseItem: PromotionDryRunCase,
  diagnostic: SceneExactDetailPromotionDiagnostic
): PromotionDryRunDiagnosticRow {
  return {
    source_scene_id: caseItem.sourceSceneId,
    support_phrase: diagnostic.supportPhrase,
    inferredFamily: diagnostic.inferredFamily,
    familyHint: diagnostic.familyHint,
    promotionEligible: diagnostic.promotionEligible,
    promotionRejectedReason: diagnostic.promotionRejectedReason,
    ownershipEvidenceStatus: diagnostic.ownershipEvidenceStatus,
    familyEvidenceStatus: diagnostic.familyEvidenceStatus,
    valueAdmissibilityStatus: diagnostic.valueAdmissibilityStatus,
    extractorConfidence: diagnostic.extractorConfidence,
    structureKind: diagnostic.structureKind
  };
}

function toMarkdown(report: Gliner2PromotionDryRunReport): string {
  const lines = [
    "# GLiNER2 Promotion Dry Run",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- relationIeMode: ${report.relationIeMode}`,
    `- eligibleCount: ${report.eligibleCount}`,
    `- rejectedCount: ${report.rejectedCount}`,
    "",
    "## Rejection Breakdown",
    ""
  ];
  for (const [reason, count] of Object.entries(report.rejectionBreakdown).sort()) {
    lines.push(`- ${reason}: ${count}`);
  }
  lines.push("", "## Eligible By Family", "");
  for (const [family, count] of Object.entries(report.eligibleByFamily).sort()) {
    lines.push(`- ${family}: ${count}`);
  }
  lines.push("", "## Cases", "");
  for (const caseResult of report.cases) {
    lines.push(
      `- ${caseResult.name}: eligible=${caseResult.eligibleCount} rejected=${caseResult.rejectedCount} source=${caseResult.sourceKind}`
    );
  }
  lines.push("", "## DB Promotion Fixture", "");
  lines.push(`- passed: ${report.dbFixture.passed}`);
  lines.push(`- namespaceId: ${report.dbFixture.namespaceId}`);
  lines.push(`- insertedValueCount: ${report.dbFixture.insertedValueCount}`);
  lines.push(`- insertedValueFamilies: ${report.dbFixture.insertedValueFamilies.join(", ") || "none"}`);
  lines.push(`- rejectedGenericSupport: ${report.dbFixture.rejectedGenericSupport}`);
  lines.push(`- rowsHaveRequiredProvenance: ${report.dbFixture.rowsHaveRequiredProvenance}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function insertPromotionFixtureScene(
  client: PoolClient,
  namespaceId: string,
  sceneId: string
): Promise<void> {
  const artifactId = randomUUID();
  const observationId = randomUUID();
  const checksum = `gliner2-promotion-fixture-${randomUUID()}`;
  await client.query(
    `
      INSERT INTO artifacts (
        id,
        namespace_id,
        artifact_type,
        uri,
        latest_checksum_sha256,
        mime_type,
        source_channel,
        metadata
      )
      VALUES ($1::uuid, $2, 'text', $3, $4, 'text/markdown', 'benchmark:gliner2-promotion-dry-run', $5::jsonb)
    `,
    [
      artifactId,
      namespaceId,
      `benchmark:gliner2-promotion-fixture:${namespaceId}`,
      checksum,
      JSON.stringify({ fixture: "gliner2_promotion_dry_run" })
    ]
  );
  await client.query(
    `
      INSERT INTO artifact_observations (
        id,
        artifact_id,
        version,
        checksum_sha256,
        byte_size,
        metadata
      )
      VALUES ($1::uuid, $2::uuid, 1, $3, $4, $5::jsonb)
    `,
    [
      observationId,
      artifactId,
      checksum,
      180,
      JSON.stringify({ fixture: "gliner2_promotion_dry_run" })
    ]
  );
  await client.query(
    `
      INSERT INTO narrative_scenes (
        id,
        namespace_id,
        artifact_id,
        artifact_observation_id,
        scene_index,
        scene_kind,
        scene_text,
        occurred_at,
        metadata
      )
      VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 0, 'paragraph', $5, $6::timestamptz, $7::jsonb)
    `,
    [
      sceneId,
      namespaceId,
      artifactId,
      observationId,
      "My current music service is Spotify. I bought the bookshelf from IKEA. I worked on the Memoir Engine knowledge graph using Postgres.",
      "2026-04-26T10:00:00.000Z",
      JSON.stringify(
        gliner2SceneMetadata({
          sourceMemoryId: "33333333-3333-7333-8333-333333333333",
          sourceChunkId: "44444444-4444-7444-8444-444444444444",
          classifications: {
            ownership_mode: ["self_owned"],
            exact_detail_family: ["service_name", "shop", "role"],
            support_family: ["project_focus"]
          },
          structures: {
            scalar_value_support: [
              {
                subject: "Steve",
                property_key: "music_service",
                answer_value: "Spotify",
                ownership_cue: "my",
                support_phrase: "My current music service is Spotify."
              }
            ],
            event_value_support: [
              {
                subject: "Steve",
                predicate_family: "purchase_source",
                ownership_cue: "I",
                support_phrase: "I bought the bookshelf from IKEA."
              }
            ],
            project_support: [
              {
                subject: "I",
                project: "Memoir Engine",
                tool: "Postgres",
                support_phrase: "worked on the Memoir Engine knowledge graph using Postgres"
              }
            ],
            __meta: {
              structure_confidence: {
                scalar_value_support: 0.93,
                event_value_support: 0.88,
                project_support: 0.82
              }
            }
          }
        })
      )
    ]
  );
}

async function cleanupPromotionFixtureNamespace(namespaceId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query("DELETE FROM exact_detail_fact_keys WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM artifacts WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM namespace_self_bindings WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM entity_aliases WHERE entity_id IN (SELECT id FROM entities WHERE namespace_id = $1)", [namespaceId]);
    await client.query("DELETE FROM entities WHERE namespace_id = $1", [namespaceId]);
  });
}

async function runDbBackedPromotionFixture(): Promise<DbPromotionFixtureResult> {
  await runMigrations();
  const namespaceId = `benchmark_gliner2_promotion_fixture_${randomUUID()}`;
  const sceneId = randomUUID();
  const expectedEligibleFamilies = ["service_name", "shop"];
  try {
    await withTransaction(async (client) => {
      await upsertNamespaceSelfProfileForClient(client, {
        namespaceId,
        canonicalName: "Steve",
        aliases: ["I", "my", "me"],
        source: "structured_truth_binding",
        confidence: 0.95,
        evidenceCount: 2,
        provenanceSummary: "GLiNER2 controlled promotion fixture"
      });
      await insertPromotionFixtureScene(client, namespaceId, sceneId);
    });

    await rebuildExactDetailFactKeysNamespace(namespaceId);

    const result = await withTransaction(async (client) => {
      const rowsResult = await client.query<DbPromotionFixtureRow>(
        `
          SELECT
            exact_detail_family,
            key_type,
            key_text,
            metadata->>'source_scene_id' AS source_scene_id,
            metadata->>'support_phrase' AS support_phrase,
            metadata->>'model_id' AS model_id,
            metadata->>'schema_version' AS schema_version,
            NULLIF(metadata->>'extractor_confidence', '')::double precision AS extractor_confidence,
            metadata->>'ownershipEvidenceStatus' AS "ownershipEvidenceStatus",
            metadata->>'familyEvidenceStatus' AS "familyEvidenceStatus",
            metadata->>'valueAdmissibilityStatus' AS "valueAdmissibilityStatus",
            metadata->>'scene_structure_kind' AS scene_structure_kind
          FROM exact_detail_fact_keys
          WHERE namespace_id = $1
          ORDER BY exact_detail_family, key_type, key_text
        `,
        [namespaceId]
      );
      const reviewResult = await client.query<{
        promoted_row_count: number | null;
        rejected_count: number | null;
      }>(
        `
          SELECT
            (metadata #>> '{external_relation_ie,promotion_review,promoted_row_count}')::integer AS promoted_row_count,
            (metadata #>> '{external_relation_ie,promotion_review,rejected_count}')::integer AS rejected_count
          FROM narrative_scenes
          WHERE id = $1::uuid
        `,
        [sceneId]
      );
      return {
        rows: rowsResult.rows,
        promotedRowCount: reviewResult.rows[0]?.promoted_row_count ?? 0,
        rejectedCount: reviewResult.rows[0]?.rejected_count ?? 0
      };
    });

    const valueRows = result.rows.filter((row) => row.key_type === "value");
    const insertedValueFamilies = [...new Set(valueRows.map((row) => row.exact_detail_family))].sort();
    const rowsHaveRequiredProvenance = valueRows.every(
      (row) =>
        row.source_scene_id === sceneId &&
        Boolean(row.support_phrase) &&
        Boolean(row.model_id) &&
        Boolean(row.schema_version) &&
        typeof row.extractor_confidence === "number" &&
        Boolean(row.ownershipEvidenceStatus) &&
        Boolean(row.familyEvidenceStatus) &&
        Boolean(row.valueAdmissibilityStatus)
    );
    const rejectedGenericSupport = !result.rows.some((row) => row.scene_structure_kind === "project_support");
    const passed =
      expectedEligibleFamilies.every((family) => insertedValueFamilies.includes(family)) &&
      insertedValueFamilies.every((family) => expectedEligibleFamilies.includes(family)) &&
      valueRows.length === expectedEligibleFamilies.length &&
      rowsHaveRequiredProvenance &&
      rejectedGenericSupport &&
      result.promotedRowCount >= expectedEligibleFamilies.length &&
      result.rejectedCount === 0;

    return {
      namespaceId,
      expectedEligibleFamilies,
      insertedValueFamilies,
      insertedValueCount: valueRows.length,
      rejectedGenericSupport,
      rowsHaveRequiredProvenance,
      promotionReviewPromotedRowCount: result.promotedRowCount,
      promotionReviewRejectedCount: result.rejectedCount,
      rows: result.rows,
      passed
    };
  } finally {
    await cleanupPromotionFixtureNamespace(namespaceId).catch(() => undefined);
  }
}

export async function runAndWriteGliner2PromotionDryRunBenchmark(): Promise<{
  readonly report: Gliner2PromotionDryRunReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const rejectionBreakdown: Record<string, number> = {};
  const eligibleByFamily: Record<string, number> = {};
  const rejectedByFamily: Record<string, number> = {};
  const ownershipEvidenceStatus: Record<string, number> = {};
  const familyEvidenceStatus: Record<string, number> = {};
  const valueAdmissibilityStatus: Record<string, number> = {};
  const confidenceValues: (number | null)[] = [];
  const cases: PromotionDryRunCaseResult[] = [];

  for (const caseItem of dryRunCases()) {
    const analysis = analyzeSceneStructuredExactDetailRows({
      sceneId: caseItem.sceneId,
      sceneText: caseItem.sceneText,
      occurredAt: caseItem.occurredAt,
      sceneMetadata: withSupportAndPromoteMode(caseItem.sceneMetadata),
      selfEntityId: caseItem.selfEntityId,
      selfAliases: caseItem.selfAliases
    });
    const rows = analysis.rows.map((row) => toRow(row, analysis.diagnostics));
    const diagnostics = analysis.diagnostics.map((diagnostic) => toDiagnosticRow(caseItem, diagnostic));
    for (const diagnostic of diagnostics) {
      bucketIncrement(ownershipEvidenceStatus, diagnostic.ownershipEvidenceStatus);
      bucketIncrement(familyEvidenceStatus, diagnostic.familyEvidenceStatus);
      bucketIncrement(valueAdmissibilityStatus, diagnostic.valueAdmissibilityStatus);
      confidenceValues.push(diagnostic.extractorConfidence);
      if (diagnostic.promotionEligible) {
        bucketIncrement(eligibleByFamily, diagnostic.inferredFamily);
      } else {
        bucketIncrement(rejectionBreakdown, diagnostic.promotionRejectedReason);
        bucketIncrement(rejectedByFamily, diagnostic.inferredFamily);
      }
    }
    cases.push({
      name: caseItem.name,
      sourceKind: caseItem.sourceKind,
      source_scene_id: caseItem.sourceSceneId,
      relationIeMode: "support_and_promote",
      eligibleCount: rows.filter((row) => row.keyType === "value").length,
      rejectedCount: diagnostics.filter((diagnostic) => !diagnostic.promotionEligible).length,
      rows,
      diagnostics
    });
  }

  const extractorConfidence = confidenceSummary(confidenceValues);
  const eligibleCount = cases.reduce((sum, caseResult) => sum + caseResult.eligibleCount, 0);
  const rejectedCount = cases.reduce((sum, caseResult) => sum + caseResult.rejectedCount, 0);
  const dbFixture = await runDbBackedPromotionFixture();
  const allEligibleRowsHaveRequiredFields = cases.every((caseResult) =>
    caseResult.rows
      .filter((row) => row.keyType === "value")
      .every(
        (row) =>
          row.source_scene_id &&
          row.support_phrase &&
          row.inferredFamily &&
          row.familyEvidenceStatus &&
          row.valueAdmissibilityStatus &&
          row.ownershipEvidenceStatus
      )
  );
  const hasControlledEligibleCandidate = eligibleCount > 0;
  const report: Gliner2PromotionDryRunReport = {
    generatedAt: new Date().toISOString(),
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        benchmark: "gliner2_promotion_dry_run",
        caseCount: cases.length,
        relationIeMode: "support_and_promote"
      }
    }),
    mode: "dry_run",
    relationIeMode: "support_and_promote",
    eligibleCount,
    rejectedCount,
    rejectionBreakdown,
    eligibleByFamily,
    rejectedByFamily,
    ownershipEvidenceStatus,
    familyEvidenceStatus,
    valueAdmissibilityStatus,
    extractorConfidence,
    promotionConfidence: {
      ...extractorConfidence,
      source: "extractorConfidence_placeholder"
    },
    dbFixture,
    cases,
    passed: hasControlledEligibleCandidate && allEligibleRowsHaveRequiredFields && dbFixture.passed
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `gliner2-promotion-dry-run-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `gliner2-promotion-dry-run-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return {
    report,
    output: {
      jsonPath,
      markdownPath
    }
  };
}

export async function runGliner2PromotionDryRunBenchmarkCli(): Promise<void> {
  const result = await runAndWriteGliner2PromotionDryRunBenchmark();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.report.passed) {
    process.exitCode = 1;
  }
}

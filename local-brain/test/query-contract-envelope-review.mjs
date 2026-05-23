import assert from "node:assert/strict";
import test from "node:test";

import { attachStableQueryContractEnvelope } from "../dist/mcp/query-contract-envelope.js";
import { presentHumanReadableQueryResult } from "../dist/mcp/query-presenter.js";

test("stable MCP query envelope preserves selection trace and source trail", async () => {
  const payload = await attachStableQueryContractEnvelope({
    toolName: "memory.search",
    namespaceId: "personal",
    queryText: "Tell me everything about Lauren.",
    payload: {
      duality: {
        claim: {
          text: "Lauren is a longtime friend and former partner. Timeline highlights for Lauren: Koh Samui and Chiang Mai."
        },
        evidence: [
          {
            memoryId: "memory:1",
            snippet: "Lauren lived with Steve in Koh Samui before moving to Chiang Mai.",
            sourceUri: "/tmp/relationship-history.md"
          }
        ],
        confidence: "confident",
        reason: "source bound",
        followUpAction: "none"
      },
      evidence: [
        {
          memoryId: "memory:1",
          snippet: "Lauren lived with Steve in Koh Samui before moving to Chiang Mai.",
          provenance: {
            source_uri: "/tmp/relationship-history.md",
            source_memory_ids: ["memory:1"],
            source_quote: "Lauren lived with Steve in Koh Samui before moving to Chiang Mai.",
            section: "timeline"
          }
        }
      ],
      meta: {
        finalClaimSource: "entity_dossier",
        queryContractName: "profile_report",
        queryContractRetrievalDomain: "personal_memory",
        queryContractAnswerShape: "report",
        queryContractFallbackBlockedReason: "source_bound_contract_selected",
        selectionTrace: [
          {
            stage: "entity_dossier",
            decision: "selected_typed_sections",
            reason: "Typed dossier sections outranked generic snippet fallback.",
            selectedSections: ["relationships", "timeline"]
          }
        ],
        answerSections: [
          {
            id: "relationships",
            title: "Relationships",
            text: "Lauren is a longtime friend and former partner.",
            evidenceCount: 1,
            focusModes: ["timeline"],
            sourceTrail: [
              {
                sourceUri: "/tmp/relationship-history.md",
                sourceMemoryIds: ["memory:1"],
                quote: "Lauren lived with Steve in Koh Samui before moving to Chiang Mai."
              }
            ]
          },
          {
            id: "timeline",
            title: "Timeline",
            text: "Koh Samui and Chiang Mai are key timeline anchors.",
            evidenceCount: 1,
            focusModes: ["timeline"],
            sourceTrail: [
              {
                sourceUri: "/tmp/relationship-history.md",
                sourceMemoryIds: ["memory:1"],
                quote: "Lauren lived with Steve in Koh Samui before moving to Chiang Mai."
              }
            ]
          }
        ],
        answerAssessment: {
          reason: "The broad entity summary was answered from source-bound dossier evidence."
        }
      }
    }
  });

  assert.equal(payload.queryContract, "profile_report");
  assert.equal(payload.finalClaimSource, "entity_dossier");
  assert.equal(payload.sourceTrail.length, 1);
  assert.equal(payload.selectionTrace.length, 1);
  assert.equal(payload.answerSections.length, 2);
  assert.deepEqual(payload.selectionTrace[0].selectedSections, ["relationships", "timeline"]);

  const full = presentHumanReadableQueryResult({
    query: "Tell me everything about Lauren.",
    payload,
    detailMode: "full"
  });
  const compact = presentHumanReadableQueryResult({
    query: "Tell me everything about Lauren.",
    payload,
    detailMode: "compact"
  });
  const timelineOnly = presentHumanReadableQueryResult({
    query: "Tell me everything about Lauren.",
    payload,
    detailMode: "full",
    focusMode: "timeline"
  });

  assert.match(full.whyThisAnswer, /relationships, timeline/u);
  assert.ok(full.sourceTrail.length > 0);
  assert.equal(full.answerSections.length, 2);
  assert.equal(timelineOnly.answerSections.length, 2);
  assert.match(timelineOnly.answer, /Relationships: Lauren is a longtime friend/u);
  assert.ok(compact.answer.length > 0);
});

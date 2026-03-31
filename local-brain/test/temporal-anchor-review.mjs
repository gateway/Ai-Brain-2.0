import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveTemporalClaimText,
  extractFocusedTemporalSnippet,
  inferRelativeTemporalAnswerLabel
} from "../dist/retrieval/service.js";

test("relative temporal labels prefer occurredAt over later reference time", () => {
  assert.equal(
    inferRelativeTemporalAnswerLabel(
      "Yeah, I painted that lake sunrise last year!",
      "2023-05-07T00:00:00.000Z",
      "2023-10-19T00:00:00.000Z"
    ),
    "2022"
  );
});

test("focused temporal snippet prefers the event-local festival sentence", () => {
  const content = [
    "Jon: Woah, that pic's from when my dance crew took home first in a local comp last year.",
    "Gina: Wow! Winning first place is amazing!",
    "Jon: Thanks! I rehearsed with a small group of dancers after work.",
    "Jon: Finishing up choreography to perform at a nearby festival next month. Can't wait!"
  ].join(" ");

  assert.equal(
    extractFocusedTemporalSnippet(content, "When is Jon's group performing at a festival?"),
    "Jon: Finishing up choreography to perform at a nearby festival next month."
  );
});

test("focused temporal snippet ignores multimodal sidecar text during source backfill", () => {
  const content = [
    "Jon: Wow, I'm excited too! This is gonna be great! [image: a photography of a man in a suit is performing a dance]",
    "--- image_query: dancing on stage performance dance competition last year",
    "--- image_caption: a photography of a man in a suit is performing a dance",
    "Jon: Thanks! I rehearsed with a small group of dancers after work. Finishing up choreography to perform at a nearby festival next month. Can't wait!"
  ].join("\n");

  assert.equal(
    extractFocusedTemporalSnippet(content.replace(/\n/g, " "), "When is Jon's group performing at a festival?"),
    "Finishing up choreography to perform at a nearby festival next month."
  );
});

test("temporal claim derivation prefers provenance-linked event-local relative cues", () => {
  const claimText = deriveTemporalClaimText("When is Jon's group performing at a festival?", [
    {
      memoryId: "topic-segment",
      memoryType: "artifact_derivation",
      content: "Topic segment about dance and performance.",
      score: 1,
      artifactId: "artifact-1",
      occurredAt: "2023-01-20T16:04:00.000Z",
      namespaceId: "ns_temporal_anchor",
      provenance: {
        tier: "artifact_derivation",
        metadata: {
          source_turn_text: "Thanks! I rehearsed with a small group of dancers after work. Finishing up choreography to perform at a nearby festival next month. Can't wait!"
        }
      }
    },
    {
      memoryId: "wrong-neighbor",
      memoryType: "episodic_memory",
      content: "Looks like you all had fun yesterday.",
      score: 0.5,
      artifactId: "artifact-2",
      occurredAt: "2023-10-19T00:00:00.000Z",
      namespaceId: "ns_temporal_anchor",
      provenance: {
        tier: "focused_episodic_support",
        metadata: {
          source_turn_text: "Looks like you all had fun yesterday.",
          is_relative_time: true,
          time_granularity: "day"
        }
      }
    }
  ]);

  assert.equal(claimText, "The best supported month is February 2023.");
});

test("temporal claim derivation prefers normalized event year over reapplying relative time", () => {
  const claimText = deriveTemporalClaimText('When did Joanna first watch "Eternal Sunshine of the Spotless Mind"?', [
    {
      memoryId: "temporal-media-anchor",
      memoryType: "procedural_memory",
      content:
        "Joanna watched Eternal Sunshine of the Spotless Mind. Time hint: around 3 years ago. Normalized year: 2020. Context: I first watched it around 3 years ago.",
      score: 1,
      artifactId: "artifact-joanna-movie",
      occurredAt: "2020-01-01T00:00:00.000Z",
      namespaceId: "ns_temporal_anchor",
      provenance: {
        typed_fact_kind: "temporal_media_anchor",
        subject_name: "Joanna",
        media_title: "Eternal Sunshine of the Spotless Mind",
        mention_kind: "watched",
        time_hint_text: "around 3 years ago",
        normalized_year: "2020",
        event_anchor_start: "2020-01-01T00:00:00.000Z",
        event_anchor_end: "2020-12-31T23:59:59.999Z"
      }
    }
  ]);

  assert.equal(claimText, "The best supported year is 2020.");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deriveCounterfactualSupportClaimText,
  deriveRealizationClaimText,
  deriveCausalMotiveClaimText
} from "../dist/retrieval/service.js";
import { isEventBoundedQuery } from "../dist/retrieval/query-signals.js";

function makeResult(content, options = {}) {
  return {
    memoryId: options.memoryId ?? "r1",
    memoryType: options.memoryType ?? "episodic_memory",
    content,
    score: options.score ?? 1,
    artifactId: null,
    occurredAt: options.occurredAt ?? null,
    namespaceId: "ns_test",
    provenance: {
      source_uri: options.sourceUri ?? null,
      metadata: options.metadata ?? {}
    }
  };
}

function withTempSource(content, callback) {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-causal-review-"));
  const file = path.join(dir, "source.md");
  writeFileSync(file, content, "utf8");
  try {
    callback(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("counterfactual support-removal returns likely no when goal, support, and dependency are explicit", () => {
  const claim = deriveCounterfactualSupportClaimText(
    "Would Caroline still want to pursue counseling as a career if she hadn't received support growing up?",
    [
      makeResult("Caroline: I'm keen on counseling or working in mental health - I'd love to support those with similar issues.", {
        metadata: { source_turn_text: "Caroline: I'm keen on counseling or working in mental health - I'd love to support those with similar issues." }
      }),
      makeResult(
        "Caroline: My own journey and the support I got made a huge difference. Now I want to help people go through it too. I saw how counseling and support groups improved my life.",
        {
          metadata: {
            source_turn_text:
              "Caroline: My own journey and the support I got made a huge difference. Now I want to help people go through it too. I saw how counseling and support groups improved my life."
          }
        }
      )
    ]
  );

  assert.equal(claim, "Likely no.");
});

test("counterfactual support-removal abstains when dependency chain is missing", () => {
  const claim = deriveCounterfactualSupportClaimText(
    "Would Caroline still want to pursue counseling as a career if she hadn't received support growing up?",
    [
      makeResult("Caroline: I'm keen on counseling or working in mental health - I'd love to support those with similar issues."),
      makeResult("Caroline: Supportive friends matter a lot to me.")
    ]
  );

  assert.equal(claim, null);
});

test("realization derivation prefers explicit post-event realization text", () => {
  const claim = deriveRealizationClaimText("What did Melanie realize after the charity race?", [
    makeResult(
      "Melanie: I ran a charity race for mental health last Saturday – it was really rewarding. The event was really thought-provoking. I'm starting to realize that self-care is really important.",
      {
        metadata: {
          source_turn_text:
            "Melanie: I ran a charity race for mental health last Saturday – it was really rewarding. The event was really thought-provoking. I'm starting to realize that self-care is really important."
        }
      }
    )
  ]);

  assert.equal(claim, "self-care is important");
});

test("realization derivation can recover from source-backed rows when result text collapses to None", () => {
  withTempSource(
    "Melanie: I ran a charity race for mental health last Saturday. The event was really thought-provoking. I'm starting to realize that self-care is really important.",
    (sourceUri) => {
      const claim = deriveRealizationClaimText("What did Melanie realize after the charity race?", [
        makeResult("None.", {
          sourceUri,
          metadata: {
            source_turn_text: ""
          }
        })
      ]);

      assert.equal(claim, "self-care is important");
    }
  );
});

test("realization derivation falls back to broader source-backed results when the primary row has no source text", () => {
  withTempSource(
    "Melanie: I ran a charity race for mental health last Saturday. The event was really thought-provoking. I'm starting to realize that self-care is really important.",
    (sourceUri) => {
      const claim = deriveRealizationClaimText("What did Melanie realize after the charity race?", [
        makeResult("None.", {
          memoryId: "primary-none",
          metadata: {}
        }),
        makeResult("Caroline: Melanie said the event was thought-provoking.", {
          memoryId: "fallback-source",
          sourceUri,
          metadata: {
            source_turn_text: ""
          }
        })
      ]);

      assert.equal(claim, "self-care is important");
    }
  );
});

test("realization derivation does not leak a neighboring speaker's realization", () => {
  const claim = deriveRealizationClaimText("What did Caroline realize after the charity race?", [
    makeResult("Caroline: It was nice hearing everyone cheer me on after the charity race.", {
      memoryId: "caroline-anchor",
      metadata: {
        source_turn_text: "Caroline: It was nice hearing everyone cheer me on after the charity race."
      }
    }),
    makeResult(
      "Melanie: I ran a charity race for mental health last Saturday – it was really rewarding. The event was really thought-provoking. I'm starting to realize that self-care is really important.",
      {
        memoryId: "melanie-realization",
        metadata: {
          source_turn_text:
            "Melanie: I ran a charity race for mental health last Saturday – it was really rewarding. The event was really thought-provoking. I'm starting to realize that self-care is really important."
        }
      }
    )
  ]);

  assert.equal(claim, null);
});

test("motive derivation prefers formative childhood trigger for John's civic interest", () => {
  const claim = deriveCausalMotiveClaimText(
    "What sparked John's interest in improving education and infrastructure in the community?",
    [
      makeResult(
        "John: Growing up, I saw how lack of education and crumbling infrastructure affected my neighborhood. I don't want future generations to go through that, so I think schools and infrastructure should be funded properly.",
        {
          metadata: {
            source_turn_text:
              "John: Growing up, I saw how lack of education and crumbling infrastructure affected my neighborhood. I don't want future generations to go through that, so I think schools and infrastructure should be funded properly."
          }
        }
      ),
      makeResult(
        "John: Going to community meetings and getting involved in my community has given me a better understanding of the challenges our education and infrastructure systems face.",
        {
          metadata: {
            source_turn_text:
              "John: Going to community meetings and getting involved in my community has given me a better understanding of the challenges our education and infrastructure systems face."
          }
        }
      )
    ]
  );

  assert.equal(
    claim,
    "lack of education and crumbling infrastructure affected my neighborhood"
  );
});

test("financial status derivation infers coarse comfort band from repeated income and savings signals", () => {
  const claim = deriveCausalMotiveClaimText(
    "What might John's financial status be?",
    [
      makeResult(
        "John: I won a really big video game tournament last week and it was awesome! I still can't believe I made so much money from it.",
        {
          metadata: {
            source_turn_text:
              "John: I won a really big video game tournament last week and it was awesome! I still can't believe I made so much money from it."
          }
        }
      ),
      makeResult(
        "John: Thanks! Yeah, I saved some but I'm not sure what to do with it - I'm completely content already. I don't have big plans anyway, so it's nice to have the extra cash on hand.",
        {
          metadata: {
            source_turn_text:
              "John: Thanks! Yeah, I saved some but I'm not sure what to do with it - I'm completely content already. I don't have big plans anyway, so it's nice to have the extra cash on hand."
          }
        }
      )
    ]
  );

  assert.equal(claim, "Middle-class or wealthy");
});

test("counterfactual derivation can recover from source-backed support chains when the top row is only a partial snippet", () => {
  withTempSource(
    [
      "Caroline: I'm keen on counseling or working in mental health - I'd love to support those with similar issues.",
      "Caroline: My own journey and the support I got made a huge difference. Now I want to help people go through it too. I saw how counseling and support groups improved my life."
    ].join("\n"),
    (sourceUri) => {
      const claim = deriveCounterfactualSupportClaimText(
        "Would Caroline still want to pursue counseling as a career if she hadn't received support growing up?",
        [
          makeResult("What's pushing you to keep going forward with it? Caroline: I struggled with mental health, and support I got was really helpful.", {
            sourceUri,
            metadata: {
              source_turn_text:
                "What's pushing you to keep going forward with it? Caroline: I struggled with mental health, and support I got was really helpful."
            }
          })
        ]
      );

      assert.equal(claim, "Likely no.");
    }
  );
});

test("event-bounded signal remains narrow for realization questions before service-level promotion", () => {
  assert.equal(isEventBoundedQuery("What did Melanie realize after the charity race?"), false);
});

test("event-bounded signal remains narrow for sparked-interest questions before service-level promotion", () => {
  assert.equal(
    isEventBoundedQuery("What sparked John's interest in improving education and infrastructure in the community?"),
    false
  );
});

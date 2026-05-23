import assert from "node:assert/strict";
import test from "node:test";
import { closePool } from "../dist/db/client.js";
import { searchMemory } from "../dist/retrieval/service.js";

process.env.BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION = "1";
process.env.BRAIN_ENABLE_RECAP_PROFILE_PROJECTION = "1";
process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION = "1";
process.env.BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION = "1";

test("subject-bound historical work query resolves through the source-bound work-history lane", async () => {
  const response = await searchMemory({
    namespaceId: "personal",
    query: "What things did I do with id Software and John Carmack?",
    limit: 8
  });

  try {
    assert.equal(response.meta.queryContractName, "profile_report");
    assert.equal(response.meta.finalClaimSource, "work_history_report_direct_read_model");
    assert.ok(response.evidence.length > 0);

    const haystack = `${response.duality.claim.text} ${response.evidence.map((entry) => entry.snippet).join(" ")}`.toLowerCase();
    for (const term of ["john carmack", "id software", "quake"]) {
      assert.ok(haystack.includes(term), `missing term: ${term}`);
    }
  } finally {
    await closePool();
  }
});

test("employer list phrasing resolves through the source-bound work-history lane", async () => {
  const response = await searchMemory({
    namespaceId: "personal",
    query: "What companies have I worked for?",
    limit: 8
  });

  try {
    assert.equal(response.meta.queryContractName, "profile_report");
    assert.equal(response.meta.finalClaimSource, "work_history_report_direct_read_model");
    assert.ok(response.evidence.length > 0);
    assert.ok(Array.isArray(response.meta.answerSections));
    assert.ok(response.meta.answerSections.some((section) => section.id === "employment_history"));

    const haystack = `${response.duality.claim.text} ${response.evidence.map((entry) => entry.snippet).join(" ")}`.toLowerCase();
    for (const term of ["apogee", "rogue", "well inked", "two-way"]) {
      assert.ok(haystack.includes(term), `missing term: ${term}`);
    }
  } finally {
    await closePool();
  }
});

test("broad work-history answer returns sectioned employers and ventures without mixing the default employer list", async () => {
  const response = await searchMemory({
    namespaceId: "personal",
    query: "Give me my full work history with roles and dates.",
    limit: 8
  });

  try {
    assert.equal(response.meta.queryContractName, "profile_report");
    assert.equal(response.meta.finalClaimSource, "work_history_report_direct_read_model");
    assert.ok(Array.isArray(response.meta.answerSections));
    const sectionIds = response.meta.answerSections.map((section) => section.id);
    assert.ok(sectionIds.includes("employment_history"));
    assert.ok(sectionIds.includes("ventures_projects"));
    const employmentSection = response.meta.answerSections.find((section) => section.id === "employment_history");
    assert.match(employmentSection?.text ?? "", /Apogee|Rogue|Well Inked|Two-Way/u);
    assert.match(employmentSection?.text ?? "", /date unknown|2026-/u);
  } finally {
    await closePool();
  }
});

test("employers versus projects phrasing stays in the same work-history contract family", async () => {
  const response = await searchMemory({
    namespaceId: "personal",
    query: "List employers vs projects I've worked on.",
    limit: 8
  });

  try {
    assert.equal(response.meta.queryContractName, "profile_report");
    assert.equal(response.meta.finalClaimSource, "work_history_report_direct_read_model");
    const sectionIds = Array.isArray(response.meta.answerSections) ? response.meta.answerSections.map((section) => section.id) : [];
    assert.ok(sectionIds.includes("employment_history"));
    assert.ok(sectionIds.includes("ventures_projects"));
  } finally {
    await closePool();
  }
});

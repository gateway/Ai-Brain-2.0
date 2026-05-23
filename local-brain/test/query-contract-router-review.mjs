import assert from "node:assert/strict";
import test from "node:test";
import { inferQueryContract } from "../dist/retrieval/query-contract-router.js";

test("relationship chronology contract handles natural pair/self phrasing", () => {
  for (const query of [
    "what happened between Lauren and me?",
    "what happened between me and Lauren?",
    "what went on with Lauren?",
    "tell me our history with Lauren",
    "how has my relationship with Lauren changed recently?"
  ]) {
    const contract = inferQueryContract(query);
    assert.equal(contract.contractName, "relationship_chronology", query);
    assert.equal(contract.targetProjection, "relationship_chronology_projection_v1", query);
    assert.ok(contract.subjectHints.includes("Lauren"), query);
    assert.ok(contract.blockedFallbacks.includes("generic_lexical"), query);
  }
});

test("relationship map contract handles single-person human relationship questions", () => {
  for (const query of [
    "who is Lauren to me?",
    "who is John in my life?",
    "how do I know Ben?",
    "what is James associated with?"
  ]) {
    const contract = inferQueryContract(query);
    assert.equal(contract.contractName, "relationship_map", query);
    assert.equal(contract.targetProjection, "relationship_map_projection_v1", query);
    assert.ok(contract.subjectHints.length >= 1, query);
  }
});

test("relationship chronology beats exact detail for what-happened-between phrasing", () => {
  const contract = inferQueryContract("what happened between Lauren and me?");
  assert.equal(contract.contractName, "relationship_chronology");
  assert.notEqual(contract.contractName, "direct_fact");
  assert.equal(contract.contractFamily, "profile_report");
});

test("shared social graph contract captures mutual friend phrasing instead of relationship-map prose", () => {
  for (const query of [
    "Who are all of mine and Dan's friends?",
    "who are my mutual friends with Lauren?",
    "who do Dan and I both know?",
    "which friends do Dan and I have in common?"
  ]) {
    const contract = inferQueryContract(query);
    assert.equal(contract.contractName, "shared_social_graph", query);
    assert.equal(contract.answerShape, "list", query);
    assert.ok(contract.subjectHints.length >= 2, query);
    assert.ok(contract.blockedFallbacks.includes("relationship_map_projection"), query);
  }
});

test("ambiguous relationship phrasing abstains instead of opening generic fallback", () => {
  const contract = inferQueryContract("what happened between me and them?");
  assert.equal(contract.contractName, "abstention");
  assert.ok(contract.blockedFallbacks.includes("generic_lexical"));
  assert.ok(contract.routingReasons.includes("relationship_contract_missing_subject"));
});

test("common non-relationship questions still map to broad reusable contracts", () => {
  assert.equal(inferQueryContract("what movies have I talked about?").contractName, "list_set");
  assert.equal(inferQueryContract("what am I working on right now?").contractName, "current_state");
  assert.equal(inferQueryContract("when did Lauren leave Thailand?").contractName, "temporal_event");
  assert.equal(inferQueryContract("summarize what I know about Dan").contractName, "profile_report");
  assert.equal(inferQueryContract("Tell me everything about Lauren").contractName, "profile_report");
  assert.equal(inferQueryContract("Give me the whole story on Omi").contractName, "profile_report");
  assert.equal(inferQueryContract("What does the system know about Bend for me?").contractName, "profile_report");
  assert.equal(inferQueryContract("What have I done in my career?").contractName, "profile_report");
  assert.equal(inferQueryContract("What have I built or worked on professionally over time?").contractName, "profile_report");
  assert.equal(inferQueryContract("Tell me about my work history").contractName, "profile_report");
  assert.equal(inferQueryContract("What companies have I worked for?").contractName, "profile_report");
  assert.equal(inferQueryContract("Can you give me a list of companies that I've worked for in summarized short form?").contractName, "profile_report");
  assert.equal(inferQueryContract("Where have I worked?").contractName, "profile_report");
  assert.equal(inferQueryContract("What things did I do with id Software and John Carmack?").contractName, "profile_report");
  assert.equal(inferQueryContract("What roles have I had at Two-Way and Well Inked?").contractName, "profile_report");
  assert.equal(inferQueryContract("List employers vs projects I've worked on.").contractName, "profile_report");
  assert.equal(inferQueryContract("What am I actively building now versus where do I work?").contractName, "profile_report");
  assert.equal(inferQueryContract("What do we know about The Samui Experience?").contractName, "profile_report");
  assert.equal(inferQueryContract("what do I need to do today?").contractName, "task_list");
  assert.equal(inferQueryContract("how do I run production readiness?").contractName, "procedure_lookup");
  assert.equal(inferQueryContract("what does this spec say about Router v2?").contractName, "document_lookup");
  assert.equal(inferQueryContract("why do you think Steve lives in Chiang Mai?").contractName, "source_audit");
});

test("subject-bound historical work queries preserve both org and person hints", () => {
  const contract = inferQueryContract("What things did I do with id Software and John Carmack?");
  assert.equal(contract.contractName, "profile_report");
  assert.ok(contract.subjectHints.some((hint) => hint.toLowerCase() === "id software"));
  assert.ok(contract.subjectHints.some((hint) => hint.toLowerCase() === "john carmack"));
  assert.ok(contract.routingReasons.includes("subject_bound_history_query"));
});

test("broad profile-about queries strip trailing self phrases from explicit subjects", () => {
  const contract = inferQueryContract("What does the system know about Bend for me?");
  assert.equal(contract.contractName, "profile_report");
  assert.ok(contract.subjectHints.includes("Bend"));
  assert.ok(!contract.subjectHints.includes("Bend for me"));
});

test("relationship chronology also captures reconnection phrasing", () => {
  const contract = inferQueryContract("How did Lauren and I reconnect?");
  assert.equal(contract.contractName, "relationship_chronology");
  assert.equal(contract.answerShape, "timeline");
});

test("standalone known project definition questions route to project definition", () => {
  for (const query of ["What is Two Way?", "What is AI Brain?", "Tell me about Well Inked", "Tell me everything about AI Brain"]) {
    const contract = inferQueryContract(query);
    assert.equal(contract.contractName, "project_definition", query);
    assert.equal(contract.retrievalDomain, "project_definition", query);
    assert.equal(contract.targetProjection, "project_definition_projection_v1", query);
    assert.ok(contract.blockedFallbacks.includes("generic_lexical"), query);
  }
});

test("review-only queries route to review_unknown backlog instead of direct_fact", () => {
  const contract = inferQueryContract("classify this uncategorized memory question");
  assert.equal(contract.contractName, "review_only");
  assert.equal(contract.retrievalDomain, "review_unknown");
  assert.ok(contract.blockedFallbacks.includes("generic_lexical"));
});

test("unknown titled definition questions route to review_unknown instead of pretending to know", () => {
  const contract = inferQueryContract("What is Zednock?");
  assert.equal(contract.contractName, "review_only");
  assert.equal(contract.retrievalDomain, "review_unknown");
  assert.equal(contract.answerShape, "abstention");
});

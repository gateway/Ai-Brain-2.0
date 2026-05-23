export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly requiredInputs: readonly string[];
  readonly optionalInputs: readonly string[];
}

export const toolDescriptors: readonly ToolDescriptor[] = [
  {
    name: "memory.recap",
    description: "Return a grouped evidence pack for recap-style questions, with optional local/OpenRouter summary derivation on top of the retrieved evidence.",
    requiredInputs: ["query", "namespace_id"],
    optionalInputs: ["time_start", "time_end", "reference_now", "limit", "participants", "topics", "projects", "provider", "model", "detail_mode", "focus_mode"]
  },
  {
    name: "memory.extract_tasks",
    description: "Extract task-like action items from a grounded recap evidence pack, preserving evidence IDs and source links.",
    requiredInputs: ["query", "namespace_id"],
    optionalInputs: ["time_start", "time_end", "reference_now", "limit", "participants", "topics", "projects", "provider", "model"]
  },
  {
    name: "memory.extract_calendar",
    description: "Extract calendar-like commitments from a grounded recap evidence pack, preserving evidence IDs and source links.",
    requiredInputs: ["query", "namespace_id"],
    optionalInputs: ["time_start", "time_end", "reference_now", "limit", "participants", "topics", "projects", "provider", "model"]
  },
  {
    name: "memory.explain_recap",
    description: "Explain why a recap-style answer was returned by exposing the grouped evidence pack and retrieval rationale.",
    requiredInputs: ["query", "namespace_id"],
    optionalInputs: ["time_start", "time_end", "reference_now", "limit", "participants", "topics", "projects"]
  },
  {
    name: "memory.search",
    description: "SQL-first hybrid recall over episodic, semantic, procedural, relationship, temporal, and derived memory with clarification-aware abstention and evidence-backed answers.",
    requiredInputs: ["query", "namespace_id"],
    optionalInputs: ["time_start", "time_end", "reference_now", "limit", "detail_mode", "focus_mode"]
  },
  {
    name: "memory.timeline",
    description: "Return chronological memory evidence within a time window.",
    requiredInputs: ["namespace_id", "time_start", "time_end"],
    optionalInputs: ["limit"]
  },
  {
    name: "memory.get_artifact",
    description: "Fetch artifact metadata and source pointer details.",
    requiredInputs: ["artifact_id"],
    optionalInputs: []
  },
  {
    name: "memory.get_relationships",
    description: "Look up relationship edges and supporting evidence.",
    requiredInputs: ["entity_name", "namespace_id"],
    optionalInputs: ["predicate", "time_start", "time_end", "include_historical", "limit"]
  },
  {
    name: "memory.get_graph",
    description: "Return a provenance-backed relationship graph centered on an entity or namespace.",
    requiredInputs: ["namespace_id"],
    optionalInputs: ["entity_name", "time_start", "time_end", "limit"]
  },
  {
    name: "memory.get_clarifications",
    description: "Read unresolved clarification items and suggested follow-up prompts for weak or unknown answers.",
    requiredInputs: ["namespace_id"],
    optionalInputs: ["query", "limit"]
  },
  {
    name: "memory.list_corrections",
    description: "Read operator correction candidates, including clarifications, role conflicts, and recent correction decisions.",
    requiredInputs: ["namespace_id"],
    optionalInputs: ["query", "limit"]
  },
  {
    name: "memory.apply_correction",
    description: "Apply a durable entity spelling, alias, or entity-role correction through the inbox/outbox propagation path.",
    requiredInputs: ["namespace_id", "source_name", "canonical_name", "entity_type"],
    optionalInputs: ["source_entity_type", "canonical_entity_type", "target_entity_id", "aliases", "preserve_aliases", "note"]
  },
  {
    name: "memory.keep_correction_separate",
    description: "Record that two similar entities are explicitly not the same identity.",
    requiredInputs: ["namespace_id", "left_name", "right_name", "entity_type"],
    optionalInputs: ["left_entity_id", "right_entity_id", "note"]
  },
  {
    name: "memory.get_correction_status",
    description: "Inspect whether a spelling or alias correction has propagated through entities, aliases, decisions, outbox, and role projections.",
    requiredInputs: ["namespace_id", "canonical_name"],
    optionalInputs: ["source_name", "entity_type", "limit"]
  },
  {
    name: "memory.apply_source_privacy",
    description: "Apply a durable source privacy overlay such as logical delete, redaction, access label, or retention policy without deleting raw source truth.",
    requiredInputs: ["namespace_id", "action_type"],
    optionalInputs: ["target_artifact_id", "target_source_uri", "target_chunk_id", "redaction_text", "access_label", "retention_policy", "reason", "actor"]
  },
  {
    name: "memory.revert_source_privacy",
    description: "Revert a source privacy overlay while preserving the audit trail and immutable raw source truth.",
    requiredInputs: ["namespace_id", "overlay_id"],
    optionalInputs: ["reason", "actor"]
  },
  {
    name: "memory.get_source_privacy_status",
    description: "Inspect source privacy overlays, source-truth catalog policy, and audit trail for deletion/redaction/access-label operations.",
    requiredInputs: ["namespace_id"],
    optionalInputs: ["target_artifact_id", "target_source_uri", "limit"]
  },
  {
    name: "memory.get_stats",
    description: "Return read-only brain health, queue, worker, bootstrap, and monitored-source stats for operator-style assistant checks.",
    requiredInputs: [],
    optionalInputs: ["source_limit"]
  },
  {
    name: "memory.get_protocols",
    description: "Return active constraint and style-spec protocol rules that govern assistant behavior and operational workflow.",
    requiredInputs: ["namespace_id"],
    optionalInputs: ["query", "limit"]
  },
  {
    name: "memory.save_candidate",
    description: "Stage a candidate memory for later consolidation.",
    requiredInputs: ["namespace_id", "content", "candidate_type"],
    optionalInputs: ["source_memory_id", "confidence", "metadata"]
  },
  {
    name: "memory.upsert_state",
    description: "Write mutable active truth into procedural memory.",
    requiredInputs: ["namespace_id", "state_type", "state_key", "state_value"],
    optionalInputs: ["metadata"]
  }
];

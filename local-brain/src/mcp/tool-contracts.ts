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
    optionalInputs: ["time_start", "time_end", "reference_now", "limit", "participants", "topics", "projects", "provider", "model"]
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
    optionalInputs: ["time_start", "time_end", "reference_now", "limit"]
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
    optionalInputs: ["predicate", "time_start", "time_end", "limit"]
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

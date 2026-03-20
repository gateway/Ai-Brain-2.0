export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly requiredInputs: readonly string[];
  readonly optionalInputs: readonly string[];
}

export const toolDescriptors: readonly ToolDescriptor[] = [
  {
    name: "memory.search",
    description: "Current lexical-first recall over episodic, semantic, procedural, and historical memory with a planned hybrid vector upgrade path.",
    requiredInputs: ["query", "namespace_id"],
    optionalInputs: ["time_start", "time_end", "limit"]
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
    name: "memory.get_clarifications",
    description: "Read unresolved clarification items and suggested follow-up prompts for weak or unknown answers.",
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

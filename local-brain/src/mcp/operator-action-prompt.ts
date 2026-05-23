export type OperatorActionPromptKind =
  | "none"
  | "clarify_ambiguity"
  | "choose_correction_candidate"
  | "confirm_merge"
  | "source_audit_follow_up"
  | "privacy_blocked";

export interface OperatorActionPrompt {
  readonly kind: OperatorActionPromptKind;
  readonly message: string;
  readonly choices: readonly {
    readonly id: string;
    readonly label: string;
    readonly entityId?: string;
    readonly consequence: string;
  }[];
  readonly required: boolean;
  readonly expiresAt: string | null;
}

function ttl(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function buildOperatorActionPrompt(params: {
  readonly queryText: string;
  readonly evidenceCount: number;
  readonly abstentionReason?: string | null;
  readonly sourceAuditTarget?: unknown;
  readonly correctionCandidates?: readonly { readonly id: string; readonly label: string; readonly entityId?: string }[];
  readonly privacyBlocked?: boolean;
}): OperatorActionPrompt {
  if (params.privacyBlocked) {
    return {
      kind: "privacy_blocked",
      message: "This answer is blocked by source privacy policy. Use the privacy audit tools if you need to inspect the policy trail.",
      choices: [],
      required: false,
      expiresAt: null
    };
  }
  if (params.correctionCandidates && params.correctionCandidates.length > 1) {
    return {
      kind: "choose_correction_candidate",
      message: "Multiple matching entities were found. Choose the canonical entity before applying the correction.",
      choices: params.correctionCandidates.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        entityId: candidate.entityId,
        consequence: "Apply the correction overlay to this canonical entity and preserve the audit trail."
      })),
      required: true,
      expiresAt: ttl(30)
    };
  }
  if (params.correctionCandidates && params.correctionCandidates.length === 1) {
    const candidate = params.correctionCandidates[0]!;
    return {
      kind: "confirm_merge",
      message: `One likely entity match was found: ${candidate.label}. Confirm before merging or attaching aliases.`,
      choices: [
        {
          id: candidate.id,
          label: candidate.label,
          entityId: candidate.entityId,
          consequence: "Attach the correction to the existing canonical entity."
        },
        {
          id: "create_new",
          label: "Create new entity",
          consequence: "Keep this mention separate and create a new canonical entity."
        }
      ],
      required: true,
      expiresAt: ttl(30)
    };
  }
  if (/\b(?:where did|source|sources|evidence|come from|audit)\b/iu.test(params.queryText) && params.evidenceCount === 0) {
    return {
      kind: "source_audit_follow_up",
      message: "No prior claim target was available. Ask the source-audit question with named people, places, projects, or a prior answer target.",
      choices: [],
      required: false,
      expiresAt: null
    };
  }
  if (params.evidenceCount === 0 && params.abstentionReason) {
    return {
      kind: "clarify_ambiguity",
      message: params.abstentionReason,
      choices: [],
      required: false,
      expiresAt: ttl(15)
    };
  }
  return { kind: "none", message: "", choices: [], required: false, expiresAt: null };
}

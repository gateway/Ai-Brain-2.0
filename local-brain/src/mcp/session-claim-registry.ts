export interface SessionClaimRegistryEntry {
  readonly sessionId: string;
  readonly claimId: string;
  readonly query: string;
  readonly claimText: string;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export class SessionClaimRegistry {
  private readonly entries = new Map<string, SessionClaimRegistryEntry>();

  upsert(input: Omit<SessionClaimRegistryEntry, "createdAt" | "expiresAt"> & { readonly ttlMs?: number }): SessionClaimRegistryEntry {
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? 30 * 60_000)).toISOString();
    const entry = { ...input, createdAt, expiresAt };
    this.entries.set(this.key(input.sessionId, input.claimId), entry);
    return entry;
  }

  lookup(sessionId: string, claimId: string, now = new Date()): SessionClaimRegistryEntry | null {
    const entry = this.entries.get(this.key(sessionId, claimId)) ?? null;
    if (!entry) return null;
    if (new Date(entry.expiresAt).getTime() <= now.getTime()) {
      this.entries.delete(this.key(sessionId, claimId));
      return null;
    }
    return entry;
  }

  prune(now = new Date()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (new Date(entry.expiresAt).getTime() <= now.getTime()) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private key(sessionId: string, claimId: string): string {
    return `${sessionId}:${claimId}`;
  }
}

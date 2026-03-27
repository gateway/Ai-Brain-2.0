import { queryRows } from "../db/client.js";

interface ProvenanceAuditRow {
  readonly reference_name: string;
  readonly orphan_count: string | number;
}

export interface ProvenanceAuditReferenceSummary {
  readonly referenceName: string;
  readonly orphanCount: number;
}

export interface ProvenanceAuditSummary {
  readonly checkedAt: string;
  readonly totalOrphans: number;
  readonly references: readonly ProvenanceAuditReferenceSummary[];
  readonly status: "clean" | "needs_reconsolidation";
}

export async function runLooseProvenanceAudit(): Promise<ProvenanceAuditSummary> {
  const rows = await queryRows<ProvenanceAuditRow>(
    `
      SELECT reference_name, orphan_count
      FROM episodic_loose_provenance_audit
      ORDER BY reference_name ASC
    `
  );

  const references = rows.map((row) => ({
    referenceName: row.reference_name,
    orphanCount: Number(row.orphan_count)
  }));
  const totalOrphans = references.reduce((sum, row) => sum + row.orphanCount, 0);

  return {
    checkedAt: new Date().toISOString(),
    totalOrphans,
    references,
    status: totalOrphans > 0 ? "needs_reconsolidation" : "clean"
  };
}

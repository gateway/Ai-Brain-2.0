export interface ReportCompletenessInputSection {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
}

export interface ReportCompletenessScore {
  readonly score: number;
  readonly requiredSectionCoverageRate: number;
  readonly sectionSourceTrailCoverageRate: number;
  readonly missingSections: readonly string[];
  readonly unsupportedSections: readonly string[];
}

export function scoreReportCompleteness(params: {
  readonly requiredSections: readonly string[];
  readonly sections: readonly ReportCompletenessInputSection[];
}): ReportCompletenessScore {
  const sectionsById = new Map(params.sections.map((section) => [section.id, section]));
  const missingSections = params.requiredSections.filter((sectionId) => !sectionsById.has(sectionId));
  const presentRequired = params.requiredSections.filter((sectionId) => sectionsById.has(sectionId));
  const unsupportedSections = params.sections
    .filter((section) => section.evidenceCount <= 0 || section.sourceTrailCount <= 0)
    .map((section) => section.id);
  const requiredSectionCoverageRate =
    params.requiredSections.length === 0 ? 1 : Number((presentRequired.length / params.requiredSections.length).toFixed(4));
  const sectionSourceTrailCoverageRate =
    params.sections.length === 0
      ? 0
      : Number((params.sections.filter((section) => section.sourceTrailCount > 0).length / params.sections.length).toFixed(4));
  const score = Number(((requiredSectionCoverageRate * 0.65) + (sectionSourceTrailCoverageRate * 0.35)).toFixed(4));
  return {
    score,
    requiredSectionCoverageRate,
    sectionSourceTrailCoverageRate,
    missingSections,
    unsupportedSections
  };
}

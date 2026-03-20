"use client";

import { useId, useState } from "react";

type SourceIntent = "owner_bootstrap" | "ongoing_folder_monitor" | "historical_archive" | "project_source";

const INTENT_RECOMMENDATIONS: Record<
  SourceIntent,
  {
    readonly label: string;
    readonly monitorEnabled: boolean;
    readonly guidance: string;
  }
> = {
  owner_bootstrap: {
    label: "Owner bootstrap",
    monitorEnabled: false,
    guidance: "Keep monitoring off. This lane is for a carefully reviewed seed set, not a continuously watched folder."
  },
  ongoing_folder_monitor: {
    label: "Ongoing folder monitor",
    monitorEnabled: true,
    guidance: "Recommended: monitoring on. Use this for active notes or OpenClaw-style folders that should stay current."
  },
  historical_archive: {
    label: "Historical archive",
    monitorEnabled: false,
    guidance: "Recommended: monitoring off. Archives are usually scanned and imported once, then re-run manually when needed."
  },
  project_source: {
    label: "Project source",
    monitorEnabled: true,
    guidance: "Recommended: monitoring on. Project folders usually benefit from automatic scans and incremental re-import."
  }
};

export function SourceMonitorIntentFields({
  defaultIntent,
  defaultMonitorEnabled
}: {
  readonly defaultIntent: SourceIntent;
  readonly defaultMonitorEnabled: boolean;
}) {
  const [intent, setIntent] = useState<SourceIntent>(defaultIntent);
  const [monitorEnabled, setMonitorEnabled] = useState<boolean>(defaultMonitorEnabled);
  const checkboxId = useId();
  const recommendation = INTENT_RECOMMENDATIONS[intent];

  return (
    <>
      <label className="grid gap-2 md:max-w-sm">
        <span className="text-sm font-medium text-slate-100">Source intent</span>
        <select
          name="source_intent"
          value={intent}
          onChange={(event) => {
            const nextIntent = event.target.value as SourceIntent;
            setIntent(nextIntent);
            setMonitorEnabled(INTENT_RECOMMENDATIONS[nextIntent].monitorEnabled);
          }}
          className="h-11 rounded-[18px] border border-white/12 bg-white/6 px-4 text-sm text-white outline-none ring-0"
        >
          {Object.entries(INTENT_RECOMMENDATIONS).map(([value, config]) => (
            <option key={value} value={value}>
              {config.label}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/4 px-4 py-3 text-sm text-slate-200">
          <input type="checkbox" name="include_subfolders" defaultChecked className="size-4" />
          Include subfolders
        </label>
        <label htmlFor={checkboxId} className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/4 px-4 py-3 text-sm text-slate-200">
          <input
            id={checkboxId}
            type="checkbox"
            name="monitor_enabled"
            checked={monitorEnabled}
            onChange={(event) => setMonitorEnabled(event.target.checked)}
            className="size-4"
          />
          Monitor after import
        </label>
        <div className="rounded-[18px] border border-cyan-300/16 bg-cyan-300/10 px-4 py-3 text-sm leading-6 text-cyan-50">
          {recommendation.guidance}
        </div>
      </div>
    </>
  );
}

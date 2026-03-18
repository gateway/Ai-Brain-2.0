import type { OpsRelationshipGraph } from "@/lib/brain-runtime";

interface PositionedNode {
  readonly id: string;
  readonly name: string;
  readonly entityType: string;
  readonly degree: number;
  readonly mentionCount: number;
  readonly isSelected: boolean;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

function polar(cx: number, cy: number, radius: number, angle: number): { readonly x: number; readonly y: number } {
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius
  };
}

function buildHref(basePath: string, baseQuery: URLSearchParams, entityName: string): string {
  const next = new URLSearchParams(baseQuery);
  next.set("entity", entityName);
  return `${basePath}?${next.toString()}`;
}

function normalizeEntityType(entityType: string): string {
  return entityType.trim().toLowerCase();
}

function entityTone(entityType: string): {
  readonly fill: string;
  readonly stroke: string;
  readonly glow: string;
  readonly chip: string;
} {
  const normalized = normalizeEntityType(entityType);

  if (normalized.includes("person") || normalized.includes("user") || normalized.includes("human")) {
    return {
      fill: "rgba(251,191,36,0.16)",
      stroke: "rgba(217,119,6,0.74)",
      glow: "rgba(251,191,36,0.30)",
      chip: "bg-amber-100 text-amber-950 border-amber-300/70"
    };
  }

  if (normalized.includes("place") || normalized.includes("location") || normalized.includes("geo")) {
    return {
      fill: "rgba(45,212,191,0.16)",
      stroke: "rgba(13,148,136,0.74)",
      glow: "rgba(45,212,191,0.28)",
      chip: "bg-teal-100 text-teal-950 border-teal-300/70"
    };
  }

  if (normalized.includes("project") || normalized.includes("task") || normalized.includes("work")) {
    return {
      fill: "rgba(96,165,250,0.16)",
      stroke: "rgba(59,130,246,0.74)",
      glow: "rgba(96,165,250,0.28)",
      chip: "bg-sky-100 text-sky-950 border-sky-300/70"
    };
  }

  if (normalized.includes("org") || normalized.includes("company") || normalized.includes("business")) {
    return {
      fill: "rgba(248,113,113,0.14)",
      stroke: "rgba(220,38,38,0.70)",
      glow: "rgba(248,113,113,0.24)",
      chip: "bg-rose-100 text-rose-950 border-rose-300/70"
    };
  }

  if (normalized.includes("artifact") || normalized.includes("document") || normalized.includes("file")) {
    return {
      fill: "rgba(196,181,253,0.16)",
      stroke: "rgba(139,92,246,0.74)",
      glow: "rgba(196,181,253,0.28)",
      chip: "bg-violet-100 text-violet-950 border-violet-300/70"
    };
  }

  return {
    fill: "rgba(148,163,184,0.14)",
    stroke: "rgba(71,85,105,0.60)",
    glow: "rgba(148,163,184,0.20)",
    chip: "bg-slate-100 text-slate-900 border-slate-300/70"
  };
}

function computeLayout(graph: OpsRelationshipGraph): readonly PositionedNode[] {
  const width = 1080;
  const height = 720;
  const center = { x: width / 2, y: height / 2 };
  const nodes = [...graph.nodes].sort((left, right) => {
    const selectedDelta = Number(right.isSelected) - Number(left.isSelected);
    if (selectedDelta !== 0) {
      return selectedDelta;
    }

    const degreeDelta = right.degree - left.degree;
    if (degreeDelta !== 0) {
      return degreeDelta;
    }

    return right.mentionCount - left.mentionCount;
  });

  if (nodes.length === 0) {
    return [];
  }

  const selected = nodes.find((node) => node.isSelected);
  if (selected) {
    const neighbors = nodes.filter((node) => node.id !== selected.id);
    const inner = neighbors.slice(0, 8);
    const outer = neighbors.slice(8);

    return [
      {
        ...selected,
        x: center.x,
        y: center.y,
        radius: 34
      },
      ...inner.map((node, index) => {
        const point = polar(center.x, center.y, 190, (Math.PI * 2 * index) / Math.max(inner.length, 1) - Math.PI / 2);
        return {
          ...node,
          ...point,
          radius: 18 + Math.min(node.degree, 4) * 2
        };
      }),
      ...outer.map((node, index) => {
        const point = polar(center.x, center.y, 280, (Math.PI * 2 * index) / Math.max(outer.length, 1) - Math.PI / 2);
        return {
          ...node,
          ...point,
          radius: 15 + Math.min(node.degree, 3)
        };
      })
    ];
  }

  const hub = nodes[0];
  const ring = nodes.slice(1);
  const inner = ring.slice(0, 6);
  const outer = ring.slice(6);

  return [
    {
      ...hub,
      x: center.x,
      y: center.y,
      radius: 32
    },
    ...inner.map((node, index) => {
      const point = polar(center.x, center.y, 190, (Math.PI * 2 * index) / Math.max(inner.length, 1) - Math.PI / 2);
      return {
        ...node,
        ...point,
        radius: 18 + Math.min(node.degree, 4) * 2
      };
    }),
    ...outer.map((node, index) => {
      const point = polar(center.x, center.y, 300, (Math.PI * 2 * index) / Math.max(outer.length, 1) - Math.PI / 2);
      return {
        ...node,
        ...point,
        radius: 14 + Math.min(node.degree, 3)
      };
    })
  ];
}

function labelAnchor(x: number, centerX: number): "start" | "end" {
  return x >= centerX ? "start" : "end";
}

export function RelationshipGraph({
  graph,
  basePath,
  baseQuery
}: {
  readonly graph: OpsRelationshipGraph;
  readonly basePath: string;
  readonly baseQuery: URLSearchParams;
}) {
  const width = 920;
  const height = 620;
  const centerX = width / 2;
  const layout = computeLayout(graph);
  const byId = new Map(layout.map((node) => [node.id, node] as const));
  const legendItems = [
    { label: "People", tone: entityTone("person") },
    { label: "Places", tone: entityTone("place") },
    { label: "Projects", tone: entityTone("project") },
    { label: "Orgs", tone: entityTone("org") },
    { label: "Artifacts", tone: entityTone("artifact") }
  ] as const;

  if (layout.length === 0) {
    return (
      <div className="rounded-[28px] border border-dashed border-slate-900/15 bg-white/70 p-10 text-center text-sm text-slate-500">
        No active relationship graph data for this namespace and time window yet.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[32px] border border-slate-900/10 bg-[linear-gradient(180deg,_rgba(255,255,255,0.98)_0%,_rgba(246,240,230,0.94)_100%)] p-4 shadow-[0_24px_70px_rgba(70,56,22,0.12)]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.34em] text-slate-500">Graph atlas</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {graph.selectedEntity ? `Centered on ${graph.selectedEntity}.` : "Weighted by degree, mentions, and active edges."} Click a node to refocus.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {legendItems.map((item) => (
            <span key={item.label} className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${item.tone.chip}`}>
              {item.label}
            </span>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full">
        <defs>
          <linearGradient id="graphEdge" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(15,23,42,0.14)" />
            <stop offset="100%" stopColor="rgba(217,119,6,0.30)" />
          </linearGradient>
          <marker id="graphArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(71,85,105,0.42)" />
          </marker>
          <filter id="graphGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="8" result="blur" />
            <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0.28 0 1 0 0 0.21 0 0 1 0 0.10 0 0 0 0.35 0" />
          </filter>
        </defs>
        <rect x="0" y="0" width={width} height={height} rx="30" fill="rgba(255,255,255,0.76)" />
        <rect
          x="0"
          y="0"
          width={width}
          height={height}
          rx="30"
          fill="url(#graphEdge)"
          opacity="0.08"
        />
        <circle cx={width - 140} cy={112} r={112} fill="rgba(255,183,77,0.12)" />
        <circle cx={140} cy={height - 112} r={132} fill="rgba(20,184,166,0.10)" />
        <circle cx={width / 2} cy={height / 2} r={210} fill="rgba(15,23,42,0.025)" />

        {graph.edges.map((edge, index) => {
          const source = byId.get(edge.subjectId);
          const target = byId.get(edge.objectId);
          if (!source || !target) {
            return null;
          }

          const midX = (source.x + target.x) / 2;
          const midY = (source.y + target.y) / 2;
          const diffX = target.x - source.x;
          const diffY = target.y - source.y;
          const distance = Math.max(Math.hypot(diffX, diffY), 1);
          const bend = Math.min(52, 18 + distance * 0.08);
          const controlX = midX + ((-diffY / distance) * bend * (index % 2 === 0 ? 1 : -1));
          const controlY = midY + ((diffX / distance) * bend * (index % 2 === 0 ? 1 : -1));
          const path = `M ${source.x} ${source.y} Q ${controlX} ${controlY} ${target.x} ${target.y}`;

          return (
            <g key={edge.id}>
              <path
                d={path}
                fill="none"
                stroke="url(#graphEdge)"
                strokeWidth={1.5 + Math.min(edge.confidence, 1) * 2}
                strokeLinecap="round"
                markerEnd="url(#graphArrow)"
              />
              <rect
                x={midX - 40}
                y={midY - 13}
                width={80}
                height={26}
                rx={13}
                fill="rgba(255,255,255,0.92)"
                stroke="rgba(15,23,42,0.08)"
              />
              <text x={midX} y={midY + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill="#334155">
                {edge.predicate}
              </text>
            </g>
          );
        })}

        {layout.map((node) => {
          const tone = entityTone(node.entityType);
          const href = buildHref(basePath, baseQuery, node.name);
          const anchor = labelAnchor(node.x, centerX);
          const labelX = anchor === "start" ? node.x + node.radius + 14 : node.x - node.radius - 14;

          return (
            <g key={node.id} className="transition-transform">
              {node.isSelected ? (
                <circle cx={node.x} cy={node.y} r={node.radius + 18} fill={tone.glow} filter="url(#graphGlow)" />
              ) : null}
              <a href={href}>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={node.radius}
                  fill={node.isSelected ? "rgba(15,23,42,0.94)" : tone.fill}
                  stroke={node.isSelected ? "rgba(251,191,36,0.86)" : tone.stroke}
                  strokeWidth={node.isSelected ? 3.5 : 1.8}
                />
                {!node.isSelected ? (
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.radius + 8}
                    fill="transparent"
                    stroke={tone.stroke}
                    strokeOpacity={0.24}
                    strokeWidth={1}
                  />
                ) : null}
                <text
                  x={node.x}
                  y={node.y + 4}
                  textAnchor="middle"
                  fontSize="11"
                  fill={node.isSelected ? "#fff" : "#0f172a"}
                  fontWeight="600"
                >
                  {Math.max(node.degree, 1)}
                </text>
              </a>
              <text
                x={labelX}
                y={node.y - 4}
                textAnchor={anchor}
                fontSize="13"
                fontWeight="600"
                fill="#0f172a"
              >
                {node.name}
              </text>
              <text
                x={labelX}
                y={node.y + 14}
                textAnchor={anchor}
                fontSize="11"
                fill="#64748b"
              >
                {node.entityType} · mentions {node.mentionCount}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

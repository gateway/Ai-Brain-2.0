"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition, type LayoutOptions, type StylesheetCSS } from "cytoscape";
import type { NodeSingular } from "cytoscape";
import type { OpsRelationshipGraph, OpsRelationshipGraphEdge, OpsRelationshipGraphNode } from "@/lib/brain-runtime";

type GraphDepth = 1 | 2 | "all";
type DensityMode = "compact" | "balanced" | "spread";
type DetailMode = "overview" | "detail";

function truncateLabel(label: string, maxLength: number): string {
  const normalized = label.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeEntityType(entityType: string): string {
  return entityType.trim().toLowerCase();
}

function isSyntheticClusterId(nodeId: string): boolean {
  return nodeId.startsWith("cluster:");
}

function densityMultiplier(mode: DensityMode): number {
  switch (mode) {
    case "compact":
      return 0.88;
    case "balanced":
      return 0.96;
    case "spread":
      return 1.06;
    default:
      return 1;
  }
}

function entityPalette(entityType: string): {
  readonly fill: string;
  readonly stroke: string;
  readonly glow: string;
  readonly chip: string;
} {
  const normalized = normalizeEntityType(entityType);

  if (normalized.includes("person") || normalized.includes("user") || normalized.includes("human") || normalized === "self") {
    return {
      fill: "#f59e0b",
      stroke: "#fcd34d",
      glow: "rgba(245, 158, 11, 0.22)",
      chip: "border-amber-400/20 bg-amber-400/10 text-amber-100"
    };
  }

  if (normalized.includes("place") || normalized.includes("location") || normalized.includes("geo")) {
    return {
      fill: "#14b8a6",
      stroke: "#5eead4",
      glow: "rgba(20, 184, 166, 0.20)",
      chip: "border-teal-400/20 bg-teal-400/10 text-teal-100"
    };
  }

  if (normalized.includes("project") || normalized.includes("task") || normalized.includes("work")) {
    return {
      fill: "#38bdf8",
      stroke: "#7dd3fc",
      glow: "rgba(56, 189, 248, 0.20)",
      chip: "border-sky-400/20 bg-sky-400/10 text-sky-100"
    };
  }

  if (normalized.includes("org") || normalized.includes("company") || normalized.includes("business")) {
    return {
      fill: "#f43f5e",
      stroke: "#fda4af",
      glow: "rgba(244, 63, 94, 0.20)",
      chip: "border-rose-400/20 bg-rose-400/10 text-rose-100"
    };
  }

  if (normalized === "cluster") {
    return {
      fill: "#1e293b",
      stroke: "#64748b",
      glow: "rgba(100, 116, 139, 0.16)",
      chip: "border-slate-500/20 bg-slate-500/10 text-slate-200"
    };
  }

  return {
    fill: "#94a3b8",
    stroke: "#cbd5e1",
    glow: "rgba(148, 163, 184, 0.18)",
    chip: "border-slate-500/20 bg-slate-500/10 text-slate-200"
  };
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function relationshipStatusLabel(edge: OpsRelationshipGraphEdge): string {
  const normalized = edge.status?.trim().toLowerCase() ?? "";
  if (normalized === "historical" || normalized === "superseded" || Boolean(edge.validUntil)) {
    return "historical";
  }
  if (normalized === "reopened") {
    return "reopened";
  }
  return "active";
}

function buildAdjacency(graph: OpsRelationshipGraph): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();

  for (const edge of graph.edges) {
    const subject = adjacency.get(edge.subjectId) ?? new Set<string>();
    const object = adjacency.get(edge.objectId) ?? new Set<string>();
    subject.add(edge.objectId);
    object.add(edge.subjectId);
    adjacency.set(edge.subjectId, subject);
    adjacency.set(edge.objectId, object);
  }

  return adjacency;
}

function visibleNodeIds(graph: OpsRelationshipGraph, focusId: string | null, depth: GraphDepth): Set<string> {
  if (!focusId || depth === "all") {
    return new Set(graph.nodes.map((node) => node.id));
  }

  const adjacency = buildAdjacency(graph);
  const visited = new Set<string>([focusId]);
  let frontier = new Set<string>([focusId]);

  for (let step = 0; step < depth; step += 1) {
    const next = new Set<string>();
    for (const nodeId of frontier) {
      for (const neighborId of adjacency.get(nodeId) ?? []) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          next.add(neighborId);
        }
      }
    }
    frontier = next;
  }

  return visited;
}

function nodeById(graph: OpsRelationshipGraph, id: string | null): OpsRelationshipGraphNode | null {
  if (!id || isSyntheticClusterId(id)) {
    return null;
  }
  return graph.nodes.find((node) => node.id === id) ?? null;
}

function edgeCountForNode(graph: OpsRelationshipGraph, nodeId: string | null): number {
  if (!nodeId || isSyntheticClusterId(nodeId)) {
    return 0;
  }
  return graph.edges.filter((edge) => edge.subjectId === nodeId || edge.objectId === nodeId).length;
}

function visibleLeafClusters(
  nodes: readonly OpsRelationshipGraphNode[],
  edges: readonly OpsRelationshipGraphEdge[],
  focusId: string | null,
  depth: GraphDepth,
  detailMode: DetailMode
): Map<string, readonly OpsRelationshipGraphNode[]> {
  const visible = visibleNodeIds({ namespaceId: "", selectedEntity: undefined, nodes, edges }, focusId, depth);
  const visibleNodes = nodes.filter((node) => visible.has(node.id));

  if (focusId || depth !== "all" || detailMode === "detail" || visibleNodes.length < 14) {
    return new Map();
  }

  const nodesById = new Map(visibleNodes.map((node) => [node.id, node]));
  const neighbors = buildAdjacency({ namespaceId: "", selectedEntity: undefined, nodes, edges });
  const clusters = new Map<string, OpsRelationshipGraphNode[]>();

  for (const node of visibleNodes) {
    if (node.degree !== 1 || node.mentionCount > 1 || node.isSelected) {
      continue;
    }

    const [hubId] = [...(neighbors.get(node.id) ?? [])];
    if (!hubId) {
      continue;
    }
    const hub = nodesById.get(hubId);
    if (!hub || hub.degree < 3) {
      continue;
    }

    const bucket = clusters.get(hubId) ?? [];
    bucket.push(node);
    clusters.set(hubId, bucket);
  }

  for (const [hubId, bucket] of [...clusters.entries()]) {
    if (bucket.length < 2) {
      clusters.delete(hubId);
    }
  }

  return clusters;
}

function makeElements(
  nodes: readonly OpsRelationshipGraphNode[],
  edges: readonly OpsRelationshipGraphEdge[],
  focusId: string | null,
  depth: GraphDepth,
  detailMode: DetailMode
): ElementDefinition[] {
  const visible = visibleNodeIds({ namespaceId: "", selectedEntity: undefined, nodes, edges }, focusId, depth);
  const visibleEdges = edges.filter((edge) => visible.has(edge.subjectId) && visible.has(edge.objectId));
  const visibleNodes = nodes.filter((node) => visible.has(node.id));
  const denseWholeGraph = !focusId && depth === "all" && visibleNodes.length >= 14;
  const clustersByHub = visibleLeafClusters(nodes, edges, focusId, depth, detailMode);
  const clusteredLeafIds = new Set<string>();

  for (const bucket of clustersByHub.values()) {
    for (const node of bucket) {
      clusteredLeafIds.add(node.id);
    }
  }

  const drawableEdges = visibleEdges.filter((edge) => !clusteredLeafIds.has(edge.subjectId) && !clusteredLeafIds.has(edge.objectId));

  return [
    ...visibleNodes
      .filter((node) => !clusteredLeafIds.has(node.id))
      .map<ElementDefinition>((node) => ({
        data: {
          id: node.id,
          label: truncateLabel(node.name, denseWholeGraph ? 18 : 24),
          fullLabel: node.name,
          shortLabel: truncateLabel(node.name, denseWholeGraph ? 16 : 20),
          compactLabel:
            denseWholeGraph && node.degree <= 1 && node.mentionCount <= 1 && !node.isSelected
              ? ""
              : truncateLabel(node.name, denseWholeGraph ? 13 : 16),
          entityType: node.entityType,
          degree: node.degree,
          mentionCount: node.mentionCount,
          color: entityPalette(node.entityType).fill,
          stroke: entityPalette(node.entityType).stroke,
          glow: entityPalette(node.entityType).glow,
          isCluster: false,
          size:
            (denseWholeGraph ? 22 : 28) +
            Math.min(node.degree, 8) * (denseWholeGraph ? 2.4 : 3) +
            Math.min(node.mentionCount, 20) * (denseWholeGraph ? 0.2 : 0.35)
        },
        classes: node.id === focusId ? "focused" : ""
      })),
    ...[...clustersByHub.entries()].map<ElementDefinition>(([hubId, bucket]) => ({
      data: {
        id: `cluster:${hubId}`,
        label: `+${bucket.length}`,
        fullLabel: `${bucket.length} nearby nodes`,
        shortLabel: `+${bucket.length}`,
        compactLabel: `+${bucket.length}`,
        entityType: "cluster",
        degree: 1,
        mentionCount: bucket.length,
        color: entityPalette("cluster").fill,
        stroke: entityPalette("cluster").stroke,
        glow: entityPalette("cluster").glow,
        isCluster: true,
        hubId,
        size: Math.min(36, 18 + bucket.length * 3)
      },
      classes: "cluster"
    })),
    ...drawableEdges.map<ElementDefinition>((edge) => ({
      data: {
        id: edge.id,
        source: edge.subjectId,
        target: edge.objectId,
        label: focusId && (edge.subjectId === focusId || edge.objectId === focusId) ? edge.predicate : "",
        confidence: edge.confidence,
        width: 1.6 + Math.min(edge.confidence, 1) * 2.4
      }
    })),
    ...[...clustersByHub.entries()].map<ElementDefinition>(([hubId]) => ({
      data: {
        id: `cluster-edge:${hubId}`,
        source: hubId,
        target: `cluster:${hubId}`,
        label: "",
        confidence: 0.4,
        width: 1.2
      },
      classes: "cluster-edge"
    }))
  ];
}

function applyNodeLabels(cy: Core, detailMode: DetailMode, focusId: string | null): void {
  const fullLabelMode = detailMode === "detail" || cy.zoom() >= 1.08;

  cy.nodes().forEach((node) => {
    const nodeId = node.id();
    const isFocused = nodeId === focusId;
    const isHovered = node.hasClass("hovered");
    const isCluster = Boolean(node.data("isCluster"));

    let label = "";
    if (fullLabelMode || isHovered || isFocused) {
      label = String(node.data("fullLabel") ?? "");
    } else {
      label = String(node.data("compactLabel") ?? node.data("shortLabel") ?? "");
    }

    if (isCluster && !fullLabelMode && !isHovered) {
      label = String(node.data("shortLabel") ?? "");
    }

    node.data("displayLabel", label);
  });
}

function layoutForState(
  focusId: string | null,
  depth: GraphDepth,
  visibleNodeCount: number,
  visibleEdgeCount: number,
  density: DensityMode,
  detailMode: DetailMode
): LayoutOptions {
  const densityScale = densityMultiplier(density);

  if (focusId && depth !== "all") {
    const crowdedFocus = visibleNodeCount >= 10;
    return {
      name: "breadthfirst",
      roots: [focusId],
      directed: false,
      animate: true,
      fit: true,
      padding: (crowdedFocus ? 112 : 96) * densityScale,
      spacingFactor: (depth === 1 ? (crowdedFocus ? 2.6 : 2.1) : crowdedFocus ? 2.2 : 1.8) * densityScale,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true
    };
  }

  const denseWholeGraph = visibleNodeCount >= 14 || visibleEdgeCount >= 16;
  if (!focusId && depth === "all" && denseWholeGraph && detailMode === "overview") {
    return {
      name: "concentric",
      animate: true,
      fit: true,
      padding: 88 * densityScale,
      avoidOverlap: true,
      minNodeSpacing: 38 * densityScale,
      spacingFactor: 1.02 * densityScale,
      levelWidth: () => 2.2,
      concentric: (node: NodeSingular) => {
        const isCluster = Boolean(node.data("isCluster"));
        if (isCluster) {
          return 1;
        }
        const degree = Number(node.data("degree") ?? 0);
        const mentions = Number(node.data("mentionCount") ?? 0);
        return degree * 5 + Math.min(mentions, 8);
      }
    } as unknown as LayoutOptions;
  }

  const repulsion = (6200 + visibleNodeCount * 300 + visibleEdgeCount * 140) * densityScale;
  const idealEdgeLength = (118 + Math.min(visibleNodeCount, 28) * (denseWholeGraph ? 3.4 : 2)) * densityScale;

  return {
    name: "cose",
    animate: true,
    randomize: true,
    padding: (denseWholeGraph ? 118 : 88) * densityScale,
    nodeRepulsion: repulsion,
    idealEdgeLength,
    edgeElasticity: denseWholeGraph ? 0.08 : 0.16,
    gravity: denseWholeGraph ? 0.05 : 0.14,
    nestingFactor: 0.8,
    componentSpacing: (denseWholeGraph ? 220 : 130) * densityScale,
    nodeOverlap: denseWholeGraph ? 24 : 12,
    nodeDimensionsIncludeLabels: true,
    numIter: denseWholeGraph ? 2600 : 1500,
    initialTemp: denseWholeGraph ? 260 : 180,
    coolingFactor: denseWholeGraph ? 0.95 : 0.94,
    minTemp: 1
  };
}

export function RelationshipGraph({ graph }: { readonly graph: OpsRelationshipGraph }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const initialFocusId = useMemo(
    () => graph.nodes.find((node) => node.isSelected)?.id ?? null,
    [graph.nodes]
  );
  const detailModeRef = useRef<DetailMode>(initialFocusId ? "detail" : "overview");
  const preserveViewportRef = useRef(false);
  const viewportRef = useRef<{ readonly zoom: number; readonly pan: { readonly x: number; readonly y: number } } | null>(null);
  const [focusId, setFocusId] = useState<string | null>(initialFocusId);
  const [depth, setDepth] = useState<GraphDepth>(focusId ? 2 : "all");
  const [density, setDensity] = useState<DensityMode>("balanced");
  const [detailMode, setDetailMode] = useState<DetailMode>(focusId ? "detail" : "overview");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const focusNode = nodeById(graph, focusId);
  const selectedEdge = graph.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const visibleIds = useMemo(() => visibleNodeIds(graph, focusId, depth), [graph, focusId, depth]);
  const visibleNodeCount = [...visibleIds].length;
  const visibleEdgeCount = graph.edges.filter((edge) => visibleIds.has(edge.subjectId) && visibleIds.has(edge.objectId)).length;
  const rootLabel = focusNode?.name ?? "whole atlas";

  useEffect(() => {
    detailModeRef.current = detailMode;
  }, [detailMode]);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    const elements = makeElements(graph.nodes, graph.edges, focusId, depth, detailMode);
    const graphStyles = [
      {
        selector: "node",
        style: {
          label: "data(displayLabel)",
          "background-color": "data(color)",
          "border-color": "data(stroke)",
          "border-width": 2,
          width: "data(size)",
          height: "data(size)",
          color: "#f8fafc",
          "text-wrap": "wrap",
          "text-max-width": 110,
          "font-size": 11,
          "text-valign": "center",
          "text-halign": "center",
          "min-zoomed-font-size": 9,
          "overlay-opacity": 0,
          "text-outline-color": "#020617",
          "text-outline-width": 3
        }
      },
      {
        selector: "node.cluster",
        style: {
          "border-style": "dashed",
          "font-size": 10,
          color: "#cbd5e1"
        }
      },
      {
        selector: "node.focused",
        style: {
          "border-width": 4,
          "border-color": "#fef08a"
        }
      },
      {
        selector: "edge",
        style: {
          label: "data(label)",
          width: "data(width)",
          "line-color": "rgba(148, 163, 184, 0.55)",
          "target-arrow-color": "rgba(148, 163, 184, 0.55)",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          color: "#cbd5e1",
          "font-size": 10,
          "text-background-color": "rgba(2, 6, 23, 0.88)",
          "text-background-opacity": 1,
          "text-background-padding": 4,
          "text-border-color": "rgba(255,255,255,0.05)",
          "text-border-opacity": 1,
          "text-border-width": 1
        }
      },
      {
        selector: "edge.cluster-edge",
        style: {
          "line-style": "dashed",
          "target-arrow-shape": "none",
          "line-color": "rgba(148, 163, 184, 0.28)"
        }
      },
      {
        selector: "edge:selected",
        style: {
          "line-color": "#67e8f9",
          "target-arrow-color": "#67e8f9"
        }
      }
    ] as unknown as StylesheetCSS[];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: graphStyles,
      minZoom: 0.26,
      maxZoom: 2.4
    });

    cy.one("layoutstop", () => {
      const preservedViewport = preserveViewportRef.current ? viewportRef.current : null;
      if (preservedViewport) {
        cy.zoom(preservedViewport.zoom);
        cy.pan(preservedViewport.pan);
        preserveViewportRef.current = false;
      } else {
        const denseWholeGraph = !focusId && visibleNodeCount >= 14;
        const padding = focusId && depth !== "all" ? 96 : denseWholeGraph ? 118 : 84;
        cy.fit(cy.elements(), padding);
        if (!focusId) {
          cy.zoom(Math.min(cy.zoom(), denseWholeGraph ? 0.96 : 0.98));
        }
      }
      applyNodeLabels(cy, detailMode, focusId);
    });

    cy.layout({
      ...layoutForState(focusId, depth, visibleNodeCount, visibleEdgeCount, density, detailMode),
      fit: false
    } as LayoutOptions).run();

    cy.on("tap", "node", (event) => {
      const node = event.target;
      if (Boolean(node.data("isCluster"))) {
        const hubId = String(node.data("hubId") ?? "");
        if (hubId) {
          setFocusId(hubId);
          setDepth(1);
          setDetailMode("detail");
          setSelectedEdgeId(null);
        }
        return;
      }

      setFocusId(node.id());
      setDepth(1);
      setDetailMode("detail");
      setSelectedEdgeId(null);
    });

    cy.on("tap", "edge", (event) => {
      setSelectedEdgeId(event.target.id());
    });

    cy.on("tap", (event) => {
      if (event.target === cy) {
        setSelectedEdgeId(null);
      }
    });

    cy.on("mouseover", "node", (event) => {
      event.target.addClass("hovered");
      applyNodeLabels(cy, detailMode, focusId);
    });

    cy.on("mouseout", "node", (event) => {
      event.target.removeClass("hovered");
      applyNodeLabels(cy, detailMode, focusId);
    });

    cy.on("zoom", () => {
      const nextMode = cy.zoom() >= 1.08 ? "detail" : "overview";
      applyNodeLabels(cy, nextMode, focusId);
      if (focusId || depth !== "all" || nextMode === detailModeRef.current) {
        return;
      }
      viewportRef.current = {
        zoom: cy.zoom(),
        pan: cy.pan()
      };
      preserveViewportRef.current = true;
      detailModeRef.current = nextMode;
      setDetailMode(nextMode);
    });

    cyRef.current = cy;

    return () => {
      viewportRef.current = {
        zoom: cy.zoom(),
        pan: cy.pan()
      };
      cy.destroy();
      cyRef.current = null;
    };
  }, [graph, focusId, depth, density, detailMode, visibleNodeCount, visibleEdgeCount]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }

    cy.batch(() => {
      cy.edges().unselect();
      if (selectedEdgeId) {
        const edge = cy.getElementById(selectedEdgeId);
        if (edge.nonempty()) {
          edge.select();
        }
      }
    });
  }, [selectedEdgeId]);

  function resetToRoot(): void {
    setFocusId(initialFocusId);
    setSelectedEdgeId(null);
    setDepth(initialFocusId ? 2 : "all");
    setDetailMode(initialFocusId ? "detail" : "overview");
  }

  function untangleGraph(): void {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.layout(layoutForState(focusId, depth, visibleNodeCount, visibleEdgeCount, density, detailMode)).run();
    setSelectedEdgeId(null);
  }

  function showWholeGraph(): void {
    setDepth("all");
    setDetailMode("overview");
    setSelectedEdgeId(null);
    window.requestAnimationFrame(() => {
      const cy = cyRef.current;
      if (!cy) {
        return;
      }
      cy.animate({
        fit: { eles: cy.elements(), padding: 72 },
        duration: 260
      });
    });
  }

  function expandFocus(): void {
    if (!focusId) {
      showWholeGraph();
      return;
    }
    setDepth((current) => {
      if (current === 1) {
        return 2;
      }
      return "all";
    });
    setDetailMode("detail");
    setSelectedEdgeId(null);
  }

  function recenterFocus(): void {
    if (!focusId || !cyRef.current) {
      return;
    }
    const node = cyRef.current.getElementById(focusId);
    if (node.nonempty()) {
      cyRef.current.animate({
        center: { eles: node },
        zoom: Math.max(cyRef.current.zoom(), 1.15),
        duration: 260
      });
    }
  }

  if (graph.nodes.length === 0) {
    return (
      <div className="rounded-[28px] border border-dashed border-white/10 bg-white/5 p-10 text-center text-sm text-slate-400">
        No active relationship graph data for this namespace and time window yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.34em] text-slate-400">Interactive graph atlas</p>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-300">
            Start wide, then zoom or click inward for full labels. In the wide atlas, tiny leaf nodes collapse into nearby clusters so the core relationship structure stays readable.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1">
            {(["compact", "balanced", "spread"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setDensity(option)}
                className={`rounded-full px-3 py-1.5 text-xs uppercase tracking-[0.22em] transition ${
                  density === option
                    ? "border border-cyan-400/20 bg-cyan-400/14 text-cyan-100"
                    : "text-slate-300 hover:bg-white/6"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
          <span className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200">
            root {rootLabel}
          </span>
          <button
            type="button"
            onClick={expandFocus}
            className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-100 transition hover:border-cyan-400/30 hover:bg-cyan-400/15"
          >
            Expand
          </button>
          <button
            type="button"
            onClick={recenterFocus}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:border-white/14 hover:bg-white/8"
          >
            Recenter
          </button>
          <button
            type="button"
            onClick={showWholeGraph}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:border-white/14 hover:bg-white/8"
          >
            Show whole atlas
          </button>
          <button
            type="button"
            onClick={untangleGraph}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:border-white/14 hover:bg-white/8"
          >
            Untangle
          </button>
          <button
            type="button"
            onClick={resetToRoot}
            className="rounded-full border border-lime-300/20 bg-lime-300/8 px-4 py-2 text-sm text-lime-100 transition hover:border-lime-300/28 hover:bg-lime-300/12"
          >
            Reset root
          </button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_340px]">
        <div className="overflow-hidden rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,_rgba(9,13,22,0.98)_0%,_rgba(7,11,18,0.98)_100%)] p-3 shadow-[0_24px_80px_rgba(0,0,0,0.24)]">
          <div className="mb-3 flex flex-wrap gap-2 px-2 pt-2 text-[11px] uppercase tracking-[0.24em] text-slate-400">
            <span className="rounded-full border border-white/8 bg-white/5 px-3 py-1">visible nodes {visibleNodeCount}</span>
            <span className="rounded-full border border-white/8 bg-white/5 px-3 py-1">visible edges {visibleEdgeCount}</span>
            <span className="rounded-full border border-white/8 bg-white/5 px-3 py-1">
              depth {depth === "all" ? "full" : `${depth}-hop`}
            </span>
            <span className="rounded-full border border-white/8 bg-white/5 px-3 py-1">density {density}</span>
            <span className="rounded-full border border-white/8 bg-white/5 px-3 py-1">
              {detailMode === "detail" ? "full labels" : "overview labels"}
            </span>
          </div>
          <div ref={containerRef} className="h-[680px] w-full rounded-[24px] bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.05),transparent_28%),linear-gradient(180deg,_rgba(2,6,23,0.94)_0%,_rgba(6,10,18,0.98)_100%)]" />
        </div>

        <div className="space-y-4">
          <div className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.98)_0%,_rgba(8,11,20,0.98)_100%)] p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.34em] text-slate-500">Focus node</p>
            <h3 className="mt-3 text-2xl font-semibold tracking-tight text-white">{focusNode?.name ?? "Whole graph"}</h3>
            <div className="mt-4 flex flex-wrap gap-2">
              {focusNode ? (
                <>
                  <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${entityPalette(focusNode.entityType).chip}`}>
                    {focusNode.entityType}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200">
                    degree {focusNode.degree}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200">
                    mentions {focusNode.mentionCount}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200">
                    edges {edgeCountForNode(graph, focusNode.id)}
                  </span>
                </>
              ) : (
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200">all visible</span>
              )}
            </div>
            <p className="mt-4 text-sm leading-7 text-slate-300">
              Hover a node for its full label, click to re-root, and zoom in to reveal the finer leaf structure hidden in the overview.
            </p>
          </div>

          <div className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.98)_0%,_rgba(8,11,20,0.98)_100%)] p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.34em] text-slate-500">Selected edge</p>
            {selectedEdge ? (
              <div className="mt-3 space-y-3">
                <h4 className="text-lg font-semibold text-white">
                  {selectedEdge.subjectName} <span className="text-amber-200">{selectedEdge.predicate}</span> {selectedEdge.objectName}
                </h4>
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200">
                    confidence {formatConfidence(selectedEdge.confidence)}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200">
                    {relationshipStatusLabel(selectedEdge)}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200">
                    from {new Date(selectedEdge.validFrom).toLocaleDateString()}
                  </span>
                  {selectedEdge.validUntil ? (
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200">
                      until {new Date(selectedEdge.validUntil).toLocaleDateString()}
                    </span>
                  ) : null}
                </div>
                <p className="text-sm leading-7 text-slate-300">
                  This edge is relationship memory in the current graph window, with canonical cleanup and temporal status applied before it reaches the atlas.
                </p>
              </div>
            ) : (
              <p className="mt-3 text-sm leading-7 text-slate-300">Click an edge to inspect its predicate, confidence, and activation time.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

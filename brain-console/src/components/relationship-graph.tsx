"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition, type StylesheetCSS } from "cytoscape";
import type { OpsRelationshipGraph, OpsRelationshipGraphEdge, OpsRelationshipGraphNode } from "@/lib/brain-runtime";

type GraphDepth = 1 | 2 | "all";

function normalizeEntityType(entityType: string): string {
  return entityType.trim().toLowerCase();
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

function makeElements(
  nodes: readonly OpsRelationshipGraphNode[],
  edges: readonly OpsRelationshipGraphEdge[],
  focusId: string | null,
  depth: GraphDepth
): ElementDefinition[] {
  const visible = visibleNodeIds({ namespaceId: "", selectedEntity: undefined, nodes, edges }, focusId, depth);
  const visibleEdges = edges.filter((edge) => visible.has(edge.subjectId) && visible.has(edge.objectId));

  return [
    ...nodes
      .filter((node) => visible.has(node.id))
      .map<ElementDefinition>((node) => ({
        data: {
          id: node.id,
          label: node.name,
          entityType: node.entityType,
          degree: node.degree,
          mentionCount: node.mentionCount,
          color: entityPalette(node.entityType).fill,
          stroke: entityPalette(node.entityType).stroke,
          glow: entityPalette(node.entityType).glow,
          size: 28 + Math.min(node.degree, 8) * 3 + Math.min(node.mentionCount, 20) * 0.35
        },
        classes: node.id === focusId ? "focused" : ""
      })),
    ...visibleEdges.map<ElementDefinition>((edge) => ({
      data: {
        id: edge.id,
        source: edge.subjectId,
        target: edge.objectId,
        label: edge.predicate,
        confidence: edge.confidence,
        width: 1.6 + Math.min(edge.confidence, 1) * 2.4
      }
    }))
  ];
}

function nodeById(graph: OpsRelationshipGraph, id: string | null): OpsRelationshipGraphNode | null {
  if (!id) {
    return null;
  }
  return graph.nodes.find((node) => node.id === id) ?? null;
}

function edgeCountForNode(graph: OpsRelationshipGraph, nodeId: string | null): number {
  if (!nodeId) {
    return 0;
  }
  return graph.edges.filter((edge) => edge.subjectId === nodeId || edge.objectId === nodeId).length;
}

export function RelationshipGraph({ graph }: { readonly graph: OpsRelationshipGraph }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const initialFocusId = useMemo(
    () => graph.nodes.find((node) => node.isSelected)?.id ?? null,
    [graph.nodes]
  );
  const [focusId, setFocusId] = useState<string | null>(initialFocusId);
  const [depth, setDepth] = useState<GraphDepth>(focusId ? 1 : "all");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const focusNode = nodeById(graph, focusId);
  const selectedEdge = graph.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const visibleIds = useMemo(() => visibleNodeIds(graph, focusId, depth), [graph, focusId, depth]);
  const visibleNodeCount = [...visibleIds].length;
  const visibleEdgeCount = graph.edges.filter((edge) => visibleIds.has(edge.subjectId) && visibleIds.has(edge.objectId)).length;
  const rootLabel = focusNode?.name ?? "whole atlas";

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    const elements = makeElements(graph.nodes, graph.edges, focusId, depth);
    const graphStyles = [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "background-color": "data(color)",
          "border-color": "data(stroke)",
          "border-width": 2,
          width: "data(size)",
          height: "data(size)",
          color: "#f8fafc",
          "text-wrap": "wrap",
          "text-max-width": 120,
          "font-size": 12,
          "font-family": "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          "text-valign": "center",
          "text-halign": "center",
          "overlay-opacity": 0,
          "text-outline-color": "#020617",
          "text-outline-width": 3
        }
      },
      {
        selector: "node.focused",
        style: {
          "border-width": 4,
          "border-color": "#fef08a",
          "shadow-blur": 28,
          "shadow-color": "#67e8f9",
          "shadow-opacity": 0.25
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
          "font-family": "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          "text-background-color": "rgba(2, 6, 23, 0.88)",
          "text-background-opacity": 1,
          "text-background-padding": 4,
          "text-border-color": "rgba(255,255,255,0.05)",
          "text-border-opacity": 1,
          "text-border-width": 1
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
      layout: {
        name: "cose",
        animate: true,
        fit: true,
        padding: 56,
        nodeRepulsion: 8200,
        idealEdgeLength: 130,
        edgeElasticity: 0.18
      },
      style: graphStyles
    });

    cy.on("tap", "node", (event) => {
      const node = event.target;
      const nextId = node.id();
      setFocusId(nextId);
      setSelectedEdgeId(null);
      setDepth(1);
    });

    cy.on("tap", "edge", (event) => {
      setSelectedEdgeId(event.target.id());
    });

    cy.on("tap", (event) => {
      if (event.target === cy) {
        setSelectedEdgeId(null);
      }
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [graph, focusId, depth]);

  function resetToRoot(): void {
    setFocusId(initialFocusId);
    setSelectedEdgeId(null);
    setDepth(initialFocusId ? 1 : "all");
  }

  function showWholeGraph(): void {
    setDepth("all");
    setSelectedEdgeId(null);
    window.requestAnimationFrame(() => {
      const cy = cyRef.current;
      if (!cy) {
        return;
      }
      cy.animate({
        fit: { eles: cy.elements(), padding: 56 },
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
            Start wide, click a node like Steve to re-root around it, expand its neighborhood, then reset back to the primary graph.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
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
              Click a node to tighten the graph around it. Expand steps outward from the current focus, then reset back to the initial root when you want the original view again.
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
                    {new Date(selectedEdge.validFrom).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-sm leading-7 text-slate-300">
                  This edge is active relationship memory in the current graph window, not a speculative visualization edge.
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

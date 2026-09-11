import type { Card } from "../shared/types.js";

export function buildTreeGeometry(cards: Card[]) {
  const children = new Map<string, Card[]>();
  for (const card of cards) {
    if (!card.parent_card_id) continue;
    const siblings = children.get(card.parent_card_id) ?? [];
    siblings.push(card);
    children.set(card.parent_card_id, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const nodes: { card: Card; x: number; y: number; depth: number }[] = [];
  const seen = new Set<string>();
  let leaf = 0;
  const walk = (card: Card, depth: number): number => {
    seen.add(card.id);
    const xs: number[] = [];
    for (const child of children.get(card.id) ?? []) if (!seen.has(child.id)) xs.push(walk(child, depth + 1));
    const x = xs.length ? (xs[0]! + xs[xs.length - 1]!) / 2 : leaf++ * 56;
    nodes.push({ card, x, y: depth * 64, depth });
    return x;
  };
  const root = cards.find(card => !card.parent_card_id);
  if (root) walk(root, 0);
  return { nodes: nodes.sort((a, b) => a.depth - b.depth || a.x - b.x), width: Math.max(0, ...nodes.map(node => node.x)), height: Math.max(0, ...nodes.map(node => node.y)) };
}

export type TreeGeometry = ReturnType<typeof buildTreeGeometry>;

export function treeFrameSize(graph: { width: number; height: number }, availableWidth: number, availableHeight: number) {
  // Leave room around the tree and for the controls; keep large trees navigable in a bounded landscape frame.
  const maxWidth = Math.max(1, Math.min(480, availableWidth - 48));
  const height = Math.max(1, Math.min(Math.max(160, graph.height + 96), 300, availableHeight - 48, maxWidth / 1.25));
  const width = Math.min(maxWidth, Math.max(280, graph.width + 64, height * 1.25));
  return { width, height };
}

export function treeSurface(geometry: TreeGeometry, width: number, height: number, compact: boolean, zoom = 1) {
  // Extra space on BOTH ends allows even an outermost branch to stay centered.
  const graphWidth = geometry.width * zoom, graphHeight = geometry.height * zoom;
  const canvasWidth = compact ? graphWidth + width : Math.max(width, graphWidth + 64);
  const canvasHeight = compact ? graphHeight + height : Math.max(height, graphHeight + 64);
  return { width: canvasWidth, height: canvasHeight, offsetX: (canvasWidth - graphWidth) / 2, offsetY: (canvasHeight - graphHeight) / 2 };
}

export function treeClippedEdges(graph: { width: number; height: number }, offsetX: number, viewport: { width: number; height: number; left: number; top: number }, offsetY = 32) {
  return {
    left: offsetX - 20 < viewport.left - 1,
    right: offsetX + graph.width + 20 > viewport.left + viewport.width + 1,
    top: offsetY - 20 < viewport.top - 1,
    bottom: offsetY + graph.height + 20 > viewport.top + viewport.height + 1,
  };
}

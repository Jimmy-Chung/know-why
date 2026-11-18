import type { Card } from "../shared/types.js";

export const TREE_COLUMN = 56;
export const TREE_LEVEL = 64;

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
    const x = xs.length ? (xs[0]! + xs[xs.length - 1]!) / 2 : leaf++ * TREE_COLUMN;
    nodes.push({ card, x, y: depth * TREE_LEVEL, depth });
    return x;
  };
  for (const card of cards) if (!card.parent_card_id) walk(card, 0);
  // Retain disconnected cards from older or partially restored sessions.
  const ids = new Set(cards.map(card => card.id));
  for (const card of cards) if (card.parent_card_id && !ids.has(card.parent_card_id)) walk(card, 0);
  for (const card of cards) if (!seen.has(card.id)) walk(card, 0);
  return { nodes: nodes.sort((a, b) => a.depth - b.depth || a.x - b.x), width: Math.max(0, ...nodes.map(node => node.x)), height: Math.max(0, ...nodes.map(node => node.y)) };
}

export type TreeGeometry = ReturnType<typeof buildTreeGeometry>;

// 画布取景框固定尺寸：树在框内平移/缩放（见 treeSurface 生成的内层画布），
// 框本身不随图增长——否则宽高会随分支数与节点数变大，逐步侵占左侧卡片区。
// 只受可用空间约束：窄窗口下自适应收缩，但始终保持 landscape。
const FRAME_WIDTH = 280;
const FRAME_HEIGHT = 224;
export function treeFrameSize(availableWidth: number, availableHeight: number) {
  const maxWidth = Math.max(1, Math.min(480, availableWidth - 48));
  const height = Math.max(1, Math.min(FRAME_HEIGHT, availableHeight - 48));
  const width = Math.min(maxWidth, Math.max(FRAME_WIDTH, height * 1.25));
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

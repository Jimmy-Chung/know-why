import type { Card } from "../shared/types.js";

export type SelectCard = (cardId: string | null, reference?: { sourceCardId: string }) => void;
export interface TreeReference { id: number; sourceCardId: string; targetCardId: string }
export const REFERENCE_TRACE_MS = 2800;

export function isCrossBranchReference(cards: Card[], sourceId: string, targetId: string): boolean {
  const byId = new Map(cards.map(card => [card.id, card]));
  const source = byId.get(sourceId), target = byId.get(targetId);
  if (!source || !target || sourceId === targetId || source.conversation_id !== target.conversation_id) return false;
  const hasAncestor = (id: string, ancestorId: string) => {
    const seen = new Set<string>();
    let card = byId.get(id);
    while (card && !seen.has(card.id)) {
      if (card.id === ancestorId) return true;
      seen.add(card.id);
      card = card.parent_card_id ? byId.get(card.parent_card_id) : undefined;
    }
    return false;
  };
  return !hasAncestor(sourceId, targetId) && !hasAncestor(targetId, sourceId);
}

export function referenceCurve(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const bend = Math.min(40, distance * .25);
  return `M ${from.x} ${from.y} Q ${(from.x + to.x) / 2 - dy / distance * bend} ${(from.y + to.y) / 2 + dx / distance * bend} ${to.x} ${to.y}`;
}

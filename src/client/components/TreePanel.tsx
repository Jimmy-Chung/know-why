import React, { useMemo, useState } from "react";
import type { Card } from "../../shared/types.js";

interface TreePanelProps {
  cards: Card[];
  currentCardId: string | null;
  onSelect: (cardId: string) => void;
}

// 纯节点分支树：SVG 圆形节点 + 曲线连线。
// 主节点在下方（沿用原型方向），父在上、子在下。
export function TreePanel({ cards, currentCardId, onSelect }: TreePanelProps) {
  const [hover, setHover] = useState<{ cardId: string; x: number; y: number } | null>(null);

  // 构建树结构
  const root = cards.find((c) => !c.parent_card_id) || null;
  const layout = useMemo(() => {
    if (!root) return { nodes: [], edges: [] };
    // 简单层级布局：DFS，按深度分 y，按顺序分 x
    const nodes: { id: string; x: number; y: number; card: Card; depth: number }[] = [];
    const edges: { from: string; to: string }[] = [];
    const width = 140;
    const xStep = 70;
    let xCounter = 0;
    const walk = (card: Card, depth: number): number => {
      const children = cards.filter((c) => c.parent_card_id === card.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
      const childXs: number[] = [];
      for (const ch of children) {
        const cx = walk(ch, depth + 1);
        childXs.push(cx);
      }
      let x: number;
      if (childXs.length === 0) {
        x = xCounter * xStep;
        xCounter++;
      } else {
        x = childXs.reduce((s, p) => s + p, 0) / childXs.length;
      }
      nodes.push({ id: card.id, x, y: depth * 70, card, depth });
      return x;
    };
    walk(root, 0);
    // 边
    for (const c of cards) {
      if (c.parent_card_id) edges.push({ from: c.parent_card_id, to: c.id });
    }
    // 居中：找最小 x，整体偏移
    const xs = nodes.map((n) => n.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    return { nodes: nodes.map((n) => ({ ...n, x: n.x - minX })), edges, width: maxX - minX };
  }, [cards, root]);

  if (!root) return <div className="tree-panel"><div className="tree-svg" /></div>;

  // 当前路径节点集合（从当前到根）
  const pathIds = new Set<string>();
  let cur = cards.find((c) => c.id === currentCardId) || null;
  while (cur) {
    pathIds.add(cur.id);
    cur = cur.parent_card_id ? cards.find((c) => c.id === cur!.parent_card_id) || null : null;
  }

  const nodeMap = new Map(layout.nodes.map((n) => [n.id, n]));
  const svgWidth = Math.max(160, (layout.width || 0) + 60);
  const svgHeight = (layout.nodes.length ? Math.max(...layout.nodes.map((n) => n.y)) : 0) + 40;

  return (
    <div className="tree-panel">
      <svg className="tree-svg" viewBox={`-20 0 ${svgWidth} ${svgHeight}`} preserveAspectRatio="xMidYMid meet">
        {layout.edges.map((e, i) => {
          const from = nodeMap.get(e.from);
          const to = nodeMap.get(e.to);
          if (!from || !to) return null;
          const onPath = pathIds.has(e.from) && pathIds.has(e.to);
          // 曲线：父在下、子在上？沿用原型：主节点在下，即根在底。这里 y 越大越靠下。
          // 从父到子的曲线
          const x1 = from.x;
          const y1 = from.y;
          const x2 = to.x;
          const y2 = to.y;
          const midY = (y1 + y2) / 2;
          return (
            <path
              key={i}
              className={`branch-line ${onPath ? "on-path" : ""}`}
              d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
            />
          );
        })}
        {layout.nodes.map((n) => {
          const isCurrent = n.id === currentCardId;
          const isRoot = !n.card.parent_card_id;
          const onPath = pathIds.has(n.id);
          return (
            <circle
              key={n.id}
              className={`node-dot ${onPath ? "on-path" : ""} ${isCurrent ? "active" : ""} ${isRoot ? "is-root" : ""}`}
              cx={n.x}
              cy={n.y}
              r={isRoot ? 12 : 9}
              onClick={() => onSelect(n.id)}
              onMouseEnter={(e) => setHover({ cardId: n.id, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </svg>
      {hover && (
        <div
          className="tree-tooltip"
          style={{ left: 8, top: 4 }}
        >
          {cards.find((c) => c.id === hover.cardId)?.title || "卡片"}
        </div>
      )}
    </div>
  );
}

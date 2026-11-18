import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Card } from "../../shared/types.js";
import { buildTreeGeometry, TREE_COLUMN, TREE_LEVEL } from "../tree-geometry.js";
import { Icon } from "./ui/Icon.js";

interface MentionGraphProps {
  cards: Card[];
  selected: string[];
  matches: Card[];
  activeIndex: number;
  closing: boolean;
  onHighlight: (index: number) => void;
  editing: boolean;
  onEdit: () => void;
  onApply: () => void;
  onSelect: (id: string, shift: boolean) => void;
  onClose: () => void;
}

export function MentionGraph({ cards, selected, matches, activeIndex, closing, editing, onEdit, onApply, onHighlight, onSelect, onClose }: MentionGraphProps) {
  const layout = useMemo(() => buildTreeGeometry(cards), [cards]);
  const positions = useMemo(() => new Map(layout.nodes.map(node => [node.card.id, node])), [layout]);
  const matchIndex = useMemo(() => new Map(matches.map((card, i) => [card.id, i])), [matches]);
  const included = useMemo(() => new Set(selected), [selected]);
  const [showHelp, setShowHelp] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [detail, setDetail] = useState(false);
  useLayoutEffect(() => {
    const viewport = frame.current!;
    const measure = () => setSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // The overview fits both axes. Detail mode gives every title a readable slot.
  const columns = layout.width / TREE_COLUMN + 1, rows = layout.height / TREE_LEVEL + 1;
  const dense = size.width / columns < 56 || size.height / rows < 36;
  const expanded = dense && detail;
  const width = expanded ? Math.max(size.width, columns * 112) : size.width;
  const height = expanded ? Math.max(size.height, rows * 54) : size.height;
  const stepX = Math.min(120, width / columns), stepY = Math.min(62, height / rows);
  const x = (column: number) => width / 2 + (column - layout.width / 2) / TREE_COLUMN * stepX;
  const y = (row: number) => height / 2 + (row - layout.height / 2) / TREE_LEVEL * stepY;
  const active = matches[activeIndex];
  const activeNode = active && positions.get(active.id);
  const parent = active?.parent_card_id ? positions.get(active.parent_card_id)?.card : null;
  const activeTitle = active && [parent && (parent.title || "主卡片"), active.title || "主卡片"].filter(Boolean).join(" › ");
  const emptyText = !cards.length ? "本会话暂无卡片" : "没有匹配的可选节点";
  const activeX = activeNode && x(activeNode.x), activeY = activeNode && y(activeNode.y);
  useLayoutEffect(() => {
    if (!expanded || activeX === undefined || activeY === undefined) return;
    frame.current?.scrollTo({ left: activeX - size.width / 2, top: activeY - size.height / 2 });
  }, [expanded, activeX, activeY, size]);

  return (
    <section className="mention-picker" aria-label="会话节点图" data-closing={closing} {...{ inert: closing ? "" : undefined }}
      onMouseDown={event => event.preventDefault()}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
      <header className="mention-heading">
        <Icon name="branch" /><strong>会话节点图</strong>
        <button type="button" className="mention-help-toggle" aria-label="引用范围说明" aria-expanded={showHelp}
          aria-controls="mention-help" onClick={() => setShowHelp(value => !value)}><span aria-hidden="true">?</span></button>
        <small aria-live="polite">{editing ? `已选 ${selected.length}` : `${cards.length} 个节点`}</small>
        <div className="mention-actions">
          {!editing && <button type="button" onClick={onEdit}>自选</button>}
          {dense && <button type="button" aria-pressed={expanded} onClick={() => setDetail(!detail)}>{expanded ? "适应全图" : "放大查看"}</button>}
          <button type="button" aria-label="关闭节点图" onClick={onClose}><Icon name="close" /></button>
        </div>
      </header>
      {showHelp && <p id="mention-help" className="mention-help">
        点击节点会引用它和所有后代。Shift + 点击只引用当前节点。用键盘选择时，回车引用整条分支，Shift + 回车只引用当前节点。「自选」中再次选择可移除相应范围，点「完成」保存。
      </p>}
      <div className="mention-viewport" ref={frame}>
        <div id="mention-options" role="listbox" aria-multiselectable="true" aria-label="可引用的会话卡片" className="mention-canvas" style={{ width, height }}>
          <svg className="tree-lines" width={width} height={height} aria-hidden="true">
            {layout.nodes.map(node => {
              const parent = node.card.parent_card_id && positions.get(node.card.parent_card_id);
              if (!parent) return null;
              const middle = (y(parent.y) + y(node.y)) / 2;
              return <path key={node.card.id} className={`branch-line${included.has(parent.card.id) && included.has(node.card.id) ? " on-path" : ""}`} d={`M ${x(parent.x)} ${y(parent.y)} C ${x(parent.x)} ${middle}, ${x(node.x)} ${middle}, ${x(node.x)} ${y(node.y)}`} />;
            })}
          </svg>
          {layout.nodes.map(({ card, x: column, y: row }) => {
            const index = matchIndex.get(card.id);
            const used = included.has(card.id);
            const title = card.title || "主卡片";
            const compact = dense && !expanded;
            return <button type="button" role="option" key={card.id} id={`mention-${card.id}`} aria-selected={used} data-active={card.id === active?.id}
              className={`mention-node${compact ? " compact" : ""}${used ? " used" : ""}`}
              disabled={index === undefined} tabIndex={-1} aria-label={used ? `${title}，已选` : title} title={used ? `${title}（已选）` : title}
              style={{ left: x(column), top: y(row), maxWidth: Math.max(2, stepX - 4), maxHeight: Math.max(2, stepY - 2) }}
              onMouseEnter={() => { if (!expanded && index !== undefined) onHighlight(index); }}
              onClick={event => onSelect(card.id, event.shiftKey)}>
              {used && !compact && <Icon name="check" />}<span>{title}</span>
            </button>;
          })}
        </div>
      </div>
      <footer className="mention-status">
        <span aria-live="polite" title={activeTitle}>{activeTitle || emptyText}</span>
        {editing ? <div className="mention-edit-actions">
          <button type="button" className="mention-done" disabled={!selected.length} onClick={onApply}>完成</button>
          <button type="button" className="mention-cancel" onClick={onClose}>取消</button>
        </div> : active && <small>↑ ↓ 选择 · 回车引用</small>}
      </footer>
    </section>
  );
}

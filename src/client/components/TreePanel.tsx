import React, { useMemo, useState, useRef, useCallback, useLayoutEffect, useEffect } from "react";
import type { Card } from "../../shared/types.js";
import { IconButton } from "./ui/Button.js";
import { TreeReferenceTrace } from "./TreeReferenceTrace.js";
import type { TreeReference } from "../tree-reference.js";
import { buildTreeGeometry, treeFrameSize, treeSurface, treeClippedEdges, type TreeGeometry } from "../tree-geometry.js";

interface TreePanelProps {
  cards: Card[];
  currentCardId: string | null;
  onSelect: (cardId: string) => void;
  // 助手打开时不占网格列；仍复用同一张画布，hover 只改变装饰和工具栏。
  collapsed?: boolean;
  reference?: TreeReference | null;
}

const ZOOM_MIN = 0.5, ZOOM_MAX = 2, ZOOM_STEP = 0.25;

export function TreePanel({ cards, currentCardId, onSelect, collapsed, reference }: TreePanelProps) {
  const layout = useMemo(() => buildTreeGeometry(cards), [cards]);
  const anchorRef = useRef<HTMLElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const content = anchorRef.current?.parentElement;
    if (!content) return;
    const measure = () => setAvailable({ width: content.clientWidth, height: content.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    measure();
    return () => observer.disconnect();
  }, []);
  const frame = treeFrameSize(available.width, available.height);
  const openTimer = useRef<ReturnType<typeof setTimeout>>();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [focusSignal, setFocusSignal] = useState(0);
  const cancelTimers = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = undefined; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = undefined; }
  }, []);
  useEffect(() => cancelTimers, [cancelTimers]);

  const open = useCallback(() => {
    cancelTimers();
    if (expandedRef.current) return;
    expandedRef.current = true;
    setExpanded(true);
  }, [cancelTimers]);
  const close = useCallback(() => {
    cancelTimers();
    if (!expandedRef.current) return;
    expandedRef.current = false;
    setExpanded(false);
  }, [cancelTimers]);

  const enter = useCallback(() => {
    cancelTimers();
    if (!expandedRef.current) openTimer.current = setTimeout(open, 300);
  }, [open, cancelTimers]);
  // relatedTarget 在移出窗口/跨元素时可能缺失；document.mousemove 兜底统一调度关闭
  const leave = (event: React.MouseEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && anchorRef.current?.contains(next)) return;
    cancelTimers();
    closeTimer.current = setTimeout(close, 220);
  };
  useEffect(() => {
    if (!expanded) return;
    const onMove = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) { cancelTimers(); return; }
      if (!closeTimer.current) closeTimer.current = setTimeout(close, 120);
    };
    const outside = (event: PointerEvent) => { if (!anchorRef.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("keydown", escape);
    };
  }, [expanded, cancelTimers, close]);

  return (
    <aside ref={anchorRef}
      style={{ "--tree-frame-width": `${frame.width}px`, "--tree-frame-height": `${frame.height}px` } as React.CSSProperties}
      className={`tree-panel${collapsed ? " tree-panel--collapsed" : ""}${expanded ? " tree-panel--expanded" : ""}`}
      aria-hidden={collapsed || undefined} {...{ inert: collapsed ? "" : undefined }}
      aria-label="探索路径导航" aria-expanded={expanded} tabIndex={0}
      onMouseEnter={enter} onMouseLeave={leave}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault(); open();
        }
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !anchorRef.current?.contains(next)) close();
      }}
      onClickCapture={(event) => {
        // 无 hover 设备：点击显示工具栏，保留节点本身的点击行为。
        if (!window.matchMedia("(hover: none)").matches) return;
        const target = event.target as Element;
        if (!expanded) open();
        else if (!target.closest(".tree-view, .tree-zoom-controls")) close();
      }}>
          <div className="tree-panel-canvas">
            <TreeView layout={layout} currentCardId={currentCardId} onSelect={onSelect} compact zoom={zoom} focusSignal={focusSignal} showEdges={!expanded} centerWholeTree={focusSignal === 0} reference={reference} />
            {expanded && <div className="tree-zoom-controls" role="toolbar" aria-label="分支树缩放">
              <IconButton className="tree-zoom-btn" icon="zoomOut" label="缩小" disabled={zoom <= ZOOM_MIN} onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))} />
              <IconButton className="tree-zoom-btn" icon="focus" label="聚焦当前卡片" onClick={() => { setFocusSignal((v) => v + 1); setZoom(1); }} />
              <IconButton className="tree-zoom-btn" icon="zoomIn" label="放大" disabled={zoom >= ZOOM_MAX} onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))} />
            </div>}
          </div>
    </aside>
  );
}

function TreeView({ layout, currentCardId, onSelect, compact, suspended = false, zoom = 1, focusSignal = 0, showEdges = true, centerWholeTree = false, reference }: {
  layout: TreeGeometry; currentCardId: string | null; onSelect: (id: string) => void; compact: boolean;
  suspended?: boolean; zoom?: number; focusSignal?: number; showEdges?: boolean; centerWholeTree?: boolean;
  reference?: TreeReference | null;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // hover 节点信息卡：悬停某节点时展示其标题与摘要
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const nodeById = useMemo(() => new Map(layout.nodes.map(node => [node.card.id, node])), [layout]);
  const pathIds = new Set<string>();
  let ancestor = currentCardId ? nodeById.get(currentCardId) : undefined;
  while (ancestor && !pathIds.has(ancestor.card.id)) {
    pathIds.add(ancestor.card.id);
    ancestor = ancestor.card.parent_card_id ? nodeById.get(ancestor.card.parent_card_id) : undefined;
  }
  const surface = treeSurface(layout, viewport.width, viewport.height, compact, zoom);
  const edges = treeClippedEdges({ width: layout.width * zoom, height: layout.height * zoom }, surface.offsetX, { ...viewport, ...scroll }, surface.offsetY);
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = viewportRef.current;
    const current = layout.nodes.find(node => node.card.id === currentCardId) ?? layout.nodes[0];
    if (!element || !current) return;
    const fits = centerWholeTree && layout.width * zoom + 48 <= element.clientWidth && layout.height * zoom + 72 <= element.clientHeight;
    const x = fits ? layout.width / 2 : current.x;
    const y = fits ? layout.height / 2 : current.y;
    element.scrollTo({ left: surface.offsetX + x * zoom - element.clientWidth / 2, top: y * zoom + surface.offsetY - element.clientHeight / 2 + (fits ? 12 : 0), behavior: "auto" });
    setScroll({ left: element.scrollLeft, top: element.scrollTop });
  }, [layout, currentCardId, surface.offsetX, surface.offsetY, viewport.height, zoom, focusSignal, centerWholeTree]);
  const stopDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div className={`tree-view${compact ? " tree-view--compact" : ""}`} aria-hidden={suspended || undefined}>
      <div ref={viewportRef} className={`tree-viewport${dragging ? " dragging" : ""}`}
        onScroll={(event) => { setScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }); }}
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse" || event.button !== 0 || (event.target as Element).closest("button")) return;
          const element = event.currentTarget;
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
          element.setPointerCapture(event.pointerId); setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
          event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y);
        }}
        onPointerUp={stopDrag} onPointerCancel={stopDrag}
        onLostPointerCapture={() => { dragRef.current = null; setDragging(false); }}>
        {/* 只缩放分支间距，保留两侧居中空间和节点点击范围。 */}
        <div className="tree-canvas" style={{ width: surface.width, height: surface.height }}>
          <svg className="tree-lines" width={surface.width} height={surface.height} aria-hidden="true">
            {layout.nodes.map(node => {
              const parent = node.card.parent_card_id ? nodeById.get(node.card.parent_card_id) : null;
              if (!parent) return null;
              const x1 = surface.offsetX + parent.x * zoom, y1 = surface.offsetY + parent.y * zoom;
              const x2 = surface.offsetX + node.x * zoom, y2 = surface.offsetY + node.y * zoom;
              const middle = (y1 + y2) / 2;
              return <path key={node.card.id} className={`branch-line${pathIds.has(parent.card.id) && pathIds.has(node.card.id) ? " on-path" : ""}`} d={`M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`} />;
            })}
          </svg>
          {layout.nodes.map(node => {
            const id = node.card.id;
            const isCurrent = id === currentCardId;
            return <button key={id} type="button"
              ref={element => { if (element) buttonsRef.current.set(id, element); else buttonsRef.current.delete(id); }}
              className={`tree-node${isCurrent ? " active" : ""}${!node.card.parent_card_id ? " is-root" : ""}${pathIds.has(id) ? " on-path" : ""}`}
              style={{ left: surface.offsetX + node.x * zoom, top: surface.offsetY + node.y * zoom }}
              tabIndex={suspended ? -1 : 0}
              aria-label={`${node.card.title || "主卡片"}${isCurrent ? "，当前卡片" : ""}`}
              aria-current={isCurrent ? "location" : undefined}
              title={node.card.title || "主卡片"}
              onMouseEnter={() => setHoverNodeId(id)}
              onMouseLeave={() => setHoverNodeId((prev) => prev === id ? null : prev)}
              onFocus={() => setHoverNodeId(id)}
              onBlur={() => setHoverNodeId((prev) => prev === id ? null : prev)}
              onClick={() => { onSelect(id); }}
              onKeyDown={event => {
                let next: typeof node | undefined;
                if (event.key === "ArrowUp") next = node.card.parent_card_id ? nodeById.get(node.card.parent_card_id) : undefined;
                if (event.key === "ArrowDown") next = layout.nodes.find(candidate => candidate.card.parent_card_id === id);
                const row = layout.nodes.filter(candidate => candidate.depth === node.depth);
                const index = row.findIndex(candidate => candidate.card.id === id);
                if (event.key === "ArrowLeft") next = row[index - 1];
                if (event.key === "ArrowRight") next = row[index + 1];
                if (event.key.startsWith("Arrow")) { event.preventDefault(); if (next) buttonsRef.current.get(next.card.id)?.focus(); }
              }}><span className="tree-node-dot" /></button>;
          })}
          {(() => {
            const hn = hoverNodeId ? nodeById.get(hoverNodeId) : undefined;
            if (!hn) return null;
            const card = hn.card;
            return (
              <div
                className="tree-tooltip"
                style={{ left: surface.offsetX + hn.x * zoom, top: surface.offsetY + hn.y * zoom }}
                aria-hidden="true"
              >
                <div className="tree-tooltip-title">{card.title || "主卡片"}</div>
                <div className="tree-tooltip-role">{card.parent_card_id ? "探索分支" : "主卡片"}</div>
              </div>
            );
          })()}
        </div>
      </div>
      {compact && showEdges && Object.entries(edges).map(([edge, clipped]) => clipped && <div key={edge} className={`tree-edge tree-edge--${edge}`} aria-hidden="true" />)}
      {(() => {
        if (!reference || currentCardId !== reference.targetCardId) return null;
        const source = nodeById.get(reference.sourceCardId), target = nodeById.get(reference.targetCardId);
        if (!source || !target) return null;
        const position = (node: typeof source) => ({ x: surface.offsetX + node.x * zoom - scroll.left, y: surface.offsetY + node.y * zoom - scroll.top });
        return <TreeReferenceTrace key={reference.id} from={position(source)} to={position(target)} width={viewport.width} height={viewport.height}
          sourceTitle={source.card.title || "主卡片"} targetTitle={target.card.title || "主卡片"} />;
      })()}
    </div>
  );
}

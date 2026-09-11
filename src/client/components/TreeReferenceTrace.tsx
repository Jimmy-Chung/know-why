import React, { useId } from "react";
import { REFERENCE_TRACE_MS, referenceCurve } from "../tree-reference.js";

// This overlay shares the viewport coordinates, so dragging/zooming never detaches the line from nodes.
export function TreeReferenceTrace({ from, to, width, height, sourceTitle, targetTitle }: {
  from: { x: number; y: number }; to: { x: number; y: number }; width: number; height: number;
  sourceTitle: string; targetTitle: string;
}) {
  const maskId = `reference-${useId().replace(/:/g, "")}`;
  if (width < 40 || height < 40) return null;
  const pin = (point: typeof from) => ({ x: Math.max(16, Math.min(width - 16, point.x)), y: Math.max(16, Math.min(height - 16, point.y)) });
  const start = pin(from), end = pin(to);
  const sourceOutside = start.x !== from.x || start.y !== from.y;
  const targetOutside = end.x !== to.x || end.y !== to.y;
  const path = referenceCurve(sourceOutside ? start : from, targetOutside ? end : to);
  return <svg className="tree-reference-trace" width={width} height={height}
    style={{ "--reference-duration": `${REFERENCE_TRACE_MS}ms` } as React.CSSProperties}
    role="img" aria-label={`跨分支引用：${sourceTitle} → ${targetTitle}`}>
    <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height}>
      <path className="tree-reference-reveal" d={path} pathLength="1" fill="none" stroke="white" strokeWidth="8" strokeDasharray="1" />
    </mask></defs>
    <path className="tree-reference-line" d={path} mask={`url(#${maskId})`} />
    {sourceOutside && <g><circle className="tree-reference-end" cx={start.x} cy={start.y} r="4" />
      <text className="tree-reference-label" x={start.x < width / 2 ? 20 : width - 20} y={Math.max(28, Math.min(height - 8, start.y + 18))} textAnchor={start.x < width / 2 ? "start" : "end"}>来源在画布外</text></g>}
    {targetOutside && <g><circle className="tree-reference-end" cx={end.x} cy={end.y} r="4" />
      <text className="tree-reference-label" x={end.x < width / 2 ? 20 : width - 20} y={Math.max(12, Math.min(height - 8, end.y - 10))} textAnchor={end.x < width / 2 ? "start" : "end"}>目标在画布外</text></g>}
  </svg>;
}

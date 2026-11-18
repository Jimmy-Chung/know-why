import { usePanelPresence } from "../../usePanelPresence.js";
import React, { useState } from "react";
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useHover,
  useInteractions,
  FloatingPortal,
  useRole,
} from "@floating-ui/react";

// 合并多个 ref（子元素自带 ref 与 floating-ui 注入的 reference ref）。
function mergeRefs<T>(...refs: (React.Ref<T> | undefined)[]) {
  return (node: T) => {
    for (const r of refs) {
      if (typeof r === "function") r(node);
      else if (r && typeof r === "object") (r as React.MutableRefObject<T>).current = node;
    }
  };
}

// 共享 Tooltip 原语：hover 触发，延迟 300ms 显示 / 80ms 隐藏（比系统原生 title 快）。
// 自动 flip/shift 防止视口溢出；FloatingPortal 渲染到 body，避免父级 overflow/transform 裁剪。
// cloneElement 注入 ref + hover 事件，调用方无需改原有按钮结构。
// 注意：子元素必须能转发 ref（forwardRef），否则 reference DOM 拿不到、tooltip 不显示。
export function Tooltip({
  content,
  children,
  placement = "top",
  disabled,
}: {
  content: React.ReactNode;
  children: React.ReactElement;
  placement?: "top" | "bottom" | "left" | "right";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const present = usePanelPresence(open);
  const { refs, floatingStyles, context, elements } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { delay: { open: 300, close: 80 }, restMs: 0 });
  const role = useRole(context, { role: "tooltip" });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, role]);

  if (disabled || !content) return children;

  // 保留子元素原有 ref，合并 floating-ui 的 reference ref。
  const childRef = (children as React.ReactElement<{ ref?: React.Ref<unknown> }>).props.ref;
  const referenceProps = getReferenceProps({ ref: mergeRefs(childRef, refs.setReference) });

  return (
    <>
      {React.cloneElement(children, referenceProps as Record<string, unknown>)}
      {present && <FloatingPortal root={elements.reference instanceof Element ? elements.reference.closest("dialog") ?? undefined : undefined}>
          <div
            className="kk-tooltip" data-closing={!open}
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
          >
            {content}
          </div>
      </FloatingPortal>}
    </>
  );
}

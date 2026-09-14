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

// 共享 Tooltip 原语：hover 触发，延迟 300ms 显示 / 80ms 隐藏（比系统原生 title 快）。
// 自动 flip/shift 防止视口溢出；FloatingPortal 渲染到 body，避免父级 overflow/transform 裁剪。
// cloneElement 注入 ref + hover 事件，调用方无需改原有按钮结构。
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
  const { refs, floatingStyles, context } = useFloating({
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

  return (
    <>
      {React.cloneElement(children, getReferenceProps({ ref: refs.setReference }) as Record<string, unknown>)}
      <FloatingPortal>
        {open && (
          <div
            className="kk-tooltip"
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
          >
            {content}
          </div>
        )}
      </FloatingPortal>
    </>
  );
}

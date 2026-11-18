import React, { useLayoutEffect, useRef } from "react";

interface DialogSurfaceProps {
  label: string;
  closing: boolean;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}

export function DialogSurface({ label, closing, onClose, className = "modal", children }: DialogSurfaceProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog ref={ref} className={className} aria-label={label} data-closing={closing}
      onCancel={event => { event.preventDefault(); if (!closing) onClose(); }}
      onClick={event => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !closing) onClose();
      }}>
      <div className="dialog-content" {...{ inert: closing ? "" : undefined }}>{children}</div>
    </dialog>
  );
}

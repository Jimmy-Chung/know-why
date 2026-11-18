import { useLayoutEffect, useState } from "react";

// Retain the last content while its surface exits. Reopening cancels removal.
export function useExitValue<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  useLayoutEffect(() => {
    if (last === value) return;
    if (value !== null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setLast(value);
      return;
    }
    const duration = getComputedStyle(document.documentElement).getPropertyValue("--motion-panel").trim();
    const ms = parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
    const timer = window.setTimeout(() => setLast(null), Number.isFinite(ms) ? ms : 220);
    return () => window.clearTimeout(timer);
  }, [value, last]);
  return value ?? last;
}

export function usePanelPresence(open: boolean) {
  return useExitValue(open ? true : null) !== null;
}

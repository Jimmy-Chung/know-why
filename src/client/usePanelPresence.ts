import { useEffect, useState } from "react";

// Keep the closing panel mounted only for its exit animation. Reopening cancels removal.
export function usePanelPresence(open: boolean) {
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) { setPresent(true); return; }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPresent(false); return;
    }
    const duration = getComputedStyle(document.documentElement).getPropertyValue("--motion-panel").trim();
    const ms = parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
    const timer = window.setTimeout(() => setPresent(false), (Number.isFinite(ms) ? ms : 220) + 30);
    return () => window.clearTimeout(timer);
  }, [open]);
  return open || present;
}

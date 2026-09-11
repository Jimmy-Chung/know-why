import React from "react";

const paths = {
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  arrowUp: <path d="M12 19V5m-6 6 6-6 6 6" />,
  arrowDown: <path d="M12 5v14m-6-6 6 6 6-6" />,
  arrowUpRight: <path d="M7 17 17 7M7 7h10v10" />,
  branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m0-5h5a7 7 0 0 0 7-5"/></>,
  quote: <><path d="M4 6h6v6H5c0 3 1 4 3 5M14 6h6v6h-5c0 3 1 4 3 5"/></>,
  leaf: <><path d="M20 4c-9-1-16 3-16 9a6 6 0 0 0 6 6c6 0 10-7 10-15Z"/><path d="M4 21 15 10m-6 6v-5m0 5h5"/></>,
  assistant: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/></>,
  newChat: <><path d="M20 14a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8Z"/><path d="M12 7v6m-3-3h6"/></>,
  history: <><path d="M3 10a9 9 0 1 1 2 8M3 5v5h5"/><path d="M12 7v5l3 2"/></>,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  attachment: <path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9m-6 12 8-8" />,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
  cards: <><rect x="7" y="7" width="14" height="14" rx="3"/><path d="M17 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"/></>,
  notePlus: <><path d="M12 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7M8 7h6M8 11h4M8 15h2"/><path d="M18 15v6m-3-3h6"/></>,
  knowledge: <><path d="M19 12V3H7a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h5M4 17h8M8 7h7M8 11h5"/><path d="m15 18 2 2 4-5"/></>,
  knowledgeExcluded: <><path d="M19 12V3H7a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h5M4 17h8M8 7h7M8 11h5"/><path d="m15 15 6 6m0-6-6 6"/></>,
  check: <path d="m5 12 4 4L19 6" />,
  trash: <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v6M14 11v6" />,
  zoomOut: <><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M8.5 12h7"/></>,
  zoomIn: <><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M12 8.5v7M8.5 12h7"/></>,
  focus: <><circle cx="12" cy="12" r="7.5"/><path d="M12 3.5v17M3.5 12h17"/></>,
} satisfies Record<string, React.ReactNode>;

export type IconName = keyof typeof paths;
export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return <svg className={`ui-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

import { Icon } from "./Icon.js";
import { IconButton } from "./Button.js";
import React, { useState, useCallback } from "react";

// 复制文本按钮，带「已复制」反馈；主消息流与知识助手共用
export function CopyButton({ text, className = "", iconOnly = false }: { text: string; className?: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  const handleClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 回退：临时 textarea
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);
  if (iconOnly) return <IconButton className={className} onClick={handleClick} icon={copied ? "check" : "copy"} label={copied ? "已复制" : "复制"} />;
  return (
    <button className={`copy-btn ${className}`} onClick={handleClick} aria-label={copied ? "已复制" : "复制"} title="复制文本">
      <Icon name={copied ? "check" : "copy"} />{copied ? "已复制" : "复制"}
    </button>
  );
}

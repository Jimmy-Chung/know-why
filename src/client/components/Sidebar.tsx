import React, { useState } from "react";
import type { ProviderConfig, Conversation } from "../../shared/types.js";

interface SidebarProps {
  conversations: Conversation[];
  currentId: string | null;
  providers: ProviderConfig[];
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  onRenamed: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { conversations, currentId, providers, onNew, onSelect, onDelete, onOpenSettings, onRenamed } = props;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const startRename = (c: Conversation) => {
    setEditingId(c.id);
    setEditValue(c.title);
  };

  const commitRename = async (id: string) => {
    const title = editValue.trim();
    if (title) {
      try {
        await fetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        onRenamed();
      } catch {
        /* ignore */
      }
    }
    setEditingId(null);
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-logo">🌿</span>
        <span>
          know know
          <small>让好奇心，有迹可循。</small>
        </span>
      </div>

      <button className="new-btn" onClick={onNew}>
        ＋ 新建会话 <span style={{ marginLeft: "auto" }}>↗</span>
      </button>

      <div className="eyebrow">你的会话</div>
      <div className="session-list">
        {conversations.length === 0 && (
          <div style={{ padding: "9px 7px", fontSize: 11, color: "var(--muted)" }}>暂无会话</div>
        )}
        {conversations.map((c) => (
          <div key={c.id} className={`session-row ${c.id === currentId ? "current" : ""}`}>
            {editingId === c.id ? (
              <input
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => commitRename(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(c.id);
                  if (e.key === "Escape") setEditingId(null);
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "9px 7px",
                  fontSize: 12,
                  border: "1px solid var(--accent)",
                  borderRadius: 6,
                  background: "var(--surface)",
                }}
              />
            ) : (
              <button onClick={() => onSelect(c.id)} onDoubleClick={() => startRename(c)} title="双击重命名">
                {c.title}
              </button>
            )}
            <button
              className="del"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`删除会话「${c.title}」？可从回收区恢复。`)) onDelete(c.id);
              }}
              title="删除"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="sidebar-bottom">
        <div className="eyebrow">
          模型服务
          <button onClick={onOpenSettings} title="管理 Provider" style={{ fontSize: 11 }}>
            ⚙
          </button>
        </div>
        <div>
          {providers.map((p) => (
            <div key={p.id} className="provider-row">
              <span className="provider-mark">{p.name.charAt(0).toUpperCase()}</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.name}
              </span>
              <small style={{ marginLeft: "auto", fontSize: 10 }}>{p.is_default ? "默认" : p.type}</small>
            </div>
          ))}
          {providers.length === 0 && (
            <div style={{ padding: "8px 6px", fontSize: 11, color: "var(--muted)" }}>未配置 Provider</div>
          )}
        </div>
        <button className="add-provider" onClick={onOpenSettings}>
          ＋ 管理 Provider
        </button>
        <div className="profile">
          <span>J</span>
          <div>
            我的知识空间
            <br />
            <small>个人空间</small>
          </div>
        </div>
      </div>
    </aside>
  );
}

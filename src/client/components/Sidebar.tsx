import { Icon } from "./ui/Icon.js";
import brandIcon from "../assets/know-why.png";
import { Button, IconButton } from "./ui/Button.js";
import React, { useState } from "react";
import { Modal } from "@arco-design/web-react";
import type { ProviderConfig, Conversation } from "../../shared/types.js";

interface SidebarProps {
  collapsed?: boolean;
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
    <aside className="sidebar" id="session-navigation" aria-hidden={props.collapsed || undefined} {...{ inert: props.collapsed ? "" : undefined }} aria-label="会话导航">
      <div className="brand">
        <img className="brand-logo" src={brandIcon} width={40} height={40} alt="" />
        <span>
          <span className="brand-wordmark">KNOW WHY</span>
          <small>沿着知识继续探索</small>
        </span>
      </div>

      <Button className="new-btn" onClick={onNew} icon="plus">新建会话<Icon name="arrowUpRight" /></Button>

      <div className="eyebrow">你的会话</div>
      <div className="session-list">
        {conversations.length === 0 && (
          <div className="sidebar-empty">暂无会话</div>
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
                className="session-rename"
              />
            ) : (
              <button aria-current={c.id === currentId ? "page" : undefined} onClick={() => onSelect(c.id)} onDoubleClick={() => startRename(c)}>
                {c.title}
              </button>
            )}
            <IconButton
              icon="close" label="删除会话"
              className="del"
              onClick={(e) => {
                e.stopPropagation();
                Modal.confirm({
                  title: "删除会话",
                  content: `确定删除会话「${c.title}」？可从回收区恢复。`,
                  okText: "删除",
                  cancelText: "取消",
                  okButtonProps: { status: "danger" },
                  onOk: () => onDelete(c.id),
                });
              }}
            />
          </div>
        ))}
      </div>

      <div className="sidebar-bottom">
        <div className="eyebrow">
          模型服务
          <IconButton onClick={onOpenSettings} icon="settings" label="管理模型服务" />
        </div>
        <div className="provider-list">
          {providers.map((p) => (
            <div key={p.id} className="provider-row">
              <span className="provider-mark">{p.name.charAt(0).toUpperCase()}</span>
              <span className="provider-name">
                {p.name}
              </span>
              <small>{p.is_default ? "默认" : p.type}</small>
            </div>
          ))}
          {providers.length === 0 && (
            <div className="sidebar-empty">未配置模型服务</div>
          )}
        </div>
        <Button variant="ghost" className="add-provider" onClick={onOpenSettings} icon="settings">管理模型服务</Button>
      </div>
    </aside>
  );
}

import { IconButton } from "./ui/Button.js";
import React, { useState } from "react";
import type { ProviderConfig } from "../../shared/types.js";
import { api } from "../api.js";
import { ProviderDialog } from "./ProviderDialog.js";

import { useExitValue } from "../usePanelPresence.js";
import { DialogSurface } from "./ui/DialogSurface.js";

interface SettingsModalProps {
  closing: boolean;
  providers: ProviderConfig[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}

export function SettingsModal({ closing, providers, onClose, onSaved }: SettingsModalProps) {
  const [note, setNote] = useState<{ text: string; kind: "ok" | "err" | "" }>({ text: "", kind: "" });
  // null = 关闭；{ id: null } = 新增；{ id } = 编辑
  const [dialog, setDialog] = useState<{ id: string | null } | null>(null);

  const setDefault = async (id: string) => {
    try {
      await api.setDefaultProvider(id);
      await onSaved();
      setNote({ text: "已设为默认", kind: "ok" });
    } catch (e) {
      setNote({ text: (e as Error).message, kind: "err" });
    }
  };

  const removeProvider = async (p: ProviderConfig) => {
    const ok = window.confirm("确定删除 Provider「" + p.name + "」？已有会话使用此 Provider 时将停用而非级联删除记录。");
    if (!ok) return;
    try {
      await api.deleteProvider(p.id);
      await onSaved();
      setNote({ text: "已删除该 Provider", kind: "ok" });
    } catch (e) {
      setNote({ text: (e as Error).message, kind: "err" });
    }
  };

  const shownDialog = useExitValue(dialog);
  const editingProvider = shownDialog?.id ? providers.find((p) => p.id === shownDialog.id) ?? null : null;

  return (
    <>
      <DialogSurface label="设置" closing={closing} onClose={onClose}>
        <div className="settings" onClick={(e) => e.stopPropagation()}>
          <div className="settings-header">
            <h2>设置</h2>
            <IconButton onClick={onClose} icon="close" label="关闭设置" />
          </div>
          <p>配置模型服务。API Key 由本地服务安全保存，不进入日志。</p>

          <div className="settings-section-title">已配置</div>
          {providers.length === 0 && <p className="settings-description">尚未配置 Provider，点下方按钮添加。</p>}
          {providers.map((p) => (
            <div className="provider-item" key={p.id}>
              <span className="provider-mark">{p.name.charAt(0)}</span>
              <span className="name">
                {p.name}
                <br />
                <small>{typeLabel(p.type)} · {p.default_model || "未设模型"} · {p.has_secret ? "已配置Key" : "未配置Key"}</small>
              </span>
              {p.is_default && <span className="tag">默认</span>}
              <div className="actions">
                <button onClick={() => setDialog({ id: p.id })}>编辑</button>
                <button onClick={() => setDefault(p.id)}>设为默认</button>
                <button className="danger" onClick={() => removeProvider(p)}>删除</button>
              </div>
            </div>
          ))}

          <button className="provider-add" onClick={() => setDialog({ id: null })}>＋ 添加 Provider</button>
          <div className={`settings-note ${note.kind}`}>{note.text}</div>
        </div>
      </DialogSurface>
      {shownDialog && (
        <ProviderDialog
          key={shownDialog.id ?? "new"}
          closing={!dialog}
          provider={editingProvider}
          onClose={() => setDialog(null)}
          onSaved={onSaved}
        />
      )}
    </>
  );
}

function typeLabel(t: string): string {
  if (t === "openai") return "OpenAI";
  if (t === "deepseek") return "DeepSeek";
  if (t === "openrouter") return "OpenRouter";
  return "自定义";
}

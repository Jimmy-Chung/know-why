import React, { useState } from "react";
import type { ProviderConfig, ProviderType } from "../../shared/types.js";
import { api } from "../api.js";

interface SettingsModalProps {
  providers: ProviderConfig[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}

type Tab = "provider" | "search";

export function SettingsModal({ providers, onClose, onSaved }: SettingsModalProps) {
  const [tab, setTab] = useState<Tab>("provider");
  const [note, setNote] = useState<{ text: string; kind: "ok" | "err" | "" }>({ text: "", kind: "" });

  // provider 表单
  const [pType, setPType] = useState<ProviderType>("openai");
  const [pName, setPName] = useState("");
  const [pBase, setPBase] = useState("");
  const [pModel, setPModel] = useState("");
  const [pKey, setPKey] = useState("");
  const [pDefault, setPDefault] = useState(false);

  // 搜索表单
  const [sBase, setSBase] = useState("https://api.tavily.com");
  const [sKey, setSKey] = useState("");
  const [sEnabled, setSEnabled] = useState(true);
  const [backupFile, setBackupFile] = useState("");

  const showNote = (text: string, kind: "ok" | "err") => setNote({ text, kind });
  const clearNote = () => setNote({ text: "", kind: "" });

  // 测试某 provider
  const testProvider = async (id: string) => {
    clearNote();
    setNote({ text: "测试中…", kind: "" });
    try {
      const r = await api.testProvider(id);
      if (r.ok) showNote(r.detail, "ok");
      else showNote(r.detail, "err");
    } catch (e) {
      showNote((e as Error).message, "err");
    }
  };

  // 保存 provider
  const saveProvider = async () => {
    clearNote();
    if (!pName.trim()) {
      showNote("请填写名称", "err");
      return;
    }
    try {
      const p = await api.createProvider({
        type: pType,
        name: pName,
        api_base: pBase,
        default_model: pModel,
        is_default: pDefault,
        capabilities: undefined as any,
      });
      if (pKey.trim()) await api.setProviderSecret(p.id, pKey);
      await onSaved();
      setPName("");
      setPBase("");
      setPModel("");
      setPKey("");
      setPDefault(false);
      showNote("Provider 已保存", "ok");
    } catch (e) {
      showNote((e as Error).message, "err");
    }
  };

  // 设为默认
  const setDefault = async (id: string) => {
    try {
      await api.setDefaultProvider(id);
      await onSaved();
      showNote("已设为默认", "ok");
    } catch (e) {
      showNote((e as Error).message, "err");
    }
  };

  // 删除/停用
  const removeProvider = async (p: ProviderConfig) => {
    const confirm = window.confirm(
      `确定删除 Provider「${p.name}」？${"已有会话使用此 Provider 时将停用而非级联删除记录。"}`,
    );
    if (!confirm) return;
    try {
      await api.deleteProvider(p.id);
      await onSaved();
      showNote("已停用/删除", "ok");
    } catch (e) {
      showNote((e as Error).message, "err");
    }
  };

  // 测试搜索
  const testSearch = async () => {
    clearNote();
    setNote({ text: "测试中…", kind: "" });
    try {
      if (sKey.trim()) {
        await api.setSearchSecret(sKey);
      }
      const r = await api.testSearch();
      if (r.ok) showNote(r.detail, "ok");
      else showNote(r.detail, "err");
    } catch (e) {
      showNote((e as Error).message, "err");
    }
  };

  // 保存搜索配置
  const saveSearch = async () => {
    clearNote();
    try {
      await api.setSearch({ api_base: sBase, has_secret: !!sKey.trim(), enabled: sEnabled });
      if (sKey.trim()) await api.setSearchSecret(sKey);
      showNote("独立搜索配置已保存", "ok");
    } catch (e) {
      showNote((e as Error).message, "err");
    }
  };

  // 备份
  const doBackup = async () => {
    clearNote();
    try {
      const r = await api.backup();
      setBackupFile(r.file);
      showNote("备份完成：" + r.file, "ok");
    } catch (e) {
      showNote((e as Error).message, "err");
    }
  };

  // 导出
  const doExport = async () => {
    clearNote();
    try {
      const data = await api.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "know-know-export.json";
      a.click();
      URL.revokeObjectURL(url);
      showNote("导出完成", "ok");
    } catch (e) {
      showNote((e as Error).message, "err");
    }
  };

  const typeLabel = (t: string) => (t === "openai" ? "OpenAI" : t === "deepseek" ? "DeepSeek" : "自定义");

  return (
    <div className="modal" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>设置</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <p>配置模型服务与独立搜索。API Key 由本地服务安全保存，不进入导出文件或日志。</p>

        <div className="settings-tabs">
          <button className={tab === "provider" ? "selected" : ""} onClick={() => { setTab("provider"); clearNote(); }}>
            Provider 管理
          </button>
          <button className={tab === "search" ? "selected" : ""} onClick={() => { setTab("search"); clearNote(); }}>
            独立搜索与备份
          </button>
        </div>

        {tab === "provider" && (
          <div>
            <div className="eyebrow" style={{ margin: "0 0 8px" }}>已配置</div>
            {providers.length === 0 && (
              <p style={{ fontSize: 12, color: "var(--muted)" }}>尚未配置 Provider，先在下方添加。</p>
            )}
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
                  <button onClick={() => testProvider(p.id)}>测试</button>
                  <button onClick={() => setDefault(p.id)}>设为默认</button>
                  <button className="danger" onClick={() => removeProvider(p)}>删除</button>
                </div>
              </div>
            ))}

            <div className="eyebrow" style={{ margin: "18px 0 8px" }}>添加 Provider</div>
            <label className="field">
              服务类型
              <select value={pType} onChange={(e) => setPType(e.target.value as ProviderType)}>
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
                <option value="custom">自定义兼容接口</option>
              </select>
            </label>
            <div className="field-row">
              <label className="field">
                名称
                <input value={pName} onChange={(e) => setPName(e.target.value)} placeholder="如：我的 OpenAI" />
              </label>
              <label className="field">
                默认模型
                <input value={pModel} onChange={(e) => setPModel(e.target.value)} placeholder={pType === "openai" ? "gpt-4o-mini" : pType === "deepseek" ? "deepseek-chat" : "模型ID"} />
              </label>
            </div>
            <label className="field">
              接口地址（留空走官方默认；自定义必填）
              <input value={pBase} onChange={(e) => setPBase(e.target.value)} placeholder={pType === "custom" ? "https://your-host/v1" : ""} />
            </label>
            <label className="field">
              API Key
              <input type="password" value={pKey} onChange={(e) => setPKey(e.target.value)} placeholder="sk-..." />
            </label>
            <div className="checkbox-row">
              <input type="checkbox" id="pdefault" checked={pDefault} onChange={(e) => setPDefault(e.target.checked)} />
              <label htmlFor="pdefault">设为全局默认（影响新建会话）</label>
            </div>
            <div className="settings-actions">
              <span />
              <button className="save" onClick={saveProvider}>保存 Provider</button>
            </div>
            <div className={`settings-note ${note.kind}`}>{note.text}</div>
          </div>
        )}

        {tab === "search" && (
          <div>
            <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 18 }}>
              独立搜索为没有原生搜索能力的兼容模型提供联网资料，结果交回当前会话模型回答。
              凭据与聊天 Provider 分开管理，不改变会话已锁定的模型。首版接入 Tavily。
            </p>
            <label className="field">
              搜索服务
              <select disabled>
                <option value="tavily">Tavily</option>
              </select>
            </label>
            <label className="field">
              API 地址
              <input value={sBase} onChange={(e) => setSBase(e.target.value)} placeholder="https://api.tavily.com" />
            </label>
            <label className="field">
              API Key
              <input type="password" value={sKey} onChange={(e) => setSKey(e.target.value)} placeholder="tvly-..." />
            </label>
            <div className="checkbox-row">
              <input type="checkbox" id="senabled" checked={sEnabled} onChange={(e) => setSEnabled(e.target.checked)} />
              <label htmlFor="senabled">启用独立搜索</label>
            </div>
            <div className="settings-actions">
              <button className="test" onClick={testSearch}>测试连接</button>
              <button className="save" onClick={saveSearch}>保存搜索配置</button>
            </div>

            <div className="eyebrow" style={{ margin: "22px 0 10px" }}>备份与导出</div>
            <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
              备份为本机 SQLite 副本；导出为结构化 JSON（不含明文密钥）。密钥需单独配置。
            </p>
            <div className="settings-actions">
              <button onClick={doBackup}>立即备份</button>
              <button onClick={doExport}>导出 JSON</button>
            </div>
            {backupFile && <div className="settings-note ok">备份文件：{backupFile}</div>}
            <div className={`settings-note ${note.kind}`}>{note.text}</div>
          </div>
        )}
      </div>
    </div>
  );
}

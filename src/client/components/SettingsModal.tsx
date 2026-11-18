import { IconButton } from "./ui/Button.js";
import React, { useEffect, useState } from "react";
import type { ProviderCapabilities, ProviderConfig, ProviderType } from "../../shared/types.js";
import { api } from "../api.js";

interface SettingsModalProps {
  providers: ProviderConfig[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}

function officialHost(type: ProviderType): string {
  if (type === "openai") return "api.openai.com";
  if (type === "deepseek") return "api.deepseek.com";
  if (type === "openrouter") return "openrouter.ai";
  return "";
}

export function SettingsModal({ providers, onClose, onSaved }: SettingsModalProps) {
  const [note, setNote] = useState<{ text: string; kind: "ok" | "err" | "" }>({ text: "", kind: "" });

  const [modelRefresh, setModelRefresh] = useState<Record<string, { pending: boolean; text: string; failed?: boolean }>>({});
  const refreshModels = async (provider: ProviderConfig) => {
    setModelRefresh(prev => ({ ...prev, [provider.id]: { pending: true, text: "正在刷新模型能力…" } }));
    try {
      const result = await api.getProviderModels(provider.id, provider.default_model, true);
      setModelRefresh(prev => ({ ...prev, [provider.id]: {
        pending: false, failed: !!result.warning,
        text: result.warning || "模型列表与推理能力已刷新",
      } }));
      // 服务端缓存已更新；当前会话重新读取其所选模型的能力。
      window.dispatchEvent(new CustomEvent("kk-model-capabilities-refreshed", { detail: provider.id }));
    } catch {
      setModelRefresh(prev => ({ ...prev, [provider.id]: { pending: false, failed: true, text: "刷新失败，请检查连接后重试。" } }));
    }
  };

  // provider 表单
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pType, setPType] = useState<ProviderType>("openai");
  const [pName, setPName] = useState("");
  const [pBase, setPBase] = useState("");
  const [pModel, setPModel] = useState("");
  const [pKey, setPKey] = useState("");
  const [pDefault, setPDefault] = useState(false);

  // 保存前验证：连接类字段任何改动都会让验证失效
  type VerifyState = { status: "idle" | "pending" | "ok" | "err"; text: string; capabilities?: ProviderCapabilities; resolvedModel?: string };
  const [verify, setVerify] = useState<VerifyState>({ status: "idle", text: "" });
  const [initial, setInitial] = useState<{ type: ProviderType; base: string; model: string } | null>(null);
  useEffect(() => {
    setVerify({ status: "idle", text: "" });
  }, [pType, pBase, pModel, pKey, editingId]);
  const connectionDirty = !initial || pType !== initial.type || pBase !== initial.base || pModel !== initial.model || pKey.trim() !== "";
  const canSave = verify.status === "ok" || (!connectionDirty && !!editingId);

  const resetForm = () => {
    setEditingId(null);
    setPType("openai");
    setPName("");
    setPBase("");
    setPModel("");
    setPKey("");
    setPDefault(false);
    setInitial(null);
    setVerify({ status: "idle", text: "" });
  };

  // 点「编辑」：把现有 provider 字段填入表单，切到编辑模式（type 不可改）
  const startEdit = (p: ProviderConfig) => {
    setEditingId(p.id);
    setPType(p.type);
    setPName(p.name);
    setPBase(p.api_base);
    setPModel(p.default_model);
    setPKey(""); // key 留空表示保持不变
    setPDefault(p.is_default);
    setInitial({ type: p.type, base: p.api_base, model: p.default_model });
    clearNote();
  };


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

  // 保存前验证：只读 /models，不落库、不消耗对话额度
  const doVerify = async () => {
    clearNote();
    if (!pModel.trim()) {
      setVerify({ status: "err", text: "请先填写默认模型" });
      return;
    }
    if (!pKey.trim() && !editingId && pType !== "custom") {
      setVerify({ status: "err", text: "请先填写 API Key" });
      return;
    }
    setVerify({ status: "pending", text: "验证中…" });
    try {
      const r = await api.verifyProvider({
        type: pType,
        api_base: pBase,
        api_key: pKey,
        model: pModel.trim(),
        provider_id: editingId ?? undefined,
      });
      if (r.ok) {
        setVerify({ status: "ok", text: r.detail, capabilities: r.capabilities, resolvedModel: r.resolvedModel });
      } else {
        const extra = r.availableModels?.length ? `（可用示例：${r.availableModels.slice(0, 5).join("、")}）` : "";
        setVerify({ status: "err", text: `${r.detail}${extra}` });
      }
    } catch (e) {
      setVerify({ status: "err", text: (e as Error).message });
    }
  };

  // 保存 provider：新建走 POST，编辑走 PATCH；key 留空表示保持不变
  const saveProvider = async () => {
    clearNote();
    if (!canSave) {
      showNote("请先点击「验证连接」，通过后再保存", "err");
      return;
    }
    if (!pName.trim()) {
      showNote("请填写名称", "err");
      return;
    }
    if (pType === "custom" && !pBase.trim() && !editingId) {
      showNote("自定义接口需填接口地址", "err");
      return;
    }
    try {
      if (editingId) {
        await api.updateProvider(editingId, {
          name: pName,
          api_base: pBase,
          default_model: pModel,
          is_default: pDefault,
          capabilities: verify.status === "ok" ? verify.capabilities : undefined,
        });
        if (pKey.trim()) await api.setProviderSecret(editingId, pKey);
        await onSaved();
        resetForm();
        showNote("Provider 已更新", "ok");
      } else {
        const p = await api.createProvider({
          type: pType,
          name: pName,
          api_base: pBase,
          default_model: pModel,
          is_default: pDefault,
          capabilities: verify.status === "ok" ? verify.capabilities : undefined,
        });
        if (pKey.trim()) await api.setProviderSecret(p.id, pKey);
        await onSaved();
        resetForm();
        showNote("Provider 已保存", "ok");
      }
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

  const typeLabel = (t: string) => (t === "openai" ? "OpenAI" : t === "deepseek" ? "DeepSeek" : t === "openrouter" ? "OpenRouter" : "自定义");

  return (
    <div className="modal" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>设置</h2>
          <IconButton onClick={onClose} icon="close" label="关闭设置" />
        </div>
        <p>配置模型服务。API Key 由本地服务安全保存，不进入日志。</p>

        <div>
            <div className="settings-section-title">已配置</div>
            {providers.length === 0 && (
              <p className="settings-description">尚未配置 Provider，先在下方添加。</p>
            )}
            {providers.map((p) => (
              <div className="provider-item" key={p.id}>
                <span className="provider-mark">{p.name.charAt(0)}</span>
                <span className="name">
                  {p.name}
                  <br />
                  <small>{typeLabel(p.type)} · {p.default_model || "未设模型"} · {p.has_secret ? "已配置Key" : "未配置Key"}</small>
                  {modelRefresh[p.id] && <small className={`provider-refresh-note${modelRefresh[p.id]?.failed ? " failed" : ""}`} role="status">{modelRefresh[p.id]?.text}</small>}
                </span>
                {p.is_default && <span className="tag">默认</span>}
                <div className="actions">
                  <button onClick={() => testProvider(p.id)}>测试</button>
                  <button disabled={modelRefresh[p.id]?.pending} onClick={() => refreshModels(p)} title="按已保存的连接配置重新读取模型列表与推理能力">
                    {modelRefresh[p.id]?.pending ? "刷新中…" : "刷新模型能力"}
                  </button>
                  <button onClick={() => startEdit(p)}>编辑</button>
                  <button onClick={() => setDefault(p.id)}>设为默认</button>
                  <button className="danger" onClick={() => removeProvider(p)}>删除</button>
                </div>
              </div>
            ))}

            <div className="settings-section-title">{editingId ? "编辑 Provider" : "添加 Provider"}</div>
            <label className="field">
              服务类型{editingId ? "（已锁定，不可更改）" : ""}
              <select value={pType} onChange={(e) => setPType(e.target.value as ProviderType)} disabled={!!editingId}>
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
                <option value="openrouter">OpenRouter</option>
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
                <input value={pModel} onChange={(e) => setPModel(e.target.value)} placeholder={pType === "openai" ? "gpt-4o-mini" : pType === "deepseek" ? "deepseek-flash" : "模型ID"} />
              </label>
            </div>
            {pType === "custom" ? (
              <label className="field">
                接口地址（必填）
                <input value={pBase} onChange={(e) => setPBase(e.target.value)} placeholder="https://your-host/v1" />
              </label>
            ) : (
              <p className="settings-description">接口地址：使用官方默认（{officialHost(pType)}），无需填写。</p>
            )}
            <label className="field">
              API Key{editingId ? "（留空保持不变）" : ""}
              <input type="password" value={pKey} onChange={(e) => setPKey(e.target.value)} placeholder={editingId ? "留空保持当前 Key 不变" : "sk-..."} />
            </label>
            <div className="checkbox-row">
              <input type="checkbox" id="pdefault" checked={pDefault} onChange={(e) => setPDefault(e.target.checked)} />
              <label htmlFor="pdefault">设为全局默认（影响新建会话）</label>
            </div>
            <div className="settings-actions">
              {editingId && <button onClick={resetForm}>取消编辑</button>}
              <button className="test" onClick={doVerify} disabled={verify.status === "pending"}>
                {verify.status === "pending" ? "验证中…" : "验证连接"}
              </button>
              <button
                className="save"
                onClick={saveProvider}
                disabled={!canSave}
                title={canSave ? "" : "请先验证连接，通过后再保存"}
              >
                {editingId ? "保存修改" : "保存 Provider"}
              </button>
            </div>
            {verify.status !== "idle" && (
              <div className={`settings-note ${verify.status === "ok" ? "ok" : verify.status === "err" ? "err" : ""}`} role="status">
                {verify.text}
              </div>
            )}
            {verify.status === "ok" && verify.resolvedModel && verify.resolvedModel !== pModel.trim() && (
              <div className="settings-note ok">已按别名匹配到 {verify.resolvedModel}（保存后仍使用你填写的模型名）</div>
            )}
            <div className={`settings-note ${note.kind}`}>{note.text}</div>
          </div>

      </div>
    </div>
  );
}

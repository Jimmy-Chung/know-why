import { IconButton } from "./ui/Button.js";
import React, { useEffect, useState } from "react";
import { DialogSurface } from "./ui/DialogSurface.js";
import type { ProviderCapabilities, ProviderConfig, ProviderType } from "../../shared/types.js";
import { api } from "../api.js";

interface ProviderDialogProps {
  /** null = 新增 */
  closing: boolean;
  provider: ProviderConfig | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

function officialHost(type: ProviderType): string {
  if (type === "openai") return "api.openai.com";
  if (type === "deepseek") return "api.deepseek.com";
  if (type === "openrouter") return "openrouter.ai";
  return "";
}

type VerifyState = {
  status: "idle" | "pending" | "ok" | "err";
  text: string;
  capabilities?: ProviderCapabilities;
  resolvedModel?: string;
};

export function ProviderDialog({ closing, provider, onClose, onSaved }: ProviderDialogProps) {
  const isEdit = !!provider;
  const [pType, setPType] = useState<ProviderType>(provider?.type ?? "openai");
  const [pName, setPName] = useState(provider?.name ?? "");
  const [pBase, setPBase] = useState(provider?.api_base ?? "");
  const [pModel, setPModel] = useState(provider?.default_model ?? "");
  const [pKey, setPKey] = useState("");
  const [pDefault, setPDefault] = useState(provider?.is_default ?? false);
  const [verify, setVerify] = useState<VerifyState>({ status: "idle", text: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 连接相关的任何改动都让上一次验证失效
  useEffect(() => {
    setVerify({ status: "idle", text: "" });
    setError("");
  }, [pType, pBase, pModel, pKey]);

  const canSave = verify.status === "ok" && !saving;

  const doVerify = async () => {
    setError("");
    if (!pModel.trim()) {
      setVerify({ status: "err", text: "请先填写默认模型" });
      return;
    }
    if (!pKey.trim() && !isEdit && pType !== "custom") {
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
        provider_id: provider?.id,
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

  const save = async () => {
    if (!canSave) return;
    if (!pName.trim()) {
      setError("请填写名称");
      return;
    }
    if (pType === "custom" && !pBase.trim()) {
      setError("自定义接口需填接口地址");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const capabilities = verify.capabilities;
      if (provider) {
        await api.updateProvider(provider.id, {
          name: pName,
          api_base: pBase,
          default_model: pModel,
          is_default: pDefault,
          capabilities,
        });
        if (pKey.trim()) await api.setProviderSecret(provider.id, pKey);
      } else {
        const created = await api.createProvider({
          type: pType,
          name: pName,
          api_base: pBase,
          default_model: pModel,
          is_default: pDefault,
          capabilities,
        });
        if (pKey.trim()) await api.setProviderSecret(created.id, pKey);
      }
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogSurface label={isEdit ? "编辑 Provider" : "添加 Provider"} closing={closing} onClose={onClose}>
      <div
        className="settings provider-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h2>{isEdit ? "编辑 Provider" : "添加 Provider"}</h2>
          <IconButton onClick={onClose} icon="close" label="关闭" />
        </div>
        <p>先验证连接，通过后才能保存。API Key 只由本地服务保存，不进入日志。</p>

        <label className="field">
          服务类型{isEdit ? "（已锁定，不可更改）" : ""}
          <select value={pType} onChange={(e) => setPType(e.target.value as ProviderType)} disabled={isEdit}>
            <option value="openai">OpenAI</option>
            <option value="deepseek">DeepSeek</option>
            <option value="openrouter">OpenRouter</option>
            <option value="custom">自定义兼容接口</option>
          </select>
        </label>
        <div className="field-row">
          <label className="field">
            名称
            <input value={pName} onChange={(e) => setPName(e.target.value)} placeholder="如：我的 DeepSeek" />
          </label>
          <label className="field">
            默认模型
            <input
              value={pModel}
              onChange={(e) => setPModel(e.target.value)}
              placeholder={pType === "openai" ? "gpt-4o-mini" : pType === "deepseek" ? "deepseek-flash" : "模型ID"}
            />
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
          API Key{isEdit ? "（留空保持不变）" : ""}
          <input
            type="password"
            value={pKey}
            onChange={(e) => setPKey(e.target.value)}
            placeholder={isEdit ? "留空保持当前 Key 不变" : "sk-..."}
          />
        </label>
        <div className="checkbox-row">
          <input type="checkbox" id="provider-default" checked={pDefault} onChange={(e) => setPDefault(e.target.checked)} />
          <label htmlFor="provider-default">设为全局默认（影响新建会话）</label>
        </div>

        <div className="settings-actions">
          <button className="test" onClick={doVerify} disabled={verify.status === "pending"}>
            {verify.status === "pending" ? "验证中…" : "验证连接"}
          </button>
          <div className="dialog-actions-right">
            <button onClick={onClose} disabled={saving}>取消</button>
            <button className="save" onClick={save} disabled={!canSave} title={canSave ? "" : "请先验证连接，通过后才能保存"}>
              {saving ? "保存中…" : "确定"}
            </button>
          </div>
        </div>
        {verify.status !== "idle" && (
          <div className={`settings-note ${verify.status === "ok" ? "ok" : verify.status === "err" ? "err" : ""}`} role="status">
            {verify.text}
          </div>
        )}
        {error && <div className="settings-note err" role="alert">{error}</div>}
      </div>
    </DialogSurface>
  );
}

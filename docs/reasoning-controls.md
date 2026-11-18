# 1.0 输入框联网与推理设置补充说明

实现与官方文档核对日期：2026-09-07，1.4 增补核对于 2026-11-18。

> 1.4 变更：能力探测从「只认推理档位」扩展到「推理档位 + 上下文窗口 + 输出上限 + 输入模态 + 原生联网」，
> 并让 DeepSeek 的原生搜索真正接上。见文末「1.4 增补」。

## 交互

前景卡片输入框底部并列展示附件、联网与思考设置。联网为自动联网、强制联网、不联网。设置属于当前会话，切换探索卡片保持一致，影响后续发送；已排队的请求使用创建时记录的设置。知识助手、查询规划和摘要等辅助调用继续使用原有默认策略。

手动刷新入口位于“设置 → Provider 管理”的每个已保存 Provider 条目中，显示刷新中、成功或失败状态；刷新后当前会话同步读取更新的能力。输入框不显示刷新按钮，切换 Provider/模型仍会自动读取。

推理默认选项是“模型默认”，表示不传控制参数，不代表关闭。只显示当前 Provider 与模型确认支持的档位；只能开关的模型显示开关；必须推理的模型不提供关闭。能力未知或不支持时保持默认并说明原因。设置保存中禁用发送，失败时保留原设置并显示错误。若旧设置已不在可用选项中，需选回默认或有效档位后发送。

新会话可切换 Provider 和模型；首条消息后两者锁定。切换时推理设置重置为模型默认，联网设置保持。Provider 配置增加 OpenRouter 类型；原来以自定义类型配置 `https://openrouter.ai/api/v1` 的连接自动识别，无需重建。

## 能力读取

`GET /api/providers/:id/models?model=<model-id>&refresh=1`

服务端使用该 Provider 的凭据请求其 `/models`。只返回模型 ID、当前模型的推理能力及可选警告，不返回密钥。返回类型见 `src/shared/reasoning.ts`。

优先读取模型元数据 `reasoning.supported_efforts`、`default_effort`、`mandatory` 和 `supported_parameters`。显式档位列表按网关顺序规范化；`supported_efforts: null` 按 OpenRouter 定义接受网关档位；缺失不推断档位。`mandatory: true` 始终覆盖关闭能力。只有 `supported_parameters: ["reasoning"]` 时，不假定具备全部强度及关闭能力。

OpenAI、DeepSeek 官方模型列表主要提供 ID 等基本信息，未必提供推理档位。此时根据已核实的精确模型 ID 使用本地规则，标记 `source: rules`。规则集中在 `src/server/model-capabilities.ts`，未知模型、未知后缀不根据品牌猜测。DeepSeek 的历史 chat/reasoner 别名只暴露开关，明确版本的 V4 Flash/Pro 提供低、高、最高三档及关闭。新模型如接口无能力元数据，需要根据官方文档扩充规则。

缓存按 Provider ID、配置版本和地址隔离，成功缓存五分钟，失败缓存十五秒；修改地址/凭据及手动刷新均清除缓存；请求超时八秒。不会为了探测能力发起付费聊天或枚举测试所有档位。

## 请求映射与兼容

- OpenRouter：`reasoning.effort`；开关为 `reasoning.enabled`，显式选择时附带 `provider.require_parameters: true`，避免路由到声明不支持请求参数的节点。
- OpenAI Chat Completions：`reasoning_effort`；原生搜索走 Responses 时用 `reasoning.effort`。关闭仅在支持 `none` 的模型发送。
- DeepSeek Chat Completions：`thinking.type: enabled/disabled`；设置档位时附带 `reasoning_effort`，关闭时不附带强度。
- 自定义服务：仅在接口返回兼容的推理能力元数据时发送统一 `reasoning` 对象，否则使用默认。

PATCH 会话设置在服务端再次校验模型能力，拒绝非法档位；执行请求前也校验，防止能力变化后仍提交错误参数。上游仍可能因权限、版本变化或自身实现拒绝请求，届时显示错误，不会无提示改档或切模型。

数据库迁移 `0006_reasoning_default.sql` 将旧会话的 off（原实现是不传参数）转成 default，standard/deep 转成 medium/high。历史消息与 run 不修改。新值 none 才代表显式关闭。

当前不提供独立的 reasoning Token 预算输入；只支持预算而未暴露档位的模型提供默认思考控制，不伪造低中高档位。推理能力和联网能力各自独立，本次没有改变搜索服务优先顺序。

## 验证

- `npm run build`：客户端类型检查与构建。
- `npx tsc -p tsconfig.server.json`：服务端与测试类型检查。
- `npm test`：能力解析、精确档位、未知模型、网络失败、缓存刷新、各 Provider 的实际请求体与流式思考内容。
- `tests/reasoning-http.test.ts`：隔离临时数据库，通过应用 HTTP handler 验证发现能力、保存/重读、无效档位、切模型/Provider 重置、首次发送锁定、已创建 run 保留设置快照。外部请求使用 mock，不消耗真实模型费用。
- 浏览器检查：现有 OpenRouter 连接读取 GLM-5.2 元数据；输入框选中“高”，切换分支保持“高”，检查后恢复原来的模型默认设置。

## 官方参考

- [OpenRouter 推理元数据与统一参数](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [OpenRouter 模型列表](https://openrouter.ai/docs/guides/overview/models)
- [OpenRouter Provider 路由与 require_parameters](https://openrouter.ai/docs/guides/routing/provider-selection)
- [DeepSeek 思考开关与档位](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek 模型列表](https://api-docs.deepseek.com/api/list-models)
- [OpenAI 推理模型](https://developers.openai.com/api/docs/guides/reasoning)
- [GPT-5 与 GPT-5.1 参数说明](https://cdn.openai.com/pdf/47c0215b-8976-4f60-8e13-d69c2ddbc15e/a-practical-guide-to-building-with-gpt-5.pdf)
- [GPT-5.2 参数说明](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)
- [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4)、[GPT-5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)、[GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5)、[GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)、[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)

## 1.4 增补：窗口、模态与原生联网

一次性从 `GET /models` 读取并落库（不递增 `config_version`，避免「探测 → 版本变 → 重探测」循环）：

| 字段 | 来源 | 用途 |
|---|---|---|
| `context_window` / `context_length` | 接口 | 上下文预算、摘要触发线 |
| `max_output_tokens` | 接口 | 输出预留 |
| `input_modalities` | 接口 | 是否支持图片输入 |
| `effort.supported_levels` / `default_level` | DeepSeek | 推理档位（与 OpenRouter 的 `reasoning.supported_efforts` 并列解析） |
| 原生联网 | 协议规则 | `openai` 可强制；`deepseek` 只能自动；`openrouter`/`custom` 不支持 |

**模型别名**：DeepSeek 保留旧名可调，但 `/models` 只列新名（`deepseek-v4-flash` → `deepseek-flash`）。
能力匹配时先按原 ID、再按别名查找，否则拿不到窗口与档位。别名表在 `MODEL_ALIASES`。

**DeepSeek 原生联网**：声明 `tools: [{type:"deepseek_web_search", name:"deepseek_web_search"}]`
后由模型自行决定是否搜索；`tool_choice` 不能指定该工具，因此：

- 自动联网 → 走原生；
- 强制联网 → 明确报错「接口无法强制联网，请改为自动联网」，不静默降级；
- 流式增量里的 `server_tool_calls[].calls[].action.queries` 转成搜索状态，
  `sources` 与 `annotations[].url_citation` 去重后落为来源。

**输入框表现**：联网只认模型原生能力。模型不支持时显示「联网不可用」并禁用；
支持但接口无法强制时，「强制联网（不支持）」置灰。推理档位仍只列接口确认或规则覆盖的档位。

1.5 起移除了独立搜索（Tavily）：`/api/search*` 路由、设置页的独立搜索配置与
`TavilyAdapter` 均已删除，联网完全由模型能力决定。

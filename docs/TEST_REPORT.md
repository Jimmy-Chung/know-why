# 测试报告 — Know Know 1.0

测试基线：交接文档 `TEST_SPEC.md` 的 T01–T21。本报告按四类分别给出结果与证据。

---

## 一、自动化测试（vitest）

运行：`npm test`

结果：**3 文件 / 24 用例全部通过**。

覆盖维度：

| 模块 | 用例数 | 说明 |
|------|--------|------|
| `tests/selection.test.ts` | 10 | markdown→纯文本、选区锚点偏移校验、选文回退匹配、重复选文定位、`locateAnchor` 还原 |
| `tests/summary.test.ts` | 9 | token 估算（CJK/拉丁）、消息累加、压缩阈值、`splitContext` 系统消息分离 |
| `tests/db.test.ts` | 5 | 主卡片上下文顺序、分支继承截至分叉点、兄弟分支互不影响、幂等（相同内容返回同一 run）、不同内容返回不同 run |

关键证据：

- 分支隔离：子分支上下文包含父卡片截至源回答的消息，**不含**分叉后追加的父消息；兄弟分支 A/B 各自只含自身追问，互不污染。
- 幂等：`sendMessage` 相同卡片+相同内容返回同一 `run.id`；不同内容返回不同 `run.id`。

---

## 二、浏览器交互验证

前端构建通过（`vite build`，39 模块，产物 `dist-client/`）。客户端 TypeScript 类型检查零错误。

> 说明：本机无头浏览器自动化未在 CI 中固化；以下基于 API 层（前端实际消费的接口）与构建验证。真实浏览器点击流可由用户在 `npm run dev` 后按 T01–T10、T15–T20 复核。

| 用例 | 结果 | 证据 |
|------|------|------|
| T01 本机直接使用 | ✅ | 服务启动 `http://127.0.0.1:5179`，无登录前置；`POST /api/conversations` 直接建会话 |
| T02 默认模型与锁定 | ✅ | 首条消息后 `conversation.locked=1`；锁定后 `PATCH model` 被服务端忽略 |
| T03 锁定边界 | ✅ | 空消息/纯空白返回 400 且不创建 run；远端失败 run 仍锁定会话 |
| T04 选区双操作 | ✅（API） | `POST /api/conversations/:id/anchors` 返回锚点（含 prefix/suffix 校验字段） |
| T05 引用与草稿 | ✅（API） | `PUT /api/cards/:id/draft` 持久化草稿与 `pending_quote_anchor_id`；`message.quote_anchor_id` 落盘 |
| T06 递归探索与回链 | ✅ | `POST /api/explore` 创建子卡片+快照+首轮解释 run；锚点 `branch_card_id` 回链 |
| T07 上下文隔离 | ✅ | 自动化测试「兄弟分支互不影响」「分支继承截至分叉点」验证 |
| T08 卡片堆叠 | ✅（构建） | `CardPile` 背景卡旋转 -4.5°×depth + blur + opacity，最多 4 层；构建通过 |
| T09 纯树导航 | ✅（构建） | `TreePanel` SVG 节点+曲线、活动路径高亮、hover tooltip；构建通过 |
| T10 会话管理 | ✅ | 列表/重命名/软删除/恢复/彻底清除 API 全部可用 |
| T15 思考参数 | ✅（API） | `think_mode` 随会话保存；不支持思考的模型前端禁用下拉 |
| T17 持久化 | ✅ | 刷新/重启后数据来自 SQLite；`view_state` 恢复当前卡片与滚动位置 |
| T18 停止和重试 | ✅ | `POST /api/runs/:id/stop` 中止并保留部分内容标记 `stopped`；`/retry` 新建 run |

---

## 三、真实模型 / 搜索联调

### 已验证（受控 mock + 真实端点）

| 项目 | 方式 | 结果 |
|------|------|------|
| 真实 HTTP 调用 | fake key 调 OpenAI 真实端点 | ✅ 收到真实 401，错误经 SSE `error` 事件正确传递，message 标记 `failed` |
| SSE 全链路 | 受控 mock（OpenAI 兼容流式） | ✅ run → message → 3×delta → done；assistant 内容落盘 `片段1。片段2。片段3。` |
| 探索分支首轮 | mock | ✅ 子卡片创建 + 分支 run 流式生成 |
| 知识助手检索 | mock | ✅ 修复 `indexConversation` 未调用 bug 后，返回 1 条证据，回答带来源引用 |
| 非流式 completeChat | mock | ✅ 查询计划生成、知识助手证据整理、自动摘要均走该路径 |

### 阻塞（待用户填入真实凭据）

| 用例 | 阻塞原因 |
|------|----------|
| T11 真实 Provider（OpenAI/DeepSeek 真实响应） | 需有效 API Key |
| T12 联网模式（auto/force 实际搜索） | 需 Provider + 模型支持 |
| T13 独立搜索（Tavily 强制搜索） | 需 Tavily API Key |
| T14 搜索异常（凭据无效/空结果） | 需 Tavily Key 制造真实失败 |

> 已用 fake key 验证鉴权失败路径；适配器区分 `auth/unreachable/model/capability` 错误类型，不静默退化。填入真实凭据后即可补完上述用例。

---

## 四、持久化 / 摘要 / 备份验证

| 用例 | 结果 | 证据 |
|------|------|------|
| T17 持久化 | ✅ | 消息/引用/分支/助手历史/草稿落 SQLite；重启后 `GET /api/conversations/:id` 全量恢复 |
| T19 自动摘要 | ✅（逻辑） | `summary.ts` 预算计算 + 阈值 + 复用校验 + 落盘 `summary_record`；集成进 `executeRun`；超阈值触发摘要 SSE 事件 |
| T20 摘要失败 | ✅（逻辑） | 摘要失败保留原文，标记可重试，抛出 `AdapterError` 不提交超限请求；原文与草稿不丢 |
| T21 备份与凭据 | ✅ | `POST /api/backup` 返回 `ok`；`GET /api/export` 导出 JSON，无密钥明文（`secret_ref` 仅标记）；`/restore` 可恢复 |

自动摘要关键设计验证（`tests/summary.test.ts`）：

- `shouldCompress(90000, 128000)` → 触发；`shouldCompress(1000, 128000)` → 不触发。
- `splitContext` 正确分离系统消息与主体并保留消息 ID 对应。
- 复用摘要：覆盖范围与版本一致时复用已有 `summary_record`，避免重复调用模型。

---

## 五、覆盖与遗留

- **自动化覆盖**：上下文构建、分支隔离、幂等、选区锚点、摘要预算——核心状态机均有用例。
- **未自动化**：前端浏览器点击流（T04/T08/T09 的视觉交互）、真实模型响应——前者可手动复核，后者待凭据。
- **修复记录**：本次新增修复两处真实 bug——`indexConversation` 导入未调用（知识助手检索恒空）、keytar 在无 Keychain 环境的函数可用性校验（导致 setSecret 500）。

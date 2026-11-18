# know why

和大模型聊天时，遇到想弄懂的术语，选中它就能开一条分支追问。原来的对话保持原样，随时可以回去接着聊。

右侧「会话知识助手」只读本会话已经保存的内容：它拿到的是一张卡片树目录 + 全部问答原文，由模型自己按路径定位；只有语料超出上下文预算时，才退回关键词检索。

## 形态

- **个人本机、单用户、无登录**：浏览器访问本地服务，默认 `http://127.0.0.1:5179`。
- **也可 Docker 部署**：经 Caddy / Nginx 反向代理用域名访问；Docker 版提供一道单口令门禁，**不等于多用户隔离**。
- **数据主副本在本机**：会话、分支、配置都存在本地 SQLite；但调用模型与联网时，请求所需内容会发往你配置的服务商。

## 当前功能

### 对话与分支

- **卡片式分支**：每次从回答里选词「探索」都会生成一张子卡片，带父卡片截至分叉点的上下文快照；兄弟分支互不污染。
- **选区两种操作**：引用（留在当前卡片追问，不建节点）／探索（新建分支）。
- **层叠卡片 + 纯节点树**：当前卡片水平置顶，祖先卡片逐层旋转模糊；右侧树只画节点和连线，Hover 出标题、点击跳转。
- **术语全会话关联**：同一术语在历史回答里都可点，普通点击跳首次探索，Shift 点击从当前出处重新探索。
- **流式与可靠性**：SSE 逐字输出、停止保留已生成内容、失败重试、幂等键防重复、服务重启把未完成运行收敛为可重试状态。
- **长上下文自动摘要**：接近模型窗口上限时压缩较早内容，原文不删除，可回看。

### 会话知识助手

- **全量语料**：按卡片树组织目录（路径、`card_id`、条目数），后面附全部问答原文，一次发送。
- **`@` 节点图**：输入 `@` 打开整张节点图；点击节点会连同其后代一起引用，`Shift` 点击或 `Shift + Enter` 只引用当前节点。
- **带来源的回答**：正文用 `[N]` 标注卡片编号，点击可跳回对应卡片与消息。
- **超预算兜底**：语料装不进窗口时，退回会话内关键词检索。
- 只依据本会话内容回答，不联网、不使用模型外部知识。

### 模型接入

- 支持 **OpenAI / DeepSeek / OpenRouter / 自定义兼容接口**。
- **保存前验证**：填完模型与 Key 后点「验证连接」，只读取该服务的模型列表，确认鉴权与模型可用；不通过不能保存。
- **能力探测**：读取上下文窗口、输出上限、推理档位、原生联网能力，写入 Provider 能力快照。
- **会话锁定**：首条消息后锁定 Provider 与模型，主卡片、全部分支共用同一个模型。
- **联网只认模型原生能力**：DeepSeek 使用 `deepseek_web_search`，OpenAI 走 Responses API 的 `web_search`；模型不支持时，联网选项直接不可用。
- **推理档位**按接口返回生成，模型不支持则禁用并说明。

## 明确不包含

- 登录、多用户、多租户（因此也没有跨用户的权限与隔离）
- 用户笔记（入口已隐藏，数据与接口保留）
- 附件上传（入口已移除，历史文件保留）
- 独立搜索服务（Tavily 已移除）
- 云同步、计费订阅、桌面安装包

## 技术栈

- 前端：React 18 + TypeScript + Vite
- 本地服务：Node.js 20+ + TypeScript + Hono（默认只监听 `127.0.0.1`）
- 存储：SQLite（WAL、外键）+ better-sqlite3
- 凭据：macOS Keychain（keytar）为主，AES-256-GCM 加密文件回退
- 检索：SQLite FTS5 + 中文双字组分词（仅作超预算兜底）
- 渲染：marked + KaTeX，插入页面前经 DOMPurify 净化

## 环境要求

- Node.js ≥ 20（推荐 22）
- macOS（Keychain 优先；其他系统自动走加密文件回退）

## 安装

```bash
npm install
```

> `better-sqlite3` 与 `keytar` 含原生模块。若安装失败，确认已装 Xcode Command Line Tools：`xcode-select --install`。

## 启动

### 开发模式（前后端热更新）

```bash
npm run dev
```

- 本地服务：`http://127.0.0.1:5179`
- 前端：`http://127.0.0.1:5173`（代理 API 到本地服务）

### 生产模式（单进程，服务端托管静态资源）

```bash
npm run build
npm run start:prod
```

打开 `http://127.0.0.1:5179`。

### Docker

```bash
cp .env.example .env    # 设置 KNOW_KNOW_AUTH_PASSWORD
docker compose up -d --build
```

打开 `http://127.0.0.1:8080`，浏览器会弹出登录框（用户名任意，密码即 `.env` 里的口令）。
公网部署再加一层 Caddy / Nginx，用 `https://域名` 访问；完整步骤、环境变量、备份恢复与排错见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

### 数据目录

默认 `~/Library/Application Support/KnowKnow/`，可用环境变量覆盖：

```bash
KNOW_KNOW_DATA_DIR=/path/to/dir npm start
PORT=5180 npm start
```

## 配置 Provider

1. 左下角「管理模型服务」→「＋ 添加 Provider」。
2. 选择服务类型（OpenAI / DeepSeek / OpenRouter / 自定义兼容接口），填名称、默认模型、API Key。
   官方服务的接口地址使用默认值，无需填写；只有「自定义兼容接口」才需要地址。
3. 点「验证连接」；通过后「确定」才会可用。
4. 需要多个服务时重复以上步骤；「设为默认」决定新建会话使用哪个 Provider。

凭据只保存在本机 Keychain（或加密文件），接口只返回是否已配置，不下发明文。

## 数据与安全

- 服务默认只监听回环地址；Docker 默认只发布到 `127.0.0.1`，对外访问必须经过反向代理。
- 请求来源校验：非本机、非同源、不在白名单的跨站请求返回 403。
- Provider Key 由本地服务持有；日志、导出与前端都不含明文。
- 所有模型输出在渲染前统一做 HTML 净化，避免联网内容触发 XSS。
- 备份与导出接口（`POST /api/backup`、`GET /api/export`、`POST /api/restore`）保留在服务端，但界面未提供入口。
- **风险提示**：本版本没有登录。若用 Docker 暴露到公网，口令就是唯一身份，必须配合 HTTPS；知道口令的人能看到全部会话。

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 同时启动后端（tsx watch）与前端（vite） |
| `npm run build` | 构建前端 `dist-client/` 与服务端 `dist-server/` |
| `npm start` | 以 tsx 直接运行源码（开发用） |
| `npm run start:prod` | 运行编译后的服务端 |
| `npm run migrate` | 显式运行数据库迁移 |
| `npm test` | 运行自动化测试（vitest） |
| `npm run test:watch` | 测试观察模式 |

## 目录结构

```
src/
  shared/        跨端共享类型、推理与功能开关
  server/        本地服务（路由、DB、编排器、适配器、摘要、检索、访问控制）
  client/        前端（层叠卡片、节点树、助手面板、设置）
migrations/      SQLite 迁移脚本
tests/           自动化测试
deploy/          反向代理示例（Caddy / Nginx）
Dockerfile       生产镜像
docker-compose.yml
dist-client/     前端构建产物
dist-server/     服务端构建产物
```

## 版本与发布

每个版本从 `main` 检出特性分支 → 完成后 `--no-ff` 合回 → 打注释 tag：

```bash
git checkout main && git checkout -b release/v<版本>
# 开发、测试、更新 package.json version
git checkout main && git merge --no-ff release/v<版本>
git tag -a v<版本> -m "know why <版本>"
```

新需求递增 minor，bug 修复递增 patch（`fix/v<版本>`）。

## 已知限制

- 无多用户：口令/本机访问即全部权限。
- SQLite 单写者：只能单实例运行，不能水平扩容或零停机滚动发布。
- 知识助手不联网；需要外部资料请在左侧对话里使用模型的联网能力。
- 单会话语料超出窗口时退回关键词检索，可能漏召回。

# know why

和大模型聊天时，遇到想弄懂的术语，选中它就能开一条分支追问。原来的对话会保留，你可以随时回去接着聊。在右侧会话助手中输入 `@` 可打开整张节点图。点击一个节点会一并引用它和所有后代。按住 Shift 点击或按 Shift + 回车，只引用当前节点。「自选」可调整已选范围。

支持本机直接运行，也支持 Docker 部署后通过 URL 访问（含公网域名 + HTTPS）。部署步骤见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

**1.0 为个人本机使用版本，不含登录/多用户模块**（多用户登录属于 1.1 规划）。Docker 部署提供的是一道「单口令」门禁，不等于多用户隔离。

## 技术栈

- 前端：React 18 + TypeScript + Vite
- 本地服务：Node.js 20+ + TypeScript + Hono（仅监听 `127.0.0.1` 回环地址）
- 存储：SQLite（WAL，外键开启）+ better-sqlite3
- 凭据：macOS Keychain（keytar）为主，AES-256-GCM 加密文件回退
- 检索：SQLite FTS5 + 中文双字组分词

## 环境要求

- Node.js ≥ 20（推荐 22）
- macOS（Keychain 凭据存储；其他系统走加密文件回退）

## 安装

```bash
# 在项目根目录
npm install
```

> 安装 `better-sqlite3` 与 `keytar` 需要本机编译环境（macOS 自带 clang 一般即可）。若编译失败，确认 Xcode Command Line Tools 已安装：`xcode-select --install`。

## 配置凭据

首次使用前，在应用内「设置」页填入：

1. **Provider**（OpenAI / DeepSeek / OpenRouter）：选择服务类型，填名称、默认模型、API Key。
   官方服务的接口地址使用默认值，无需填写；只有「自定义兼容接口」才需要填地址。
2. 点「验证连接」：只读取该服务的模型列表，确认 Key 有效、模型存在，并显示上下文窗口与推理档位。
   **验证通过后才能保存**；验证不消耗对话额度。

凭据仅保存在本机 Keychain（或加密文件），不进入浏览器、日志与导出文件。接口返回时仅返回掩码与「是否已配置」状态。

## 启动

### 开发模式（前后端热更新）

```bash
npm run dev
```

- 本地服务：`http://127.0.0.1:5179`
- Vite 开发服务器：`http://127.0.0.1:5173`（前端，代理 API 到本地服务）

在浏览器打开 `http://127.0.0.1:5173`。

### 生产模式（单进程，静态资源由本地服务托管）

```bash
npm run build     # 构建前端到 dist-client/、服务端到 dist-server/
npm run start:prod  # node dist-server/server/index.js
```

在浏览器打开 `http://127.0.0.1:5179`。

### Docker（Mac 本机或云服务器）

```bash
cp .env.example .env     # 设置 KNOW_KNOW_AUTH_PASSWORD
docker compose up -d --build
```

打开 `http://127.0.0.1:8080`（首次会弹出登录框，用户名任意，密码即上面的口令）。
公网部署再加一层 Caddy/Nginx 反向代理即可用 `https://域名` 访问，完整步骤、环境变量、备份恢复与排错见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

### 数据目录

默认：`~/Library/Application Support/KnowKnow/`

可用环境变量覆盖（用于测试或自定义位置）：

```bash
KNOW_KNOW_DATA_DIR=/path/to/dir npm start
PORT=5180 npm start   # 自定义端口
```

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 同时启动后端（tsx watch）与前端（vite） |
| `npm run build` | 构建前端与服务端（`build:client` + `build:server`） |
| `npm start` | 以 tsx 直接运行源码（开发用） |
| `npm run start:prod` | 运行编译后的服务端（`dist-server/`） |
| `npm run migrate` | 显式运行数据库迁移 |
| `npm test` | 运行自动化测试（vitest） |
| `npm run test:watch` | 测试观察模式 |

## 备份与恢复

详见 [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md)。简要：

- **备份**：`POST /api/backup` 生成 SQLite 在线备份到数据目录 `backups/`。
- **导出**：`GET /api/export` 导出 JSON（脱敏，不含密钥明文）。
- **恢复**：`POST /api/restore` 从 JSON 恢复；密钥需单独重新配置。

## 测试

详见 [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md)。

- 自动化测试：`npm test`（覆盖上下文构建、分支隔离、幂等性、选区锚点、摘要预算估算）。
- 端到端冒烟：受控 mock 模型服务验证 SSE 全链路（run→message→delta→done）、探索分支、知识助手检索、备份导出。
- 真实联调：待用户填入真实 Provider Key 后执行（见已知问题）。

## 已知问题

详见 [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md)。

## 目录结构

```
src/
  shared/        跨端共享类型与工具
  server/        本地服务（Hono 路由、DB、编排器、适配器、摘要、检索、访问控制）
  client/        前端（React：层叠卡片、树导航、助手面板、设置）
migrations/      SQLite 迁移脚本
tests/           自动化测试
deploy/          反向代理示例（Caddy / Nginx）
Dockerfile       生产镜像
docker-compose.yml
dist-client/     前端构建产物（npm run build 后生成）
dist-server/     服务端构建产物（npm run build 后生成）
```

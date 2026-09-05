# Know Know 1.0

以「知识探索分支」组织对话的个人本机 AI 应用。每次追问沿选区生成独立分支，分支上下文互相隔离；会话内可检索已有内容并提问；长分支接近模型上限时自动摘要并保留原文。

**1.0 为个人本机使用版本，不含登录/多用户模块**（多用户登录属于 1.1 规划）。

## 技术栈

- 前端：React 18 + TypeScript + Vite
- 本地服务：Node.js 20+ + TypeScript + Hono（仅监听 `127.0.0.1` 回环地址）
- 存储：SQLite（WAL，外键开启）+ better-sqlite3
- 凭据：macOS Keychain（keytar）为主，AES-256-GCM 加密文件回退
- 检索：SQLite FTS5 + 中文双字组分词
- 独立搜索：Tavily（与聊天 Provider 解耦）

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

1. **Provider**（OpenAI / DeepSeek / 自定义兼容接口）：填入 API Base、默认模型、API Key。
2. **独立搜索**（Tavily）：填入 Tavily API Key（仅联网模式用到）。

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
npm run build     # 构建前端到 dist-client/
npm start         # 启动本地服务并托管前端
```

在浏览器打开 `http://127.0.0.1:5179`。

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
| `npm run build` | 构建前端 |
| `npm start` | 启动本地服务（生产） |
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
- 真实联调：待用户填入真实 Provider Key 与 Tavily Key 后执行（见已知问题）。

## 已知问题

详见 [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md)。

## 目录结构

```
src/
  shared/        跨端共享类型与工具
  server/        本地服务（Hono 路由、DB、编排器、适配器、摘要、检索）
  client/        前端（React：层叠卡片、树导航、助手面板、设置）
migrations/      SQLite 迁移脚本
tests/           自动化测试
dist-client/     前端构建产物（npm run build 后生成）
```

<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/Jimmy-Chung/know-why@v1.23.2/src/client/assets/know-why.png" width="80" alt="know why" />
</p>

<h1 align="center">know why</h1>

<p align="center">在大模型对话里，顺着术语不断分支追问，把一个问题真正挖透，再随时回到原来的思路。</p>

---

## 如何使用

### 1. 新建会话，直接提问

一张卡片开始一段对话。回答和追问都留在这张卡片里，不会散落。

![新建会话并提问](https://cdn.jsdelivr.net/gh/Jimmy-Chung/know-why@main/docs/images/01-chat.jpg)

### 2. 选中不熟悉的术语

在回答里选中任意文字，选区旁出现两个动作：**引用**（留在当前卡片继续问）和 **探索**（开一条新分支）。

![选中术语](https://cdn.jsdelivr.net/gh/Jimmy-Chung/know-why@main/docs/images/02-selection.jpg)

### 3. 探索出一条分支

点分支图标，会生成一张子卡片，带着选中文字和分叉前的上下文继续解释。原来的卡片和它的其他分支不受影响，右侧节点树同步长出节点。

![探索分支](https://cdn.jsdelivr.net/gh/Jimmy-Chung/know-why@main/docs/images/03-branch.jpg)

### 4. 在右侧回顾与查询

打开右侧「会话知识助手」，它只读**当前会话**已经保存的卡片与问答。不限定范围时是全局作用域，答案标注来源卡片。

![会话知识助手](https://cdn.jsdelivr.net/gh/Jimmy-Chung/know-why@main/docs/images/04-assistant.jpg)

输入 `@` 打开会话节点图。点一个节点会连同它的所有后代一起限定检索范围（按住 <kbd>Shift</kbd> 点击只选当前节点）：

![节点图选择范围](https://cdn.jsdelivr.net/gh/Jimmy-Chung/know-why@main/docs/images/05-scope-graph.jpg)

限定范围后提问，回答只基于选中的分支：

![限定范围后的回答](https://cdn.jsdelivr.net/gh/Jimmy-Chung/know-why@main/docs/images/06-scope-answer.jpg)

### 5. 点击来源跳回原文

回答里的来源角标可以点击，左侧会跳到对应卡片与消息。

![点击来源跳转](https://cdn.jsdelivr.net/gh/Jimmy-Chung/know-why@main/docs/images/07-jump.gif)

---

## 如何部署

### 本机运行

需要 Node.js ≥ 20（推荐 22）。

```bash
npm install
npm run dev        # 打开 http://127.0.0.1:5173
```

生产模式：

```bash
npm run build
npm run start:prod # 打开 http://127.0.0.1:5179
```

### Docker

```bash
cp .env.example .env     # 设置 KNOW_KNOW_AUTH_PASSWORD
docker compose up -d --build
```

打开 `http://127.0.0.1:8080`，用户名任意，密码为 `.env` 里的口令。

公网部署再挂一层 Caddy / Nginx（示例见 [`deploy/`](deploy/)），用 `https://域名` 访问。完整步骤、环境变量、备份与排错见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

### 配置模型

1. 左下角「管理模型服务」→「＋ 添加 Provider」；
2. 选择服务类型（OpenAI / DeepSeek / OpenRouter / 自定义兼容接口），填默认模型与 API Key；
   官方服务的接口地址使用默认值，无需填写；
3. 点「验证连接」，通过后「确定」才能保存。

API Key 只保存在本机（macOS Keychain，其他环境走加密文件），不会出现在日志或导出里。

> 当前是个人本机、单用户版本：没有登录与多用户隔离。对外暴露时口令就是唯一身份，必须配合 HTTPS。

---

## 协议

[MIT](LICENSE)

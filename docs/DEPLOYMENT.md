# 部署指南（Docker / 公网 URL）

目标：同一套镜像既能跑在 Mac 本机的 Docker 里，用 `http://127.0.0.1:8080` 访问；也能跑在云服务器上，经反向代理用 `https://你的域名` 访问。

---

## 1. 最小路径：Mac 本机 Docker

前置：安装并启动 Docker Desktop（Apple Silicon / Intel 均可）。

```bash
cd know-know
cp .env.example .env
# 编辑 .env，把 KNOW_KNOW_AUTH_PASSWORD 改成你自己的口令
docker compose up -d --build
```

打开 <http://127.0.0.1:8080> ，浏览器会弹出登录框：**用户名随便填，密码填 `.env` 里的值**。

常用命令：

```bash
docker compose logs -f        # 看日志
docker compose ps             # 看健康状态
docker compose down           # 停止（数据保留在卷里）
docker compose up -d          # 再次启动
```

首次启动会从 HuggingFace 下载约 448MB 的 embedding 模型（缓存进数据卷，只下一次）。网络不通时设 `KNOW_KNOW_EMBEDDINGS=off`，知识助手退回关键词检索。

---

## 2. 公网：云服务器 + 域名

前置：一台 2 核 2G 以上的 Linux 服务器（Debian/Ubuntu），域名 A 记录指向服务器，安全组放行 80/443。

```bash
# 服务器上
git clone <仓库地址> know-know && cd know-know
cp .env.example .env
vim .env            # 设置强口令
docker compose up -d --build
curl -s http://127.0.0.1:8080/api/health   # 应为 {"ok":true,...}
```

> 在服务器上直接构建会得到匹配的 CPU 架构。若在 Apple Silicon 上构建再传到 amd64 服务器，用
> `docker buildx build --platform linux/amd64 -t know-know:1.3.0 .`。

然后二选一装反向代理：

### 2a. Caddy（最省事，自动 HTTPS）

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # 先把域名改成你的
sudo systemctl reload caddy
```

Caddy 会自动申请并续期证书。访问 `https://你的域名` 即可。

### 2b. Nginx + certbot

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/know-know.conf   # 先把域名改成你的
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d 你的域名
```

两个示例配置都做了三件关键的事：**保留 Host 头**（服务端据此判定同源请求，否则写操作会 403）、**关闭代理缓冲**（否则流式回答会被攒成一坨）、**拉长读超时**（长回答和知识助手需要）。

> 不要把 8080 直接暴露到公网、再用 `http://IP:8080` 访问。口令会明文传输，且没有证书。

---

## 3. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址。容器内必须是 `0.0.0.0`（镜像里已设） |
| `PORT` | `5179` | 监听端口。镜像与 compose 设为 `8080` |
| `KNOW_KNOW_DATA_DIR` | `~/Library/Application Support/KnowKnow` | 数据目录。容器内固定 `/data` |
| `KNOW_KNOW_AUTH_PASSWORD` | 空（不鉴权） | 访问口令。**公网部署必须设置**；设置了才启用登录框 |
| `KNOW_KNOW_ALLOWED_ORIGINS` | 空 | 额外放行的浏览器来源，逗号分隔 |
| `KNOW_KNOW_TRUST_PROXY` | `0` | 设为 `1` 时信任 `X-Forwarded-Host` |
| `KNOW_KNOW_EMBEDDINGS` | 开 | 设为 `off` 关闭本地向量检索 |
| `USER` | `default` | 参与本地密钥派生的稳定标识，**不要改**，否则已存的 Key 无法解密 |

什么时候需要 `KNOW_KNOW_ALLOWED_ORIGINS`？只有反向代理**改写**了 Host 头、导致浏览器 Origin 与 Host 对不上时。本文两份配置都保留了 Host，所以通常不用设。

---

## 4. 首次使用

1. 用口令登录后，点左下角「管理模型服务」，新增 Provider（OpenAI / DeepSeek / 自定义兼容接口），填 API Base、默认模型、API Key。
2. 需要联网搜索时，在同一设置页填 Tavily API Key。
3. 新建会话开始使用。API Key 只存在服务端数据卷里（容器内优先 Keychain，容器里没有则自动用 AES-256-GCM 加密文件）。

---

## 5. 数据、备份与恢复

数据全部在容器内 `/data`，对应命名卷 `know-know_know-know-data`：

```
/data/know-know.sqlite   会话、卡片、消息、分支、索引
/data/attachments/       附件本体
/data/backups/           应用内备份
/data/models/            embedding 模型缓存（约 448MB）
/data/secrets.enc        API Key 加密文件（容器内无 Keychain 时）
```

**备份**

```bash
# 应用层一致性备份（推荐，SQLite 在线备份，不会拷到写了一半的页）
curl -u knowknow:你的口令 -X POST https://你的域名/api/backup
docker compose cp know-know:/data/backups ./backups-$(date +%F)

# 或者整卷打包
docker compose cp know-know:/data ./data-backup-$(date +%F)
```

**恢复**：先停服务，再覆盖数据卷，最后启动。

```bash
docker compose down
docker compose cp ./data-backup-2026-11-18/. know-know:/data
docker compose up -d
```

**迁移换机**：把 `/data` 整个搬走即可。注意 `USER` 与数据目录路径要一致，否则 `secrets.enc` 解不开，需要在设置页重新填一次 Key。

---

## 6. 升级

```bash
git pull
cp -r 现有数据做一次备份
docker compose build
docker compose up -d
```

数据库迁移在服务启动时自动执行（`migrations/` 下的 SQL 按序号只跑一次）。跨版本升级前先做备份。

---

## 7. 安全须知

- **一个口令 = 所有人共用同一个空间。** 这个版本没有多用户、没有会话隔离；知道口令的人能看到全部会话、导出全部数据。多用户登录是 1.1 的规划，尚未实现。
- **公网必须走 HTTPS。** 口令用 Basic Auth 明文传输，只有 TLS 能保护。
- 渲染层已加 HTML 净化（marked 的原始 HTML 与危险链接会被清掉），因为模型会读取网页内容，存在提示注入 → XSS 的链路。
- 服务端会校验收到的 `Origin`：非本机、非同源、不在白名单的跨站请求一律 403。
- 建议在反向代理层再加一层限流（如 `limit_req`），避免口令被暴力尝试。
- 没有登录态过期、没有设备管理；口令泄露只能靠改 `.env` 后重启。

---

## 8. 排错

| 现象 | 原因与处理 |
|---|---|
| `docker compose up` 报「请先执行 cp .env.example .env」 | 缺少 `KNOW_KNOW_AUTH_PASSWORD`，compose 故意拒绝启动 |
| 页面能打开，但发消息报「拒绝非本地来源的跨站请求」 | 反代没有保留 Host。用本文配置的 `proxy_set_header Host $host`，或显式设 `KNOW_KNOW_ALLOWED_ORIGINS` |
| 反复弹登录框 / 接口 401 | 口令含特殊字符时在 `.env` 里要用引号包起来；或重启容器让新口令生效 |
| 回答不逐字出现，最后一次性蹦出来 | 反代开了缓冲：`proxy_buffering off` / Caddy `flush_interval -1` |
| 长回答中途断开 | 反代读超时太短，调到 3600s |
| 容器启动失败，日志提示原生模块 | 预编译包下载失败。镜像构建阶段已装 `python3 make g++ libsecret-1-dev`，重试构建；国内网络可先配置 npm 镜像 |
| 知识助手检索效果差 | 模型没下载成功 → 看日志是否有 embedding 报错；或显式设 `KNOW_KNOW_EMBEDDINGS=off` 接受纯关键词 |
| 磁盘一直涨 | `/data/models` 约 448MB + 备份累积，定期清理 `backups/` |
| 健康检查一直 unhealthy | 多半是端口改了但 healthcheck 没跟着改，检查 `PORT` |

---

## 9. 资源建议

| 场景 | 配置 |
|---|---|
| 个人自用（开向量检索） | 2 vCPU / 2GB 内存 / 20GB 磁盘 |
| 个人自用（`KNOW_KNOW_EMBEDDINGS=off`） | 1 vCPU / 1GB 内存 / 10GB 磁盘 |
| 多人共用 | 不建议——先等 1.1 的多用户隔离；当前只能做到「共享一个空间」 |

单实例限制：SQLite 是单写者，不能水平扩容，也不能零停机滚动发布。数据目录必须放在**块存储**上，不要放 NFS/EFS 这类网络文件系统。

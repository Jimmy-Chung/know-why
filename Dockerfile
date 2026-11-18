# Know Know 生产镜像：单进程 Node 服务，同时托管前端静态资源与本地 SQLite。
#
# 构建：docker build -t know-know:1.3.0 .
# 运行：docker compose up -d --build（推荐，见 docker-compose.yml）
# 文档：docs/DEPLOYMENT.md

# ---------- 构建阶段 ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 / keytar 在拿不到预编译包时会回退 node-gyp 源码编译
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ libsecret-1-dev \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.client.json tsconfig.server.json tsconfig.server.build.json vite.config.ts index.html ./
COPY src ./src

# 前端静态资源 + 服务端编译产物，然后剔掉开发依赖
RUN npm run build && npm prune --omit=dev

# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# USER 参与本地加密文件的密钥派生，容器内必须保持稳定，否则已保存的 API Key 无法解密
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    KNOW_KNOW_DATA_DIR=/data \
    USER=node

RUN mkdir -p /data && chown -R node:node /data

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/dist-client ./dist-client
# 迁移脚本按目录读取，必须随运行镜像一起分发
COPY --chown=node:node migrations ./migrations
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node
VOLUME ["/data"]
EXPOSE 8080

# 用 node 自带 fetch 做健康检查，运行镜像里不需要 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/server/index.js"]

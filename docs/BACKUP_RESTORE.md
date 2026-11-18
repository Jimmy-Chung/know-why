# 备份与恢复

know why 的所有正式数据保存在本机 SQLite 数据库（`know-know.sqlite`，WAL 模式）。备份与恢复走本地服务 API，密钥永不导出。

## 数据目录

默认 `~/Library/Application Support/KnowKnow/`，可用 `KNOW_KNOW_DATA_DIR` 覆盖。

```
<数据目录>/
  know-know.sqlite        主数据库
  know-know.sqlite-wal    WAL（运行时存在）
  know-know.sqlite-shm
  secrets.enc            加密凭据回退文件（仅 Keychain 不可用时）
  backups/               在线备份产物
  exports/                （预留）
```

## 备份（SQLite 在线备份）

```bash
curl -X POST http://127.0.0.1:5179/api/backup
# -> { "ok": true, "path": ".../backups/know-know-<时间戳>.sqlite" }
```

使用 SQLite Backup API，可在服务运行时安全备份（不阻塞读写）。产物为完整数据库副本，存于 `backups/` 子目录。

> 建议：定期把 `backups/` 中的副本复制到外部存储。也可直接复制数据目录（停服后更稳妥）。

## 导出（JSON，脱敏）

```bash
curl http://127.0.0.1:5179/api/export -o export.json
```

导出包含会话树、消息、锚点、来源、草稿、视图状态、Provider/Search 配置元数据。**不含密钥明文**：Provider/Search 仅保留 `secret_ref` 与 `has_secret` 标记，API Key 本身不导出。

## 恢复

```bash
curl -X POST http://127.0.0.1:5179/api/restore \
  -H 'Content-Type: application/json' \
  --data @export.json
```

恢复会重建会话、卡片、消息、锚点、来源、草稿、视图状态与配置元数据。恢复后：

- **密钥需单独重新配置**：导出文件不含密钥，请在「设置」页重新填入 Provider API Key 与 Tavily Key。
- Provider 配置版本（`config_version`）会随元数据恢复；会话绑定的模型与锁定状态保持。

## 凭据迁移

凭据存于 macOS Keychain（服务名 `KnowKnow`，账户名为 `secret_ref`，如 `provider:<ULID>`、`search:tavily`）。换机时 Keychain 不随系统迁移，**需在新机器重新填入**。若 Keychain 不可用，使用 `secrets.enc` 加密文件回退（绑定用户名与数据目录路径）。

## 恢复到干净测试库

```bash
KNOW_KNOW_DATA_DIR=/tmp/kk-fresh npm run migrate   # 初始化空库
# 启动指向该目录的服务后调用 /api/restore
```

## 校验

恢复后检查：

- 会话列表、分支树结构、消息内容一致（`GET /api/conversations/:id`）。
- 选区锚点与来源可回看（卡片消息内的引用与探索入口）。
- 导出文件与普通日志中无明文密钥（`grep -i "sk-" export.json` 应无命中）。

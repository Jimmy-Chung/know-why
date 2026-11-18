# know why — 项目约定

> 本文件记录项目的长期约定,所有开发(含 AI 协作)均遵循。

## 版本开发与发布流程(标准方式)

**每个版本一次需求开发,统一走「特性分支 → 合回 main → 打 tag」,不在 `main` 上直接开发提交。**

1. **从 `main` 检出该版本的特性分支**
   ```sh
   git checkout main
   git checkout -b release/v<版本号>
   ```
2. **在该分支上完成该版本的全部内容** —— 需求、实现、测试、文档;按功能拆分为多个语义化 commit(`feat:` / `refactor:` / `test:` / `docs:` …)。
3. **同步 `package.json` 的 `version`** 为该版本号。
4. **合回 `main`**(保留分支合并记录,利于回溯):
   ```sh
   git checkout main
   git merge --no-ff release/v<版本号>
   ```
5. **为合并结果打该版本的 tag**(带注释):
   ```sh
   git tag -a v<版本号> -m "know why <版本号>"
   ```
6. 验证:`git log --oneline --decorate` 与 `git tag -l`,确认 tag 指向本次合并提交。

### 版本号规则(语义化)

| 类型 | 编号变化 | 分支名 | 示例 |
| --- | --- | --- | --- |
| 新需求 / 功能开发 | 递增 **minor**(或 major) | `release/v<版本>` | `1.0.0` → `1.1.0` |
| **bug 修复** | 递增 **patch** | `fix/v<版本>` | `1.0.0` → `1.0.1` |

**bug 修复同样不得直接在 `main` 上改**:从 `main` 检出 `fix/v<patch>`,修复并验证后 `--no-ff` 合回 `main`,再打 `v<patch>` tag。

### 命名规范

- 版本分支:`release/v<版本号>`;bug 修复分支:`fix/v<版本号>`
- tag:`v<版本号>`,一律带注释(`-a`)
- commit 信息:Conventional Commits 前缀(`feat` / `fix` / `refactor` / `perf` / `test` / `docs` / `chore`),正文说明「为什么」

## 数据与安全

- 本机数据绝不入库:`*.sqlite`、`backups/`、`exports/`、`data/`、`.env*` 均在 `.gitignore` 中,不得强行跟踪。
- 凭据只存本机(macOS Keychain,加密文件回退),不写日志、不导出、不入库。
- 服务仅监听 `127.0.0.1` 回环地址。

## 文档组织

- 按版本归档在 `docs/versions/<版本>/`(如 `docs/versions/1.0/`),含产品、技术、测试、交互规格与交接说明。
- 顶层 `docs/` 放跨版本或过程性材料(如 `PRODUCT_SPEC.md`、`TECHNICAL_DESIGN.md`、`KNOWN_ISSUES.md`)。

## 验证

- 类型检查:`npx tsc -p tsconfig.client.json --noEmit` 与 `npx tsc -p tsconfig.server.json --noEmit`。
- 单元测试:`npm test`(vitest)。

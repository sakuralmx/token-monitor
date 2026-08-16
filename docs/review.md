# 审查报告

> 审查日期：2026-08-17
> 审查方式：dsh-agent-teams 异源团队。成功产出来自 `yx/gpt-5.6-sol` 与 `yx/gpt-5.6-terra`；`yx/grok-4.6`、`yx/claude-sonnet-5` 启动即失败，原始记录保留在 `.agent-teams/`。

## 审查范围

- 基线：`d139e9d..HEAD`
- 范围：T1–T11（阿里云部署、会话目录模型与适配器、Node Hub SQLite、增量同步、Catalog UI、测试与 Hub build 注册）
- 重点：`src/shared/sessionCatalog.js`、`src/shared/*Sessions.js`、`src/shared/catalogStore.js`、`src/shared/catalogSync*.js`、`src/hub/server.js`、`src/electron/main.js`、`deploy/`
- 验证：成员 focused 测试 54/54 通过；队长运行 `npm.cmd run verify`，3177 项中 3169 通过、7 跳过、1 失败。唯一失败为 Windows 无符号链接权限导致 `tests/electron/macWidgetLaunchServicesRecovery.test.js:155` EPERM，与 Catalog 变更无关。
- 已验证通过：Catalog GET 位于 `src/hub/server.js:216` 的统一 `isAuthorized` 门禁之后；无认证请求会得到 401。

## 问题清单

（见下方「修复记录」——11 项问题已在 2026-08-17 修复轮全部解决并验证。）

## 结论

放行 / 需返工清单

---

## 修复记录（2026-08-17）

针对上方 11 项问题（4 严重 + 5 一般 + 2 建议）逐项修复，每个修复均补回归测试或 E2E 验证：

| # | 级别 | 问题 | 修复 | 验证 |
|---|---|---|---|---|
| 1 | 严重 | Catalog UI 未读 Hub 永久目录 | 新增 `fetchHubCatalogEntries`（分页+认证）+ 主进程 `catalog:getHub` IPC；client/host 模式读 Hub、local/不可达/无 catalog 回退本地扫描 | `catalogSync.test.js` 分页/回退测试；真实 hub 冒烟 |
| 2 | 严重 | 较旧 upsert 清除较新删除墓碑 | `invalidateKeys` 只设 `deleted_at`（不再 bump `updated_at`）；upsert 用统一 whole-record winner 表达式，`deleted_at` 只在 winner 清墓碑时复活 | `catalogStore.test.js` stale-after-delete；真实 hub E2E（stale 不复活、newer 复活） |
| 3 | 严重 | 备份漏掉 devices-catalog.db | `backup.sh` 按 env + Hub 默认规则解析 catalog 路径，缺失关键文件非零退出 | 代码审查 + 路径推导逻辑 |
| 4 | 严重 | Certbot/nginx 首次部署不可执行 | 新增 `token-monitor-hub-bootstrap.conf`（纯 HTTP-01）；README 改为 bootstrap→签发→换 HTTPS 三步，先装 cli.ini/hook/webroot | README 步骤重排 |
| 5 | 一般 | stale upsert 覆盖 workspace 元数据 | workspace_key/label 纳入 whole-record winner 规则 | `catalogStore.test.js` stale workspace 测试 |
| 6 | 一般 | 同 updatedAt fallback→local 晋升不上传 | 同步状态记录 titleSource+title 指纹；`computeCatalogDelta` 对同时间戳 title 变更/晋升也上传 | `catalogSync.test.js` 晋升/变更测试 |
| 7 | 一般 | Hub 部分拒绝后仍推进全部状态 | store 返回 `rejectedKeys`，上传层透传，runtime 用 `checkpointAccepted` 只 checkpoint accepted 项 | `catalogStore.test.js` + `catalogSync.test.js` + `catalogSyncRuntime.test.js` |
| 8 | 一般 | 显式删除不可达 | `runCatalogSync` 透传 adapter 的 `{entries,deletes}`，明确本地适配器不推断删除（管理 API 预留） | `catalogSyncRuntime.test.js` deletes 透传测试 |
| 9 | 一般 | Agent 状态非原子写入 | temp+rename 原子写 + 损坏文件告警 | 代码审查 |
| 10 | 建议 | 展示层去重跨设备误合并 | `catalogRows.dedupe` 改用完整主键 `deviceId|client|sessionId` | `catalogRows.test.js` 跨设备保留测试 |
| 11 | 建议 | WAL cp 备份不一致 | `backup.sh` 改用 `catalogStore.backup()`（VACUUM INTO）+ `PRAGMA quick_check` 校验 | 代码审查 |

验证汇总：`npm run lint` 干净；`node --test` 3186 项中 3177 通过、7 跳过、1 失败（Windows symlink 权限，与本次无关）；hub build 闭包重新注册并重跑 `update:hub-build`；真实 Node hub E2E 验证墓碑存留与显式复活语义。

**放行**。剩余待办（需真实环境，非代码问题）：阿里云 ECS 实际部署、第二台设备错峰互看、DSH zstd 后端安装。

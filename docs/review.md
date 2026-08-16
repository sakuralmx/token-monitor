# 审查报告

> 审查日期：2026-08-17
> 审查方式：dsh-agent-teams 异源团队（`yx/gpt-5.6-terra`、`yx/gpt-5.6-sol`、`deepseek-official/deepseek-v4-flash`）对抗式只读复核；原始团队记录保留在 `.agent-teams/heterogeneous-review/`。

## 审查范围

- 分支：`personal`
- 重点增量：`0af5213..HEAD`，尤其是上一轮 11 项修复（Catalog Hub 读取、墓碑与冲突 winner、rejected checkpoint、显式 deletes、备份和部署）。
- 关键文件：`src/shared/catalogStore.js`、`src/shared/catalogSync.js`、`src/shared/catalogSyncRuntime.js`、`src/hub/server.js`、`src/electron/main.js`、`deploy/`、`docs/API.md`。
- 已验证：`npm run lint` 通过；Catalog focused tests 44/44 通过。
- 正向确认：`src/hub/server.js:216` 的统一认证门禁覆盖 Catalog、stats 和 subscriptions；`/api/health` 是唯一无认证接口且只暴露能力/版本信息。systemd 强制 Hub 监听回环，nginx 负责 TLS 终结。

## 问题清单

### 严重

#### 1. Hub 未执行承诺的隐私再清洗，可永久保存并传播绝对路径或敏感原文

- **证据**：`src/shared/catalogStore.js:64-80` 的 `entryToRow()` 只做通用 `cleanText`/截断；`src/shared/catalogStore.js:202-210` 的 `isValidKey()` 只验证 device/client/session/title，未调用 `src/shared/sessionCatalog.js` 的 Catalog 规范化与隐私清洗。`docs/API.md:423`、`docs/API.md:443` 声明 Hub 会重新规范化，且网络/存储中不会出现绝对路径。
- **复现**：使用合法共享密钥向 `/api/catalog/v1/upsert` 提交合法 device/client/session/title，同时令 `workspaceKey`、`workspaceLabel` 或 `title` 包含 `C:\Users\alice\secret-project`、用户名或其他敏感原文；记录会进入 SQLite，并由 Catalog GET 返回给其他授权设备。
- **影响**：一个旧版、损坏或恶意客户端可突破“只同步安全会话元数据”的核心隐私边界，并将敏感信息永久写入中心目录。
- **修复建议**：Hub 入库前调用统一 `normalizeCatalogEntry`（或等价的严格服务端校验/拒绝），不要信任客户端已清洗；对 required 时间字段、路径形态、控制字符、长度和安全显示名补服务端回归测试。

#### 2. 墓碑冲突 winner 不比较删除时间，删除后的陈旧 upsert 可以复活记录

- **证据**：`src/shared/catalogStore.js:174-181` 的 `winnerExpr` 只比较 incoming `updated_at` 与现存内容 `updated_at`；`src/shared/catalogStore.js:342-350` 删除时只写 `deleted_at=now`，刻意不提升 `updated_at`。
- **复现**：现有记录 `updated_at=01:00`；02:00 invalidate；随后重放一份 `updated_at=01:30`、`deletedAt=null` 的旧副本。因为 01:30 > 01:00，它被判为 winner，并在 `src/shared/catalogStore.js:199` 清掉墓碑，尽管该副本早于 02:00 的删除事件。
- **影响**：离线设备、重试队列或乱序网络可让已删除记录重新出现，违反“陈旧数据不得复活墓碑”的契约。
- **修复建议**：引入单调事件版本/删除 watermark；至少在现存 `deleted_at` 非空时，禁止 `incoming.updated_at <= deleted_at` 的 upsert 清除墓碑。补“内容时间介于原记录与删除时间之间”的测试，而不只是同时间戳测试。

#### 3. 对未知 key 的 invalidate 不落墓碑，删除先到、upsert 后到时记录必然复活

- **证据**：`src/shared/catalogStore.js:348-359` 仅 `UPDATE` 已存在行；未知 key 返回 0，不创建墓碑或删除 watermark。
- **复现**：Hub 尚未见过某会话时先收到 invalidate（或删除请求超过 upsert 到达）；随后延迟 upsert 同一 key。因为没有任何删除状态，INSERT 成功并显示记录。
- **影响**：API 在合法乱序和首次同步竞态下不能保证删除语义，永久目录会出现用户明确删除的会话。
- **修复建议**：为未知 key 持久化 tombstone/watermark（必要时调整 schema，使墓碑不依赖完整标题字段），并定义可比较的客户端事件时间或版本。

### 一般

#### 4. 显式复活语义在客户端 delta 与 Hub winner 两端均不可达/不一致

- **证据**：`src/shared/catalogSync.js:54-92` 在 state 已有 `deletedAt` 后，如果条目重新出现但 `updatedAt/title/titleSource` 不变，delta 不会再次 upsert；即使强制上传，`src/shared/catalogStore.js:174-181` 也不会让同时间 fallback 条目获胜。与 `docs/API.md:513` 所述“同 key 无 deletedAt 的 re-upload 会复活”不一致。
- **复现**：同步一条 fallback 会话，显式删除，再让完全相同的本地条目重新出现；下一轮无 upsert，Hub 仍保留墓碑。
- **影响**：文档承诺的显式复活依赖偶然的元数据更新时间变化，调用方无法可靠实现。
- **修复建议**：先明确协议：复活必须携带新事件版本，或允许明确的 resurrection 操作；随后让 delta、Hub winner 与文档使用同一规则。若保留当前接口，state 中 `previous.deletedAt` 应触发明确上传，但 Hub 仍需安全区分陈旧重放与主动复活。

#### 5. invalidate 无事件版本保护，延迟旧删除可覆盖较新的复活

- **证据**：`src/shared/catalogStore.js:342-359` 每次都使用服务端当前时间，并无客户端事件时间、基础版本或与现存行状态的比较。
- **复现**：客户端发出 delete 后又以更新内容复活；旧 delete 因网络重试晚到，Hub 再次把新记录 tombstone。重复 delete 还会不断刷新 `deletedAt`，导致 since 读取反复出现同一删除。
- **影响**：乱序请求无法收敛到最近用户意图，并产生增量读取噪声。
- **修复建议**：invalidate 携带可验证的事件版本/时间并采用条件更新；幂等重复请求不得刷新已存在的同一墓碑。

#### 6. `mergeRemoteCatalog` 的同时间冲突规则与 Hub 的 local-title 优先规则不一致

- **证据**：`src/shared/catalogSync.js` 的 `mergeRemoteCatalog()` 使用 `>=` 接受远端同时间项，但没有执行 Hub winner 的“local 胜 fallback”规则。
- **复现**：本地 state 是同时间戳 local title，Hub 返回同时间戳 fallback title；合并后本地优质来源可能被降级。
- **影响**：本地 checkpoint 与 Hub 冲突规则漂移，可能造成重复上传、标题降级或状态判断不稳定。
- **修复建议**：提取并复用统一的 winner 比较器；为 local/fallback 两个方向的同时间 merge 补测试。

#### 7. invalidate 的 malformed-key 响应与 API 文档不符

- **证据**：`docs/API.md:569` 声称 malformed keys 会被计数；`src/shared/catalogStore.js:355-357` 对非法 key 直接 `continue`，返回值只有 `invalidated`，没有 rejected/malformed 数量或明细。
- **复现**：一批 keys 混入非法 client/空 sessionId，响应无法告知哪些条目被忽略。
- **影响**：客户端可能将“静默丢弃”误判为成功，推进本地 checkpoint，删除永久丢失。
- **修复建议**：像 upsert 一样返回 rejected keys/计数，并让客户端只 checkpoint 已接受删除；或者修改协议并禁止调用方把静默忽略视为成功。

#### 8. SSE exact-match nginx location 未限连接，持密钥客户端可耗尽长连接资源

- **证据**：`deploy/nginx/token-monitor-hub.conf` 的 `/api/stats/stream` exact-match location 未配置 `limit_req` 或 `limit_conn`；通用 location 的限流不会自动继承到独立 location。每个 SSE 连接长期占用 nginx/Hub socket 和 heartbeat/timer。
- **复现**：持有共享密钥的客户端并发建立大量 SSE 连接且保持不关闭。
- **影响**：单个已授权但异常/恶意客户端可造成资源耗尽，影响所有设备同步。
- **修复建议**：为 SSE 单独配置合理的 `limit_conn`（以及合适的建连频率限制），并验证正常多设备重连不被误伤。

## 验证盲区

- 当前 focused tests 44/44 全过，但未覆盖上述乱序时序：删除时间晚于 stale-upsert 内容时间、unknown-key delete-before-upsert、delete-after-resurrection、同时间 local/fallback 远端合并、客户端相同元数据显式复活。
- 本轮为审查，不修改代码；阿里云真实部署、两台设备错峰互看仍需真实环境验收。

## 修复记录（2026-08-17 返工）

全部 8 项已闭环，按问题编号逐条：

| # | 级别 | 修复 |
|---|---|---|
| 1 | 严重 | Hub 入库前统一调用 `normalizeCatalogEntry`（`catalogStore.js` 的 `upsertEntries`），不再信任客户端已清洗；并新增服务端路径形态校验——`sessionCatalog.js` 的 `sanitizeWorkspaceKey` 丢弃含 `/\` 的 path-shaped `workspaceKey`、`sanitizeWorkspaceLabel` 把 path-shaped `workspaceLabel` 收成 basename。`normalizedToRow` 显式忽略 upsert 传入的 `deletedAt`。回归测试：`hub re-sanitizes path-shaped workspace fields and control chars`、`upsert ignores deletedAt`、`normalizeCatalogEntry sanitizes path-shaped workspace fields`。 |
| 2 | 严重 | 墓碑冲突 winner 增加删除时间守卫：`winnerExpr` 追加 `AND (deleted_at IS NULL OR excluded.updated_at > deleted_at)`，禁止 `incoming.updated_at <= deleted_at` 的 upsert 清除墓碑。测试改为显式 `deletedAt` 并断言「内容时间介于原记录与删除时间之间」的旧副本不复活。 |
| 3 | 严重 | `invalidateKeys` 改为 `INSERT … ON CONFLICT DO UPDATE`，对未知 key 也落墓碑（`title=''` 的墓碑行），delete-before-upsert 竞态不再复活。测试：`invalidating an unknown key stores a tombstone…`。 |
| 4 | 一般 | 显式复活统一到「严格更新事件时间」协议：客户端 `computeCatalogDelta` 在 `previous.deletedAt` 存在且条目重现时，用 `monotonicAfter(deletedAt)` 生成严格更新的 `updatedAt` 上传；Hub winner 用同一规则（#2 的守卫）接受。文档 `API.md` 同步。测试：`an entry that reappears after an explicit delete is resurrected with a newer event time`。 |
| 5 | 一般 | invalidate 携带客户端事件时间 `deletedAt` 并做条件更新：live 行 `eventTime >= updated_at` 才落墓碑、已删除行 `eventTime > deleted_at` 才刷新；幂等重复与延迟旧删除均为 no-op。测试：`repeating the same delete is a no-op`、`a delayed retry of an older delete cannot clobber a newer resurrection`。 |
| 6 | 一般 | 抽取统一比较器 `remoteEntryWins`（镜像 Hub `winnerExpr`，含 tie 时 local 胜 fallback 与墓碑守卫），`mergeRemoteCatalog` 改用它；补 local/fallback 双向同时间合并测试。 |
| 7 | 一般 | `invalidateKeys` 返回 `rejected` + `rejectedKeys`（`reason: 'invalid_key'`）；`uploadCatalogDelta` 收集 invalidate 的 rejectedKeys，`runCatalogSync` 经 `checkpointAccepted` 只 checkpoint 已接受的删除。测试：`invalidate reports malformed keys`、`uploadCatalogDelta surfaces invalidate-rejected keys`。文档 `API.md` 同步响应示例。 |
| 8 | 一般 | nginx 增加 `limit_conn_zone hub_stream`，SSE exact-match location 加 `limit_conn hub_stream 10`，单 IP 限 10 条长连接，多设备 NAT 不误伤。 |

补的乱序/恶意载荷回归测试共 11 个，集中在 `tests/shared/catalogStore.test.js`（服务端）、`tests/shared/catalogSync.test.js` / `catalogSyncRuntime.test.js`（客户端）、`tests/shared/sessionCatalog.test.js`（共享清洗）。

`scripts/hub-build-manifest.js` 的 `NODE_RUNTIME_SOURCE_FILES` 增补 `sessionCatalog.js`、`hashKey.js`（catalogStore 的新传递依赖），`npm run update:hub-build` 已重跑。

## 结论

**已返工并闭环。** 3 项严重问题（服务端隐私再清洗、墓碑删除时间守卫、未知 key 墓碑）与 5 项一般问题全部修复，客户端/服务端/文档三方使用同一事件时间与冲突规则，并补齐乱序与恶意载荷回归测试。

- `npm run lint` 干净；`npm test` 3197 项中 3189 通过、7 跳过、1 失败（`macWidgetLaunchServicesRecovery` Windows symlink EPERM，改动前即存在的环境性失败）。
- Catalog 专项测试 70/70 通过（含新增 11 项乱序时序测试）。
- 仍待真实环境验收：阿里云 ECS 部署、两台设备错峰互看。

## 本轮更新复核（2026-08-17）

### 审查范围

针对上一轮返工后新增的未提交修复，复核 3 项问题：主键规范化一致性、客户端远端墓碑合并规则、删除后重现条目的事件时间收敛。复核方式：运行 Catalog 专项测试、完整 lint/test，并进行对抗式复查。

### 修复确认

- **主键规范化：已修复。** `invalidateKeys` 改用 `normalizeCatalogKey`，与 `normalizeCatalogEntry` 的 `sanitizeId` 规则一致；双空格和 Unicode 分解字符回归测试均通过，不再生成幽灵墓碑。
- **远端旧墓碑覆盖新内容：已修复。** `mergeRemoteCatalog` 对 live 条目要求 `remoteDeletedAt >= updatedAt`，对已删除条目要求删除时间严格递增；专项测试通过。
- **复活事件时间间隙：已修复。** 只要本地存在 `deletedAt` 且重现条目的时间不严格晚于删除时间，即使用 `monotonicAfter` 制造严格更新事件；针对 `01:30` 内容时间与 `02:00` 删除时间的回归测试通过。

### 验证记录

- `npm.cmd run lint`：通过。
- `node --test tests/shared/catalogStore.test.js tests/shared/catalogSync.test.js tests/shared/sessionCatalog.test.js`：58/58 通过。
- `npm.cmd test`：3194 通过、7 跳过、1 失败（`tests/electron/macWidgetLaunchServicesRecovery.test.js` 在 Windows 创建 macOS 模拟 symlink 时因 EPERM 失败；与本轮改动无关，且此前已有该环境限制）。
- `git diff --check`：通过。
- 对抗式复查：严重/一般问题 0；建议 2 项：`mergeRemoteCatalog` 当前无生产调用方（死代码，单测已覆盖），以及读侧 `listSessions` 对 deviceId 仍使用旧 `cleanText` 规则导致极少见的特殊 deviceId 过滤不一致。两项均非本轮新增回归，不阻塞交付。

### 本轮结论

本轮 3 项一般问题均已真实消失，新增修复可交付。保留 Windows symlink 环境性测试失败与真实 ECS/双设备验收待办。

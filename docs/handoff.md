# 交接

> 每轮执行完成时由开发方更新；接手方、审查方必读。每轮完成后归档。

## 最近一轮

- 时间：2026-08-18（删除容量预估）
- 已删除面向用户的 GPT/Codex 与 OpenCode Go 两张额度趋势卡，以及启用、备用容量、安全预留三项设置和对应 CSS/脚本入口。
- 已删除 `src/shared/quotaTokenEstimate.js`、Worker 生成副本及专用容量测试；主进程不再采集或同步 capacity、weights、samples、剩余 Token、预计可用时间等推算数据，Hub/Worker 也会丢弃旧 `quotaTokenEstimate(s)` 字段。
- **百分比观测保留且解耦**：新增 `quotaPercentageHistory.codex/opencode`，由主进程的 Device Runtime record 路径自动记录，不依赖 renderer 是否打开。两者分别按账户长期保存官方 `remainingPercent`、ISO `at`、可选 `resetsAt` 及审计用累计 components，不设条数上限；连续相同百分比的平台期只保留首次与最后一次确认，中间重复轮询压缩掉，百分比变化点完整保留。limits-only 更新按 provider 合并，不覆盖另一条历史。
- 旧 settings 中 calibration observations 会尽力迁移到新历史；新同步字段经过 Node/Worker 同一净化逻辑，只出现在认证后的 `devices[]`，公共统计不会暴露。
- 保留独立有用的 provider 归属统计（`providerTokens/providerCosts/...`）。OpenCode Go 的审计 components 只取 `provider=opencode-go`，它们不再进入容量推算、权重拟合、剩余 Token 或可用时间投影。
- 审核加固：历史结构升级为 provider→accounts→accountKey；Electron/headless 都本地持久化；普通 `/api/ingest` 永远剥离长期历史，改由认证 `/api/quota-history` 每批最多 200 条增量上传；Node/Worker Hub 按账户与时间幂等合并。上传游标记录已确认的时间戳集合，迟到的旧时间观测仍会补传。
- 验收：ESLint 通过；聚焦 67/67；完整测试 3509 项中 3502 通过、0 失败、7 跳过；Hub build registry 与 Worker 生成副本已同步。

## 上一轮

- 时间：2026-08-18
- 已完成：GPT（Codex）额度趋势卡优化 + 新增 OpenCode Go 额度趋势卡（与 GPT 一致，token 容量口径）。
- Q1：修复周期切分——`cycleSummaries`/`advanceCalibration`/`rawCapacityFromObservations`/`intervalRows`
  四处不再用 `resetsAt !==` 判定周期边界（上游滚动/相对时间戳会漂移、误切同一周期），改为「remainingPercent
  回升 >1」这一可靠重置信号；`resetsAt` 仅作展示。
- Q2：重写预估总容量算法——按「整周期全量回归（已封存周期首尾两点）→ 累计比值 + 加权分位数 → 当前周期
  消耗硬下限 → 官方变化回补（历史锚点与当前累计比值衰减融合）」分层；无完整周期样本时退化为「累计口径」
  线性外推（卡片标注「（累计口径）」），不再造假中位数。
- Q3：精简 GPT 卡——删除「多设备今日全部工具 Token」「估算可信度」「历史容量样本」「已覆盖额度周期」
  「已采集时间点」及底部废话文案。
- G1：`quotaTokenEstimate` 闭包提取 `DEFAULT_CLIENT_ID`，client 不再硬编码，可复用周期切分与容量锚点。
- OpenCode Go 卡：与 GPT 卡完全同构（官方剩余额度 / 预估总容量 token / 预估剩余 Token / 保守剩余 Token /
  缓存命中比例 / 预计还能使用 / 多设备今日 OpenCode Token / 额度周期 Token 记录），复用同一套
  `quotaTokenEstimate` 算法，client 用 `opencode`、provider 用 `accountLabel === 'Go'` 的 opencode 条目。
- OpenCode 校准隔离：新增 `quotaTokenEstimate.opencodeCalibration` 字段（与 codex 的 `calibration` 并列），
  `main.js` defaultSettings + `normalizeQuotaTokenEstimate` 均含该字段，避免两 provider 观测历史互相污染。
- 删除废弃模块：`src/shared/opencodeGoQuota.js` 及其测试（上一版「美元+请求数」口被 token 口径取代），
  并移除 renderer 里的 `formatQuotaCny` 与 `index.html` 的脚本标签。
- 同步：`quotaTokenEstimate.js` 属 hub 核心闭包，已 `npm run sync:worker` 同步 vendored 副本并更新
  hubBuildRegistry。
- 审查：多轮对抗式审查收敛（先前的 7 个问题已修复；本轮改造后复查 0 严重/一般）。
- 验证：全量 3507 测试 3499 通过（唯一失败为既有 Windows symlink `EPERM`，macWidget 夹具，与本轮无关）；
  ESLint 全量通过；Hub build 13/13。
- 提交：本轮新增 `feat(opencode): mirror the GPT token-capacity card`、`fix(opencode): seed opencodeCalibration`
  （续接此前 `870721c` … `1de70c6` 等）。

## 已知限制

- 旧版 `settings.json` 中可能仍有废弃的 `quotaTokenEstimate` 键；新版不读取、不回写，也不会向 renderer 暴露或产生计算调用。
- 源会话未记录工作目录时工作空间显示 `—`（历史遗留）。

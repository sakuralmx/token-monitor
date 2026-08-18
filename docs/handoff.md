# 交接

> 每轮执行完成时由开发方更新；接手方、审查方必读。每轮完成后归档。

## 最近一轮

- 时间：2026-08-18（删除容量预估）
- 已删除面向用户的 GPT/Codex 与 OpenCode Go 两张额度趋势卡，以及启用、备用容量、安全预留三项设置和对应 CSS/脚本入口。
- 已删除 `src/shared/quotaTokenEstimate.js`、Worker 生成副本及专用测试；主进程不再归一化设置、采集校准、生成 `quotaTokenEstimate(s)` 快照，Hub/Worker 归一化也会丢弃旧设备发来的历史字段。
- 保留独立有用的 provider 归属统计（`providerTokens/providerCosts/...`），它只说明 API 路由，不再进入容量推算、权重拟合、剩余 Token 或可用时间投影。
- 验证：目标源码/Worker/脚本检索均为 0 命中；旧 wire 字段仅在负向回归测试中作为输入并确认被丢弃。聚焦数据流测试 90/90、全量 lint、Hub build 13/13 通过。全量 `npm run verify` 3483 通过、2 失败：既有 Windows symlink `EPERM`，以及一次并行环境中的 Undici `bad port`；后者单独复跑通过。

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

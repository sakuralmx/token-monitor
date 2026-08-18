# 交接

> 每轮执行完成时由开发方更新；接手方、审查方必读。每轮完成后归档。

## 最近一轮

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

- 「充值/部分回充」与「满额重置」在无可靠 server 重置时间戳时不可区分，周期边界沿用百分比回升 >1 的
  启发式（`quotaTokenEstimate.js` 已注释说明）。
- **OpenCode Go 校准暂不跨设备同步**：`summaryWithQuotaTokenEstimate`（`main.js` 2350）目前只把 codex 的
  `calibration` 快照写入 device record，opencode 的 `opencodeCalibration` 未同步；每台设备各自从本机观测
  积累 opencode 容量。opencode 的 token 用量本身（`periods.*.clients.opencode`）仍随 device record 正常
  跨设备聚合，故「多设备今日 OpenCode Token」正确、但「预估容量」依赖本机历史。
- OpenCode Go 官方 API 不返回 `used`/`limit`，只给 percentage；剩余额度由百分比 + 官方总额度推导。
- `opencode` 的 token 统计依赖 tokscale 在本机（或 WSL）读到 `opencode.db`；本机无误记录时 token 显示 0
  是数据缺失而非渲染 bug。
- 源会话未记录工作目录时工作空间显示 `—`（历史遗留）。

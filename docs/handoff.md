# 交接

> 每轮执行完成时由开发方更新；接手方、审查方必读。每轮完成后归档。

## 最近一轮

- 时间：2026-08-18
- 已完成：GPT（Codex）额度趋势卡优化 + 新增 OpenCode Go 统计卡（人民币计价）。
- Q1：修复周期切分——`cycleSummaries`/`advanceCalibration`/`rawCapacityFromObservations`/`intervalRows`
  四处不再用 `resetsAt !==` 判定周期边界（上游滚动/相对时间戳会漂移、误切同一周期），改为「remainingPercent
  回升 >1」这一可靠重置信号；`resetsAt` 仅作展示。
- Q2：重写预估总容量算法——按「整周期全量回归（已封存周期首尾两点）→ 累计比值 + 加权分位数 → 当前周期
  消耗硬下限 → 官方变化回补（历史锚点与当前累计比值衰减融合）」分层；无完整周期样本时退化为「累计口径」
  线性外推（卡片标注「（累计口径）」），不再造假中位数。
- Q3：精简 GPT 卡——删除「多设备今日全部工具 Token」「估算可信度」「历史容量样本」「已覆盖额度周期」
  「已采集时间点」及底部废话文案。
- G1：`quotaTokenEstimate` 闭包提取 `DEFAULT_CLIENT_ID`，client 不再硬编码，美元单位 observation 可复用
  周期切分与容量锚点。
- G2：新增 `src/shared/opencodeGoQuota.js`（UMD），内置官方分模型请求数表（每 5h/周/月）、固定美元额度
  $12/$30/$60（env 可覆盖）、百分比→美元→请求数换算、百分比 clamp 与 env 缩放。
- C1：GPT 卡与 OpenCode Go 卡金额用人民币（`formatQuotaCny` 复用 currencyApi 汇率链），存储/同步仍 USD。
- G3：渲染 OpenCode Go 卡（与 GPT 卡并列、含周期数 session/weekly/monthly、请求数估算、多设备今日 OpenCode
  Token）；无 Go 订阅（accountLabel≠'Go'）时隐藏。`index.html` 增加 `opencodeGoQuota.js` 脚本。
- G4：OpenCode Go 无需 codex 那套校准快照（官方额度固定），多设备汇总沿用现有 stats 聚合；无独立代码改动。
- 同步：`quotaTokenEstimate.js` 属 hub 核心闭包，已 `npm run sync:worker` 同步 vendored 副本并更新
  hubBuildRegistry（worker 副本 + 两端 registry 一致）。
- 审查：四轮对抗式审查发现 7 个问题全部修复，第五轮收敛零问题（见 `docs/review.md`）。
- 验证：全量 3517 测试 3509 通过（唯一失败为既有 Windows symlink `EPERM`，macWidget 夹具，与本轮无关）；
  ESLint 全量通过；Hub build 13/13。
- 提交：`Q1 870721c` `Q2 3f28673` `Q3 0188300` `G1 9931bf9` `G2 a664ca1` `C1+G3 9090a36`
  `chore(hub) c24bfba` `fix c541271` `fix 5beb64f` `fix 087c564` `chore(hub) 1de70c6`。

## 已知限制

- 「充值/部分回充」与「满额重置」在无可靠 server 重置时间戳时不可区分，周期边界沿用百分比回升 >1 的
  启发式（`quotaTokenEstimate.js` 已注释说明）。
- OpenCode Go 的请求数估算依赖「今日主导模型」（`clientModels.opencode` 按 token 量取最大）；无模型或未知
  模型时仅显示美元额度、不显示请求数。
- OpenCode Go 官方 API 不返回 `used`/`limit` 美元值，剩余美元由固定额度 $12/$30/$60 与 percentage 推导；
  官方调整额度需改 `DEFAULT_GO_LIMITS`（或 env `TOKEN_MONITOR_OPENCODE_GO_LIMITS`）与 `opencodeGoQuota.js`
  的请求数表。
- 源会话未记录工作目录时工作空间显示 `—`（历史遗留）。

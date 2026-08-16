---
name: dev-flow
description: 项目协作开发流程。用户说「开始规划」「拆任务」「接手执行」「你来审查」「收工交接」时，按本流程执行：规划写 docs/plan.md，拆任务写 docs/tasks.md，执行按任务包实现并 commit，审查写 docs/review.md 分级问题清单，交接更新 docs/handoff.md。模型分工：GPT 规划/拍板，DeepSeek V4 Pro 开发，V4 Flash 拆任务与快检，Claude/Grok 异源审查。
whenToUse: 用户在本工作区说「开始规划 / 拆任务 / 接手执行 / 你来审查 / 收工交接」任一句时。
---

# dev-flow 协作流程

用户说出短指令时直接执行，不要反问。

每条短指令分「默认版」和「插件版」：只说短指令走默认版（不调用插件）；说「用 XX 插件」走插件版，
但插件结果必须落地成 docs/ 文件并 commit。

## 短指令 → 流程映射

- 「开始规划」：读项目现状 → 写 docs/plan.md（目标/技术栈/任务清单带验收标准/风险点）→ git commit。
- 「拆任务」
  · 默认版：读 docs/plan.md → 写 docs/tasks.md（任务 id/描述/依赖/验收标准）→ git commit。
  · 插件版（All in Luna）：仅在 allinflash profile 会话中可用（web 会话无其工具）→ 原样抄进 docs/tasks.md → git commit。
- 「接手执行」
  · 默认版：读 docs/plan.md、tasks.md、handoff.md（若有）→ 逐任务实现，每任务 git commit（含任务 id）→
    完成后更新 docs/handoff.md 并 commit。
  · 插件版（All in Luna）：仅在 allinflash profile 会话中可用 → 结果原样抄进 docs/handoff.md → commit。
- 「你来审查」
  · 默认版：读 docs/plan.md、handoff.md、最近 git diff → 逐任务对照验收标准找 bug（逻辑/边界/性能/安全）→
    写 docs/review.md（严重/一般/建议分级 + 复现 + 修复建议），小问题直接修并 commit。
  · 插件版：用 dsh-agent-teams 组异源审查团队（成员各配不同 provider/model，如 deepseek-v4-pro + 意心
    claude-sonnet-5 + gpt-5.6-terra），让每个成员各自调用 dsh-inspect 的 checkup/review 做对抗式审查，
    队长汇总后写进 docs/review.md，commit。审查范围由用户决定，默认本次更新内容（首次即全量）。
- 「收工交接」：更新 docs/handoff.md → 把上一轮 handoff/review/tasks 归档到 docs/archive/（<日期>-<功能>.md）→ git commit。

## 落地铁律（插件版专用）

插件产出是中间产物，不是交接文件：dsh-agent-teams 产出 `.agent-teams/` 目录、dsh-inspect 产出对话内报告、
All in Luna 产出独立 profile 的 run state。落地规则（防失真）：**原样转存，不擅自提炼**——关键产出
（问题清单逐条、复现方式、修复建议、结论）逐字写进 docs/ 对应 md 文件，不概括删减；原始产物目录
（如 `.agent-teams/`）保留并 git 提交供回查。任何插件流程结束时，docs/ 必须已更新且工作树干净。

## 铁律

1. 任何操作前 git status，工作树不干净先处理。
2. 开工先读 docs/ 下交接文件；上下文靠文件传递。
3. 同一时间只让一个工具改代码。
4. 每轮结束必须 commit。
5. 审查范围由用户决定，默认审查本次更新内容（相对上次审查/commit 的增量；首次即全量）；审查目标是合格（无 bug、无错误），不以省成本为优先。

## 模型选择提示

- 开发与拆任务用 deepseek-official（v4-pro / v4-flash，便宜）。
- 「你来审查」优先选与开发不同的模型来源：意心（claude-opus-5 / claude-sonnet-5 / grok-4.6 /
  gpt-5.6-terra / codex-auto-review），按量计费，只审 diff 与关键文件，避免全仓烧钱。
- 若用户明确要求便宜审查，可用 deepseek-official 独立会话同源审查（效果打折，兜底用）。

# web 设计规则债务清单（2026-11-22 盘点）

范围：17 个契约文件，14 条存量失败（早于重构批次存在，stash 基线甄别过）。运行：
`cd platform/packages/web && corepack pnpm exec vitest run test/deslop.test.ts test/icon-registry.test.ts …`

## 命中集中区（deslop 7 条规则的源位置抽样）

- `pages/account-center.css`（约 10 处：transition: all / transform / 时长 / :active scale）
- `features/admin/admin-skill-versions-page.css`（约 6 处）、`admin-layout.css`、`admin-skills-page.css`、`admin-tools-page.css`
- `features/qa/project-management/project-management.css:268`（transition: width）
- 规则 12/13：间距与字号 rhythm 违例分散在旧 CSS（11px/12.5px 等非节奏值）

## 其他失败契约（每条需单独归因）

- icon-registry「every line glyph drawn from registry」/ icon-scale
- menu-style、required-mark（✓ vs Select 勾）、form-commit-guard（表单注册表）、
  inner-html-stability、install-scope、no-native-title、plugins-page-stability、
  clipboard、markdown-pipeline、todo-persistence、history-load-failed、machine-sync-notices、trace-round-nav

## 处理原则（沿用 deslop 测试自己的口径）

"Fix a new hit rather than allowlisting it; when a hit goes away, shrink its entry."
每修一处需要对该页面做一次视觉核对（都是既有页面的动效/排版行为）。建议：按页面分批
（account-center 一批、admin 各页一批、qa 旧 css 一批），每批修完跑对应页面契约 + 人工过一眼。

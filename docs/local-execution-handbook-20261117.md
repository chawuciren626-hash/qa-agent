# 本地执行交接手册（云端 Agent → 本地 Agent，2026-11-17）

> 背景：规划与验收由 Codex 负责（批次清单），执行由 WorkBuddy 本地实例负责。本手册给**本地执行的 Agent**：拿到批次清单后按此开工，不必重新探索仓库。
> 仓库：`https://github.com/chawuciren626-hash/qa-agent.git`（云端工作已于 `d8fbec1` 全部推送，本地 clone 即最新）。
> 本地机参考环境：Windows（`E:\AITestHarness\...`），Node + Python 双栈。

## 0. 角色与节奏

- **Codex**：列待执行批次、定验收标准、最终验收。
- **本地 Agent**：按批次执行（编码 + 回归 + 提交推送），每批次完成后在本文档 §5 打卡。
- **用户**：只在批次边界做决策（如渠道密钥策略、页签栏这类产品拍板）。

## 1. 环境准备（一次性）

| 项 | 要求 | 验证命令 |
|---|---|---|
| Node | ≥ 22 | `node -v` |
| Python | 3.11+，pytest 可用 | `python -m pytest --version`（Windows 无 `python3`，用 `python`/`py`） |
| Python 依赖 | 仓库根 `requirements-ci.txt` | `pip install -r requirements-ci.txt` |
| Playwright 浏览器 | Chromium（`playwright.config.ts` 已指定本机路径，Windows 下按需改 `executablePath`） | `npx playwright install chromium` |
| Git 凭据 | 用户提供的 PAT 或已登录凭据助手 | `git ls-remote origin main` |

注意：`ci:irval` 脚本里写的是 `python3 -m pytest`，Windows 下直接执行 `cd aitestharness-ir && python -m pytest tests -q`。

## 2. 每批次固定工作流

1. **开工前**：`git pull origin main` 确认与远端一致；读该批次的开工卡（§4 或 Codex 另发）。
2. **执行**：只动开工卡列出的文件面；边界外文件出现冲突迹象立即停下问用户。
3. **回归（每次提交前全跑）**：
   - `npm run ci:tools`（工具包冒烟）
   - `cd aitestharness-ir && python -m pytest tests -q`（契约校验器，114 用例）
   - `cd platform/packages/server && npx tsc --noEmit -p .`
   - `cd platform/packages/web && npx tsc --noEmit -p .`
   - 涉及运行时行为时加 `npm run test:core`
4. **提交**：一条批次一个（或按逻辑分几个）commit，信息格式 `feat/fix/docs(域): 一句话说明`；推送 `main`。
5. **打卡**：在 §5 表格勾完成、贴 commit hash。

## 3. 冲突边界（不许主动触碰的文件面）

| 归属 | 文件/机制 |
|---|---|
| Codex 批次 1-5 | 工具执行通道（central-tools/tool-gate）、onboard 建档、plan.gates/irval 接入、装配器/条款化、缺陷闭环 |
| 已由云端完成、勿回退 | 用户级模型配置（`user-models.ts`/`project-config-service` 共享模型机制）、渠道管理（`admin-channels-page.tsx`/`control-plane /channels`）、管理后台布局（`admin-layout.*`）、设置页模型卡片（`user-models-settings.tsx`） |
| 挂起等批次 1 | Agent 设置页平台工具只读区块（见 `gap-inventory-20261116.md` 追加节） |
| 无人认领可做 | CI tsc 门禁、e2e 冒烟三链、qa_* 索引清单（见 `db-table-audit-20261116.md` §A 档合并，动库前须用户点头） |

## 4. 待执行批次清单（Codex 填写）

> Codex 列出后逐条追加到这里；每条含：目标 / 文件面 / 验收命令 / DoD。

（待填）

## 5. 执行打卡

| 批次 | 状态 | commit | 备注 |
|---|---|---|---|
| （待填） | | | |

## 6. 已知坑（云端踩过，本地同样注意）

- `config/tool-runtime-state.json` 是运行时状态文件，会自己变脏——提交时**不要**带上它。
- 前端主题 token 是自定义的（`bg-surface-muted`/`border-line-muted`/`text-fg-subtle`），Tailwind 没有 `surface-card`/`scrollbar-thin`，用任意值语法 `[scrollbar-width:thin]`。
- 共享模型记录 schema 强校验：手工拼 `.account-models/*.json` 少字段会让建项目 500，写它必须走 `publishSharedModels`/`publishUserModelBlock` 同构组装。
- `readRaw` 会因磁盘 stat 清缓存：内存态视图要临时接管（参考 `modelViewOfRaw` 的做法）。
- Playwright 的 host 白名单只认 `localhost`（不是 127.0.0.1）。

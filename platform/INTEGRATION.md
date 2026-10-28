# AITestHarness source integration

This directory is the editable platform source of AITestHarness, imported from the exact upstream revision in `upstream-source.json`. `LICENSE` and `THIRD-PARTY-NOTICES.md` remain authoritative for their respective components. It is not a submodule or a second Git repository. Upstream development instructions, historical changelogs, release workflows and Git metadata were not imported.

The repository root remains the testing engine: `scripts/`, `schemas/`, `skills/`, `penguin/` and `config/`. Keeping these paths preserves existing test and artifact contracts during migration. Platform changes are compiled from TypeScript/React source; do not run the legacy bundle patch installer against source-built output.

## Runtime contract

- `AITEST_ENGINE_ROOT` selects the testing engine from installation or development configuration; no machine-specific path is embedded in source.
- The source integration is opt-in so the upstream test harness can still exercise generic behavior without a testing-engine environment.
- Project membership and administrator permissions are enforced by the server, not by hiding front-end controls.
- Existing installed application data is not used by build/test runs. Deployment requires a separate successful source build, integration verification, backup and closed/idle application checks.
- Imports and modifications here do not authorize commits, pushes, releases, or model-backed acceptance runs.

## Modified-source record

AITestHarness modifications are maintained in this Git branch. Product-specific runtime integration lives under `packages/core/src/integrations/`; server and UI changes use ordinary source imports and routes. `upstream-source.json` identifies the baseline for comparison. The original root-level engine and compatibility installer remain available for rollback until source integration acceptance is complete.

## Build and run the development Web application

Use Node.js 24+ and pnpm 11. From the repository root:

```sh
pnpm --dir platform install --frozen-lockfile
pnpm --dir platform --filter '@prismshadow/penguin-server...' --filter '@prismshadow/penguin-web...' -r build
node scripts/start-source-platform.mjs --data-root=/absolute/separate/development-directory --port=7378
```

The launcher binds loopback only and creates separate `host`, `qa`, and `workspaces` directories. Use a dedicated directory outside the checkout and installed application's data. The first-run admin claim link is printed by the server; treat it as a credential. The launcher does not import existing account credentials, create an installer, or modify the installed desktop. Set `PENGUIN_SHELL` to a compatible Bash executable when testing the shell-dependent upstream suite on Windows.

From **Agents → Project testing workflow**, an owner can initialize the ten bundled testing roles. Members can use the resulting workflow. Existing colliding roles are refused, and repeat initialization does not overwrite role edits. Projects are enabled only after role resources and hooks are installed. `QA_WORKSPACE_ROOT` supplies project-scoped session directories; a trace-less session restored by its saved id keeps its original directory.

## Integration seams

### Administrator publication extensions (2026-10-27)

The `/admin` and `/user` route basenames share the upstream App, providers and page renderers. Local Web administration reuses AgentsPage, CreateAgentDialog, AgentSettingsPage, ModelsPage, PluginsPage and SkillsTab. AppLayout accepts optional navigation/toolbar slots; its runtime overlays, shortcuts and native update paths remain in place. The central identity-only deployment exposes accounts, grants and publication storage, and does not mount project/workload providers.

Publication sources use explicit public-field projections, original skill archive export/import and versioned references to the native plugin library. Credentials, project snapshots, histories and workspaces are not publication DTOs. A small ManagedResourceSection within existing user pages shows authorized administrator configurations; it does not replace native kernel/plugin/model update checks. Published drafts/versions, audience checks and local application metadata are extension seams, not a new plugin installer.

Before an upstream upgrade, compare these seams against the pinned source in upstream-source.json, keep the original page/API behavior, and rerun permission, public-projection, archive, native model/agent and update-badge regressions. Build and smoke-test a separate runtime before the stopped-installation backup/hash/swap workflow. Never run an upstream installer over the managed host. See ../docs/upstream-reuse-admin-2026-10-27.md for the current evidence and limitations. Earlier roadmap statements below about central publication being pending are superseded only for the explicit publication subset described there; task capability snapshots remain pending.

- Core: bound workspaces; controller and child hooks; structured command requests; trace/input protection; child cancellation and human continuation; background completion for testing workspaces.
- Server: project-owner initialization; project-authorized evidence and human-action endpoints; desktop-only native document open; existing library operations; protected queue and steering input.
- Web: testing entry, controller navigation, human-action cards, deliverable downloads, native-open actions, question bookmarks, and project/account-scoped personal library operations. Upstream user/project/plugin management remains available.
- Trace readers: accept both legacy `stop_reason` and current `status`, refusing contradictory outcomes without rewriting old trace files.

## Validation commands

```sh
pnpm --dir platform/packages/server typecheck
pnpm --dir platform/packages/web typecheck
pnpm --dir platform/packages/server exec vitest run test/admin-users.test.ts test/authz.test.ts
pnpm --dir platform/packages/core exec vitest run test/subagent.test.ts test/environment.test.ts test/qa-request.test.ts
```

Set `AITEST_ENGINE_ROOT` to this repository's absolute path to run `test/qa-workspace.test.ts` in core and `test/qa-integration.test.ts` in server. These use temporary data and synthetic credentials, and issue no model requests. The root `scripts/run-engineering-tests.mjs` runner separately verifies existing QA contracts in an isolated engine copy.

## Source desktop and local synchronization

Build the Core, Server, CLI, Desktop and Web packages with Node.js 24+. `scripts/source-runtime.mjs` stages the application separately and records application/engine hashes. `scripts/smoke-source-desktop.mjs` checks a fresh isolated desktop profile. `scripts/sync-source-runtime.mjs` synchronizes only a stopped local installation, verifies backups of persistent stores, preserves local engine configuration, and rolls back component replacement on failure. Existing owned QA roles can be adopted without overwriting user edits. The installed launcher verifies the source manifest and supplies the configured engine and data paths.

The managed desktop does not use upstream installers. Its update UI explains that compatible local synchronization or a product release is required; a central product update feed is not implemented. Do not apply the legacy exact-bundle patch installer to source builds.

## Verification and remaining acceptance

Source builds, targeted Core/Server/Web/Desktop regressions, library browser persistence checks, isolated desktop smoke, and installed-runtime integrity/startup checks have passed. The local runtime was synchronized with verified backups; authenticated read-only endpoints confirmed version 0.2.17 and eight enabled QA roles.

`packages/core/test/qa-source-replay.test.ts` exercises functional, API and mixed tracks using actual Agent/subagent sessions, hooks and artifact exporters with synthetic model responses. Execution is deliberately blocked without a target, and reports retain that limitation. This is engineering validation, not real model/business acceptance or a complete HTTP end-to-end run. Reports remain HTML only. Local business acceptance remains the user's next step.

The original testing presentation is now compiled through `features/qa/workspace-ui.tsx`: home, local project groups, sidebar, onboarding, schedules, library with local artifacts, and session context reuse the shared product module and styles. Native session actions and navigation tools are adapted to the source platform. Local presentation groups retain their existing storage scope and draft/session bindings; they remain distinct from server permission projects. Personal documents are not automatically ingested as test inputs. Central capability publication, personal Skill selection and task version snapshots remain Week 2 work. Node review modes and the later project knowledge, memory, defect and automation capabilities remain on the broader plan.

## Business projects and workspaces (2026-10-26)

The original sidebar grouping entry is now named **工作空间**; existing local storage keys, folder references and session bindings are preserved. The new **项目视图** (`/qa/project`) selects and creates real upstream business projects. The testing sidebar also exposes the business-project selector. Switching projects retains the upstream account/member access rules and resets task context; it does not move or delete existing files.

New projects (including newly provisioned user projects) install the ten bundled testing roles within project creation's rollback boundary. A fresh admin installation does too. Existing projects are not overwritten: uninitialized ones retain their explicit initialization/adoption path. This is bundled-template provisioning, not yet centrally published administrator edits or immutable capability versions.

The project view lists all project sessions through the backend, excluding child/company sessions, and reads bounded, task-owned workflow manifests. Stage states come from those manifests; the view never turns an idle conversation into a passed test. Registered existing XLSX case files, defect artifacts and HTML reports are grouped into separate views with downloads and source-task links. Missing/unreadable files and truncated run history are disclosed. Legacy manifests without unambiguous task ownership are not guessed. This is a read-only overview, not a case/defect CRUD system. Local workspace names are still account/browser scoped; another browser can view project tasks but may see them ungrouped. Project memory, shared knowledge ingestion and server-persisted workspace metadata remain separate follow-up work.

QA mode also gates role management, machine management, usage and benchmark pages by administrator identity, with corresponding HTTP/socket route checks. QA administrators can manage all business projects. Project membership is checked before privileged-resource denial so outsiders consistently receive 404.

Personal Skill archives and Skill-only resource plugins can now be imported through the plugin market's Skills tab. Imports are scoped by account and project. Project owners may apply them as supplementary skills to idle project agents; built-in workflow skill names and existing copies cannot be overwritten. Applied copies are fingerprinted so removing a resource cannot silently discard later edits. Shared-project members may keep personal imports but cannot change shared agent capabilities. Modules, installation dependencies/scripts, Hooks and MCP remain administrator operations. Central publication, workflow-skill replacement and per-task immutable capability snapshots are still pending.

The 2026-10-27 engineering checks cover QA permissions (15 cases), upstream authorization compatibility (7), plugin UI regressions (68), protected inputs (8), and child history/evidence compatibility (43). Three real-model tasks against the isolated local login/order service remain in progress; those engineering passes do not establish Web/API execution or final-report acceptance. Short word credentials now preserve unrelated identifiers; archived read-only catalog previews and Node 24 entry-point failures are recognized without accepting archived business-action results as evidence. The isolated model's configured context window was corrected from 1,000,000 to its provider-reported 235,000 tokens; this does not change the installed user's model settings.

The sidebar now follows the supplied v2 prototype's hierarchy: a top project menu (upstream project selection/create/settings dialogs), new-task action, feature navigation and workspace task tree. The separate recent-task section is removed. Historical unbound sessions appear under derived workspace directories without moving files; explicit bindings take precedence. Tasks submitted without a workspace selection acquire a project/account-scoped default workspace binding. These derived groups are presentation associations, not a migration of server project ownership. The menu uses a portal to escape sidebar clipping.

import { AdminLayout, AdminHostGate, AdminLogin, AdminAccountsPage, AdminPermissionsPage, AdminAuditPage } from "./features/admin/admin-layout";
import { AdminSkillsPage } from "./features/admin/admin-skills-page";
import { PublicationsPage } from "./features/admin/publications-page";
import { allowedModule, pageModule } from "./lib/module-permissions";
/**
 * Router: /login is public; all other routes go through the RequireAuth guard (redirects to
 * /login when not authenticated) and are wrapped in ProjectProvider + AppLayout.
 *
 * A data router (`createBrowserRouter` + `RouterProvider`) rather than the declarative
 * `<BrowserRouter>`, for one reason: only a data router can block a navigation, and leaving a
 * form with unsaved edits has to ask first — the browser's back and forward buttons included.
 * The routes are still declared as `<Route>` elements and nothing loads data through the
 * router; the root route only puts the `NavigationGuard` above every page.
 *
 * The app normally routes on the browser's address bar. A host that mounts it inside another
 * document (the component gallery frames it against a mocked API) passes `initialPath`
 * instead: the router then runs in memory from that path, so the app navigates without
 * touching the host document's URL — the only seam the app needs to be mounted elsewhere.
 */
import { useLayoutEffect, useState } from "react";
import {
  Navigate,
  useLocation,
  Outlet,
  Route,
  RouterProvider,
  createBrowserRouter,
  createMemoryRouter,
  createRoutesFromElements,
} from "react-router";
import { releaseBootWallpaper } from "@prismshadow/penguin-ui/boot";
import { NavigationGuard } from "./lib/unsaved/navigation-guard";
import { useAuth } from "./state/auth";
import { useRuntimeLanguages } from "./features/chat/use-runtime-languages";
import { ProjectProvider } from "./state/project";
import { MachinesProvider } from "./state/machines";
import { SessionsProvider } from "./state/sessions";
import { CompanyProvider } from "./state/company";
import { AppLayout } from "./components/layout/app-layout";
import { IntegratedAccountPage } from "./pages/integrated-account";
import { LoginPage } from "./pages/login";
import { ChatPage } from "./features/chat/chat-page";
import { QaSectionPage } from "./features/qa/workspace-ui";
import { QaProjectView } from "./features/qa/project-view";
import { AgentsPage } from "./features/agents/agents-page";
import { AgentSettingsPage } from "./features/agents/agent-settings-page";
import { PluginsPage } from "./features/plugins/plugins-page";
import { ModelsPage } from "./features/models/models-page";
import { UsagePage } from "./features/usage/usage-page";
import { BenchmarkPage } from "./features/benchmark/benchmark-page";
import { BenchmarkDetailPage } from "./features/benchmark/benchmark-detail-page";
import { TerminalPage } from "./features/terminal/terminal-page";
import { OrgIndexRedirect, OrgLayout } from "./features/company/org-layout";
import { OverviewPage } from "./features/company/overview-page";
import { OrgChartPage } from "./features/company/org-chart-page";
import { CalendarPage } from "./features/company/calendar-page";
import { TicketsPage } from "./features/company/tickets-page";
import { FinancePage } from "./features/company/finance-page";
import { ChannelView } from "./features/company/channel-view";
import { HandbookPage } from "./features/company/handbook-page";
import { MachinesPage } from "./features/machines/machines-page";
import { WorkbenchAppPage } from "./features/workbenches/workbench-app-page";
import { PAGES } from "./lib/pages";
import type { PageEntry } from "./lib/pages";

/**
 * The renderers the manifest may name. A page is a module.json entry plus one line here;
 * a server-contributed page renders only when its `builtin` is in this registry.
 */
const BUILTIN_PAGES: Record<string, React.ComponentType> = {
  ChatPage: TestingChatPage,
  AgentsPage,
  AgentSettingsPage,
  PluginsPage,
  ModelsPage,
  MachinesPage,
  UsagePage,
  BenchmarkPage,
  BenchmarkDetailPage,
};

function TestingChatPage() {
  const { search } = useLocation();
  const view = new URLSearchParams(search).get("view");
  return view === "library" || view === "schedules" ? <QaSectionPage view={view} /> : <ChatPage />;
}

function renderPage(page: PageEntry): React.ReactNode {
  return <AuthorizedPage page={page} />;
}
function AuthorizedPage({ page }: { page: PageEntry }) {
  const { user } = useAuth();
  if (page.admin && !(user?.isAdmin || (user?.modulePermissions !== undefined && allowedModule(user,page.key==="agent-settings"?"agents":page.key)))) return <div className="p-8"><h1 className="text-xl font-semibold">仅管理员可访问</h1><p className="mt-3">你可以使用测试任务、资料库、模型库和个人插件能力。</p></div>;
  if ("iframe" in page.renderer) {
    return (
      <iframe title={page.key} src={page.renderer.iframe.src} className="h-full w-full border-0" />
    );
  }
  const Component = BUILTIN_PAGES[page.renderer.builtin];
  return Component === undefined ? <Navigate to="/chat" replace /> : <Component />;
}

/** Route guard: shows blank while initializing, redirects to /login when not authenticated. */
function RequireAuth({ admin = false }: { admin?: boolean }) {
  const { user } = useAuth();
  const location=useLocation();
  const module=pageModule(location.pathname,location.search);
  // Plugin-contributed grammars, adopted once for the signed-in tree (see the hook). Called
  // before the early returns, because a hook cannot be conditional; it fetches only once a user
  // is signed in.
  useRuntimeLanguages(user != null);
  if (user === undefined) return null; // GET /api/me is still initializing
  if (user === null) return <Navigate to="/login" replace />;
  if(module && !allowedModule(user,module)) return <div className="p-8"><h1>没有此模块的访问权限</h1><p>请联系管理员调整授权。</p><a href="/user/accounts">我的账号</a></div>;
  if(admin && !user.isAdmin) return <div className="p-8"><h1>仅管理员可访问管理后台</h1><a href="/user/">返回用户端</a></div>;
  const workspace = (
    <ProjectProvider>
      <MachinesProvider>
        <SessionsProvider>
          <CompanyProvider>
            {admin ? <AdminLayout /> : <AppLayout />}
          </CompanyProvider>
        </SessionsProvider>
      </MachinesProvider>
    </ProjectProvider>
  );
  return admin ? <AdminHostGate>{workspace}</AdminHostGate> : workspace;
}

/**
 * Login guard without the app shell: the terminal page is a standalone full-window surface
 * (no sidebar, no Project context), it only needs the user to be signed in — the terminal
 * WebSocket authenticates with the same session cookie.
 */
function RequireAuthBare({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user === undefined) return null;
  if (user === null) return <Navigate to="/login" replace />;
  if(window.location.pathname.startsWith("/admin") && !user.isAdmin) return <p className="p-8">仅管理员可访问。</p>;
  return <>{children}</>;
}

/** When already logged in, visiting /login redirects straight to the chat page. */
function LoginRoute() {
  const { user } = useAuth();
  if (user) return <Navigate to="/chat" replace />;
  return <IntegratedAccountPage login fallback={<LoginPage />} />;
}

/**
 * The root of every route: the leave guard above the page the route renders. Until the session is
 * known no screen shows, and the pre-paint script's boot layer keeps the stored custom background
 * on the window meanwhile; once it is, the first screen mounts in the same commit — the shell,
 * painting its own wallpaper, or a screen outside it — and the boot layer ends before that frame
 * is painted.
 */
function RootFrame() {
  const { user } = useAuth();
  const settled = user !== undefined;
  useLayoutEffect(() => {
    if (settled) releaseBootWallpaper(document.documentElement);
  }, [settled]);
  return (
    <>
      <NavigationGuard />
      <Outlet />
    </>
  );
}

function appRoutes(admin = false) {
  return createRoutesFromElements(
    <Route element={<RootFrame />}>
      <Route path="/login" element={admin ? <AdminLogin /> : <LoginRoute />} />
      <Route path="/accounts" element={<RequireAuthBare><IntegratedAccountPage /></RequireAuthBare>} />
      <Route
        path="/terminal"
        element={
          <RequireAuthBare>
            <TerminalPage />
          </RequireAuthBare>
        }
      />
      {/* One workbench's page as the whole app: outside the shell, like the terminal; the
          command palette it mounts is the way back. */}
      {[
        "/app/:projectId/:agentId/:workbenchId",
        "/app/:projectId/:agentId/:workbenchId/:tabKey",
      ].map((appPath) => (
        <Route
          key={appPath}
          path={appPath}
          element={
            <RequireAuthBare>
              <WorkbenchAppPage />
            </RequireAuthBare>
          }
        />
      ))}
      <Route element={<RequireAuth admin={admin} />}>
        <Route index element={<Navigate to={admin ? "/agents" : "/chat"} replace />} />
        {admin && <>
          <Route path="/users" element={<AdminAccountsPage />} />
          <Route path="/permissions" element={<AdminPermissionsPage />} />
          <Route path="/audit" element={<AdminAuditPage />} />
          <Route path="/skills" element={<AdminSkillsPage />} />
          <Route path="/publications/:kind" element={<PublicationsPage />} />
        </>}
        <Route path="/resources" element={<Navigate to="/plugins" replace />} />
        {/* Every page is a module.json entry (lib/pages.ts). Admin-only ones are refused
            server-side (403); the sidebar hides their row, so a member only ever reaches
            one by typing the URL. */}
        {PAGES.map((page) => (
          <Route key={page.id} path={page.path} element={renderPage(page)} />
        ))}
        {/* Company mode: /org resolves to an organization (or the empty landing), and an
            organization opens on its overview — the page that says what the whole
            organization is doing; its channels are the sidebar's own list beside it. Both
            fall back to /chat while company mode is unavailable (see OrgLayout). */}
        <Route path="/qa/library" element={<QaSectionPage view="library" />} />
        <Route path="/qa/project" element={<QaProjectView />} />
        <Route path="/org" element={<OrgIndexRedirect />} />
        <Route path="/org/:projectId/:orgId" element={<OrgLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="chart" element={<OrgChartPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="tickets" element={<TicketsPage />} />
          <Route path="finance" element={<FinancePage />} />
          <Route path="handbook" element={<HandbookPage />} />
          <Route path="channels/:channelId" element={<ChannelView />} />
          <Route path="*" element={<Navigate to="overview" replace />} />
        </Route>
        {/* Settings and user management live in the settings dialog now (see
            SettingsDialog); their old routes fall through to the catch-all. */}
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Route>
    </Route>,
  );
}

/**
 * The address-bar router, created once for the page's life: it listens to the window's history,
 * so a second one (a language switch remounts the tree; StrictMode runs initializers twice)
 * would be a second listener acting on every back and forward.
 */
let browserRouter: ReturnType<typeof createBrowserRouter> | null = null;

export function AppRouter({ initialPath }: { initialPath?: string } = {}) {
  const [router] = useState(() =>
    initialPath === undefined
      ? (browserRouter ??= createBrowserRouter(appRoutes(location.pathname.startsWith("/admin")), {basename:location.pathname.startsWith("/admin")?"/admin":location.pathname.startsWith("/user")?"/user":"/"}))
      : createMemoryRouter(appRoutes(), { initialEntries: [initialPath] }),
  );
  return <RouterProvider router={router} />;
}

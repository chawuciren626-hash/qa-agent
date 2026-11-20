"""全站探索合并：pages.json 多页登记 + 失败页如实不冒充。

四个断言各自挡一种静默失败：
  1. 每个 ok 页面的控件都要登记（controls_by_page 不再只有 target 一页）；
  2. 失败页只进 seen_routes，不冒充「已渲染」；
  3. 路由清单 = 菜单兜底 ∪ 实际采过的页——采过的页面不能因为菜单树缺失而丢登记；
  4. 单页口径（不给 --pages）行为不变——兼容是契约的一部分。
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # 仓库根（aitestharness-tools/ 的上一级）
SCRIPT = ROOT / "scripts" / "merge-explore-maps.py"

sys.path.insert(0, str(ROOT / "aitestharness-tools"))

PASS = []
FAIL = []


def check(name, condition, detail=""):
    (PASS if condition else FAIL).append(f"{name}{('：' + detail) if detail and not condition else ''}")


def structure(tag, n=1):
    return {"interactive": [{"tag": tag}] * n, "tables": [], "breadcrumb": ["管理"]}


def run_merge(explore_dir, extra_args):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROOT / "aitestharness-tools") + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONUTF8"] = "1"
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "--project", "demo", "--env", "test",
         "--target-route", "gateway-admin/user/key-card/index",
         "--explore-dir", str(explore_dir), *extra_args],
        capture_output=True, text=True, timeout=120, env=env, cwd=str(ROOT))
    return proc


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        explore_dir = Path(tmp) / "explore"
        explore_dir.mkdir(parents=True)

        pages = [
            {"route": "/gateway-admin/user/key-card/index", "ok": True, "controls": 14, "tables": 1,
             "structure": structure("button", 14)},
            {"route": "/gateway-admin/user/package/index", "ok": True, "controls": 9, "tables": 0,
             "structure": structure("input", 9)},
            {"route": "/gateway-admin/sysSetting/index", "ok": False, "reason": "redirected:/gateway-admin/login"},
        ]
        (explore_dir / "pages.json").write_text(json.dumps(pages), encoding="utf-8")
        (explore_dir / "apis.json").write_text(json.dumps(
            [{"method": "POST", "path": "/gateway-admin/sysMenu/list", "request_fields": ["sort"]}]), encoding="utf-8")

        proc = run_merge(explore_dir, ["--pages", str(explore_dir / "pages.json")])
        check("merge exits 0", proc.returncode == 0, proc.stderr[-300:])
        if proc.returncode != 0:
            report()
            return 1
        maps = json.loads((explore_dir / "maps-test.json").read_text(encoding="utf-8"))
        by_route = {p["route"]: p for p in maps.get("pages", [])}

        got_controls = by_route.get("/gateway-admin/user/key-card/index", {}).get("control_count")
        check("目标页控件已登记", got_controls and got_controls > 0, f"control_count={got_controls}")
        got_package = by_route.get("/gateway-admin/user/package/index", {}).get("control_count")
        check("第二个 ok 页也登记控件", got_package and got_package > 0, f"control_count={got_package}")
        setting = by_route.get("/gateway-admin/sysSetting/index", {})
        check("失败页不冒充已渲染", setting.get("registered") is not True,
              f"registered={setting.get('registered')}")
        meta = maps.get("_build_meta", {}).get("exploration", {})
        check("meta 标注 site 模式", meta.get("mode") == "site", f"mode={meta.get('mode')}")
        check("meta 记录失败页原因", any("redirected" in (r.get("reason") or "") for r in meta.get("pages_failed", [])))
        check("meta 记录 ok 页清单", len(meta.get("pages", [])) == 2, f"pages={len(meta.get('pages', []))}")

        # 单页口径：不给 --pages，行为与旧版一致（只有 target 登记）
        explore_dir2 = Path(tmp) / "explore2"
        explore_dir2.mkdir(parents=True)
        (explore_dir2 / "structure.json").write_text(json.dumps(structure("button", 14)), encoding="utf-8")
        (explore_dir2 / "apis.json").write_text("[]", encoding="utf-8")
        proc2 = run_merge(explore_dir2, [])
        check("单页口径 merge exits 0", proc2.returncode == 0, proc2.stderr[-300:])
        if proc2.returncode == 0:
            maps2 = json.loads((explore_dir2 / "maps-test.json").read_text(encoding="utf-8"))
            registered = [p["route"] for p in maps2.get("pages", []) if p.get("registered")]
            check("单页口径只登记 target", registered == ["/gateway-admin/user/key-card/index"],
                  f"registered={registered}")
            check("单页口径 meta 标注 page", maps2.get("_build_meta", {}).get("exploration", {}).get("mode") == "page")

        # 根前缀应用（如 saucedemo）：prefix='/' 时旧版会把 `/` + '/login' 拼成 '//login'，
        # 并写死注入 '/profile/password'——幽灵路由不能进地图；apis 也不该被 /v2/ 过滤清零。
        explore_dir3 = Path(tmp) / "explore3"
        explore_dir3.mkdir(parents=True)
        login_structure = {"interactive": [
            {"tag": "input", "type": "text", "name": "user-name", "id": "user-name"},
            {"tag": "input", "type": "password", "name": "password", "id": "password"},
            {"tag": "input", "type": "submit", "name": "login-button", "id": "login-button"},
        ], "tables": [], "breadcrumb": []}
        inventory_structure = {"interactive": [{"tag": "div", "name": "item"}] * 6, "tables": [], "breadcrumb": []}
        (explore_dir3 / "pages.json").write_text(json.dumps([
            {"route": "/", "ok": True, "controls": 3, "tables": 0, "structure": login_structure},
            {"route": "/inventory.html", "ok": True, "controls": 6, "tables": 0, "structure": inventory_structure},
        ]), encoding="utf-8")
        (explore_dir3 / "apis.json").write_text(json.dumps([
            {"method": "POST", "path": "/api/unique-events/submit", "request_fields": ["application"]},
        ]), encoding="utf-8")
        report_out = Path(tmp) / "maps-root" / "env-report-root.md"
        proc3 = run_merge(explore_dir3, [
            "--target-route", "", "--pages", str(explore_dir3 / "pages.json"),
            "--report-out", str(report_out), "--round", "1",
        ])
        check("根前缀 merge exits 0", proc3.returncode == 0, proc3.stderr[-300:])
        if proc3.returncode == 0:
            maps3 = json.loads((explore_dir3 / "maps-test.json").read_text(encoding="utf-8"))
            routes3 = {p["route"] for p in maps3.get("pages", [])}
            check("不注入幽灵路由 //login", "//login" not in routes3, f"routes={sorted(routes3)}")
            check("不注入幽灵路由 /profile/password", "/profile/password" not in routes3, f"routes={sorted(routes3)}")
            inv = next((p for p in maps3.get("pages", []) if p["route"] == "/inventory.html"), {})
            check("根前缀业务页登记控件", inv.get("registered") is True and inv.get("control_count") == 6,
                  f"page={inv}")
            paths3 = {a["path"] for a in maps3.get("apis", [])}
            check("根前缀 apis 不被 /v2/ 过滤清零", "/api/unique-events/submit" in paths3,
                  f"apis={sorted(paths3)}")
            check("回写报告已生成", report_out.exists(), f"report={report_out}")
            if report_out.exists():
                text = report_out.read_text(encoding="utf-8")
                check("回写报告标注 round", "round-1" in text)
                check("回写报告列出已建档页", "/inventory.html" in text)

        # 建档基线并集：真实路由并入、静态资源（CSS/favicon/manifest）被页面过滤拦下；
        # 公开页模式登录事实如实记否。
        explore_dir4 = Path(tmp) / "explore4"
        explore_dir4.mkdir(parents=True)
        maps_dir = Path(tmp) / "maps-baseline"
        maps_dir.mkdir(parents=True)
        (maps_dir / "maps-root.yaml").write_text(json.dumps({
            "pages": [
                {"route": "/assets/index-aSZoiKGF.css", "registered": False},
                {"route": "/favicon.ico", "registered": False},
                {"route": "/manifest.json", "registered": False},
                {"route": "/legacy.html", "registered": False},
            ],
            "apis": [{"method": "GET", "path": "/openapi/health", "module": "default", "required": []}],
        }), encoding="utf-8")
        (explore_dir4 / "pages.json").write_text(json.dumps([
            {"route": "/", "ok": True, "controls": 3, "tables": 0, "structure": login_structure},
        ]), encoding="utf-8")
        (explore_dir4 / "apis.json").write_text("[]", encoding="utf-8")
        proc4 = run_merge(explore_dir4, [
            "--target-route", "", "--pages", str(explore_dir4 / "pages.json"),
            "--bootstrap-maps", str(maps_dir / "maps-root.yaml"), "--public-mode",
        ])
        check("基线并集 merge exits 0", proc4.returncode == 0, proc4.stderr[-300:])
        if proc4.returncode == 0:
            maps4 = json.loads((explore_dir4 / "maps-test.json").read_text(encoding="utf-8"))
            routes4 = {p["route"] for p in maps4.get("pages", [])}
            check("基线真实路由并入", "/legacy.html" in routes4, f"routes={sorted(routes4)}")
            check("基线静态资源不并入", not (routes4 & {"/assets/index-aSZoiKGF.css", "/favicon.ico", "/manifest.json"}),
                  f"routes={sorted(routes4)}")
            paths4 = {a["path"] for a in maps4.get("apis", [])}
            check("基线 OpenAPI 接口并入", "/openapi/health" in paths4, f"apis={sorted(paths4)}")
            check("公开模式登录事实记否", maps4.get("login", {}).get("form_detected") is False,
                  f"login={maps4.get('login')}")

    # 路由提取的静态资源过滤：href 会扫到 <link>/<script> 引用，页面与资源必须分开。
    from aitestharness_tools.explore.explorer import extract_routes, is_page_route
    extracted = extract_routes(
        'href="/assets/index-aSZoiKGF.css" href="/favicon.ico" to:"/login" '
        'push("/inventory.html") path:"/cart.html"')
    check("extract_routes 过滤静态资源", extracted["routes"] == ["/cart.html", "/inventory.html", "/login"],
          f"routes={extracted['routes']}")
    check("is_page_route 页面放行资源拦截",
          is_page_route("/inventory.html") and not is_page_route("/manifest.json")
          and not is_page_route("/assets/index-aSZoiKGF.css"))

    report()
    return 0


def report():
    for line in PASS:
        print(f"  PASS  {line}")
    for line in FAIL:
        print(f"  FAIL  {line}")
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        sys.exit(1)


if __name__ == "__main__":
    sys.exit(main())

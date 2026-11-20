"""把真实探索结果合并成 maps IR：用引擎自己的 extract_controls / build_maps，不在这里另立格式。

用法：
  PYTHONPATH=aitestharness-tools python scripts/merge-explore-maps.py \
    --project gateway-admin --env local \
    --target-route /gateway-admin/user/key-card/index

输入（output/ 已 gitignore，均由本机探索产出）：
  <capture>/pages-from-menu.json     sysMenu/list 的菜单树 → 真实 SPA 路由
  <capture>/network-final.json       目标页的接口调用（含入参字段名，不含字段值）
  <capture>/explore-network.json     首次探索的接口调用（补登录后的首页/套餐/渠道等）
  <capture>/harvest-network.json     人工筛选一次的接口调用（可拿 batchId 等可选参数）
  <capture>/structured-dom.json      旧采集件的控件清单（兜底）
  <explore>/structure.json           正式探索器（scripts/explore-authenticated.mjs）产物，优先
  <explore>/apis.json                正式探索器的接口清单

输出：<explore>/maps-<env>.yaml 与 .json

原则：
- 同一接口多次调用带不同入参子集时取并集（翻页 vs 带 batchId 筛选都是事实）；
- 只留字段名，字段值里有运营数据，不进环境地图；
- 登录后真实渲染过的页面才登记控件，其余页面只有路由、控件清单为空（如实标未建档）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]          # 仓库根（scripts/ 的上一级）
sys.path.insert(0, str(ROOT / "aitestharness-tools"))

from aitestharness_tools.explore.explorer import extract_controls   # noqa: E402
from aitestharness_tools.knowledge.maps import build_maps           # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--env", default="local")
    parser.add_argument("--target-route", required=True, help="实际探索过的页面路由（含前缀）")
    parser.add_argument("--route-prefix", default=None, help="路由前缀，默认取 target-route 的前两段")
    parser.add_argument("--extra-route", action="append", default=[],
                        help="登录后真实到过但未采控件的页面路由，可重复")
    parser.add_argument("--pages", default=None,
                        help="全站探索的 pages.json（多页）；不给则退回单页 structure.json 口径")
    # Git Bash 会把以 / 开头的参数当 Windows 路径改写（MSYS 自动转换），
    # 这里统一补前导斜杠，调用方传 gateway-admin/user/key-card/index 也能用。
    parser.add_argument("--explore-dir", default=None, help="默认 output/explore/<project>")
    parser.add_argument("--capture-dir", default=None, help="默认 output/real-acceptance/<project>")
    parser.add_argument("--username-field", default=None)
    parser.add_argument("--password-field", default=None)
    parser.add_argument("--captcha-type", default=None)
    args = parser.parse_args()

    # 前缀取路由第一段（/gateway-admin），不是前两段——第二段是菜单分组，不是前缀。
    target = "/" + args.target_route.strip("/")
    prefix = args.route_prefix or "/" + target.strip("/").split("/")[0]
    explore_dir = Path(args.explore_dir or ROOT / "output" / "explore" / args.project)
    capture_dir = Path(args.capture_dir or ROOT / "output" / "real-acceptance" / args.project)

    def load(base: Path, name: str, default):
        path = base / name
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default

    structured = load(explore_dir, "structure.json", {}) or load(capture_dir, "structured-dom.json", {})

    # 全站模式：pages.json 里每个 ok 页面都登记控件；失败页只记「到过但没采到」，
    # 不冒充成功——这正是 maps 里「仅路由·未采控件」与「采过但失败」的区别。
    pages_rows: list[dict] = []
    pages_failed: list[dict] = []
    if args.pages:
        pages_path = Path(args.pages)
        rows = json.loads(pages_path.read_text(encoding="utf-8")) if pages_path.exists() else []
        if not isinstance(rows, list):
            print(f"--pages 文件格式无效（应为数组）：{pages_path}", file=sys.stderr)
            return 2
        for row in rows:
            route = "/" + str(row.get("route") or "").strip("/")
            if not row.get("ok"):
                pages_failed.append({"route": route, "reason": row.get("reason")})
                continue
            structure = row.get("structure") or {}
            if not structure.get("interactive"):
                pages_failed.append({"route": route, "reason": "structure_empty"})
                continue
            pages_rows.append(row)
        if not pages_rows:
            print("pages.json 里没有任何成功采集的页面", file=sys.stderr)
            return 2
        # 目标页结构优先用 pages.json 里的（同一次采集，天然一致）；单页文件只在缺它时兜底。
        target_row = next((r for r in pages_rows if "/" + str(r.get("route") or "").strip("/") == target), None)
        if target_row and (target_row.get("structure") or {}).get("interactive"):
            structured = target_row["structure"]
        elif not structured:
            print("pages.json 里没有目标页结构，且没有 structure.json 兜底", file=sys.stderr)
            return 2
    if not structured:
        print("没有可用的 structure.json / structured-dom.json", file=sys.stderr)
        return 2
    controls = extract_controls({"interactive": structured.get("interactive") or []})

    def page_routes() -> list[str]:
        rows = load(capture_dir, "pages-from-menu.json", [])
        routes: list[str] = []
        for row in rows:
            route = (row.get("route") or "").strip().strip("/")
            if not route:
                continue
            # 只有 /index 结尾的叶子是页面；user、api、settings 这类是分组节点。
            if not route.endswith("/index") and route != "dashboard/index":
                continue
            routes.append(f"{prefix}/{route}")
        # 兜底：静态建档抓到、但菜单树里没有的路由（如登录页、改密页）
        for extra in (f"{prefix}/login", "/profile/password"):
            if extra not in routes:
                routes.append(extra)
        return sorted(set(routes + [target]))

    def api_module(path: str) -> str:
        parts = [p for p in path.split("/") if p]
        for key in ("apiGateway", "gateway", "sysMenu", "sysUser", "sysRole"):
            if key in parts:
                return key
        return parts[2] if len(parts) > 2 else "default"

    def apis() -> list[dict]:
        rows: dict[tuple[str, str], dict] = {}
        sources = ("apis.json", "network-final.json", "explore-network.json", "harvest-network.json")
        for name in sources:
            for entry in load(explore_dir, name, []) or load(capture_dir, name, []):
                parsed = urlparse(entry.get("path") or entry.get("url") or "")
                path = parsed.path
                if not path.startswith(f"{prefix}/v2/"):
                    continue
                key = ((entry.get("method") or "GET").upper(), path)
                fields: list[str] = list(entry.get("request_fields") or [])
                raw = entry.get("post_data")
                if raw:
                    try:
                        body = json.loads(raw)
                        if isinstance(body, dict):
                            fields = list(body.keys())
                    except ValueError:
                        pass
                if key in rows:
                    # 同一接口多次调用带的是不同子集：取并集，
                    # 否则"支持按批次号筛选"这条事实会在去重时丢掉。
                    rows[key]["required"] = sorted(set(rows[key]["required"]) | set(fields))
                    continue
                rows[key] = {"method": key[0], "path": path,
                             "module": api_module(path), "required": sorted(fields)}
        return sorted(rows.values(), key=lambda item: (item["path"], item["method"]))

    login = {
        "form_detected": True,
        "session_saved": True,
        "session_reused": True,
    }
    for key, value in (("username_field", args.username_field),
                       ("password_field", args.password_field),
                       ("captcha_type", args.captcha_type)):
        if value:
            login[key] = value

    seen_routes = {"/" + r.strip("/") for r in (args.target_route, *args.extra_route)}
    seen_routes |= {str(row.get("route")).strip("/") if str(row.get("route")).startswith("/") else "/" + str(row.get("route")).strip("/") for row in pages_rows}
    seen_routes |= {row["route"] for row in pages_failed}

    # 多页：成功页逐页登记控件；无 --pages 时保持原单页口径。
    controls_by_page: dict[str, dict] = {}
    if pages_rows:
        for row in pages_rows:
            route = "/" + str(row.get("route") or "").strip("/")
            page_controls = extract_controls({"interactive": (row.get("structure") or {}).get("interactive") or []})
            if page_controls.get("controls"):
                controls_by_page[route] = page_controls
    else:
        controls_by_page = {target: controls} if controls["controls"] else {}

    maps = build_maps(
        project=args.project,
        env=args.env,
        routes=sorted(set(page_routes()) | set(controls_by_page)),
        controls_by_page=controls_by_page or None,
        apis=apis(),
        login=login,
        actor="program:explorer+browser",
    )

    # 引擎的标准字段之外，把"探索时看到的事实"另存一份：表格列、菜单树、接口入参。
    # 这些不是 maps 的契约，但少了它们，项目视图就只剩一串 URL。
    if pages_rows:
        maps["_build_meta"]["note"] = (
            f"全站探索：{len(pages_rows)} 页登录后真实渲染并采集控件，"
            f"{len(pages_failed)} 页到过但未采到（如实标记）；其余仅有路由、未建档。"
        )
        maps["_build_meta"]["exploration"] = {
            "explored_at": structured.get("url"),
            "mode": "site",
            "target_route": target,
            "pages": [{"route": "/" + str(r.get("route") or "").strip("/"), "controls": r.get("controls"),
                       "tables": r.get("tables")} for r in pages_rows],
            "pages_failed": pages_failed,
            "tables": structured.get("tables") or [],
            "breadcrumb": structured.get("breadcrumb") or [],
            "seen_routes": sorted(seen_routes),
            "menu_groups": [row.get("menu") for row in load(capture_dir, "pages-from-menu.json", [])
                            if row.get("parent") is None],
        }
    else:
        maps["_build_meta"]["note"] = (
            f"{target} 由真浏览器渲染后采集控件；其余页面仅有路由、控件清单为空（未建档）。"
        )
        maps["_build_meta"]["exploration"] = {
            "explored_at": structured.get("url"),
            "mode": "page",
            "target_route": target,
            "tables": structured.get("tables") or [],
            "breadcrumb": structured.get("breadcrumb") or [],
            "seen_routes": sorted(seen_routes),
            "menu_groups": [row.get("menu") for row in load(capture_dir, "pages-from-menu.json", [])
                            if row.get("parent") is None],
        }

    explore_dir.mkdir(parents=True, exist_ok=True)
    stem = f"maps-{args.env}"
    # PyYAML is not part of the managed Python runtime. JSON is a valid YAML 1.2
    # document, so use it as a dependency-free fallback for the YAML asset while
    # retaining the normal PyYAML output when it is available.
    try:
        import yaml
    except ModuleNotFoundError:
        yaml_text = json.dumps(maps, ensure_ascii=False, indent=2)
    else:
        yaml_text = yaml.safe_dump(maps, allow_unicode=True, sort_keys=False)
    (explore_dir / f"{stem}.yaml").write_text(yaml_text, encoding="utf-8")
    (explore_dir / f"{stem}.json").write_text(
        json.dumps(maps, ensure_ascii=False, indent=2), encoding="utf-8")

    stats = maps["stats"]
    print(json.dumps({
        "maps": str(explore_dir / f"{stem}.yaml"),
        "pages": stats["pages"],
        "pages_registered": stats["pages_registered"],
        "apis": stats["apis"],
        "controls": stats["controls"],
        "content_hash": maps["content_hash"],
    }, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

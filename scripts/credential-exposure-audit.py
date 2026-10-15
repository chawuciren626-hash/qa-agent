"""Read-only exact-value audit. Never print credentials, snippets or key hashes."""

import argparse
import json
import os
import stat
from pathlib import Path
import subprocess
import sys


def credential_values(config):
    values = []

    def visit(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key in ("api_key", "apiKey") and isinstance(value, str) and value:
                    if not value.startswith(("$", "env:", "vault:")):
                        values.append(value)
                else:
                    visit(value)
        elif isinstance(node, list):
            for value in node:
                visit(value)

    visit(config)
    return list(dict.fromkeys(values))


def matches(data, secrets):
    found = []
    for index, secret in enumerate(secrets):
        forms = [secret.encode(), secret.encode("utf-16-le"), secret.encode("utf-16-be"),
                 json.dumps(secret, ensure_ascii=True)[1:-1].encode()]
        if any(value and value in data for value in forms):
            found.append(f"configured-key-{index + 1}")
    return found


def git(root, *args):
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError("git_read_failed")
    return result.stdout


def scan_files(paths, secrets, maximum_file, maximum_total, excluded=()):
    report = {"files_scanned": 0, "bytes_scanned": 0, "skipped": 0, "findings": [], "complete": True}
    excluded = {Path(p).resolve() for p in excluded}
    for path in paths:
        path = Path(path)
        try:
            if path.is_symlink():
                report["skipped"] += 1
                report["complete"] = False
                continue
            if path.resolve() in excluded:
                continue
            size = path.stat().st_size
            if size > maximum_file:
                report["skipped"] += 1
                report["complete"] = False
                continue
            if report["bytes_scanned"] + size > maximum_total:
                report["complete"] = False
                break
            data = path.read_bytes()
            report["files_scanned"] += 1
            report["bytes_scanned"] += len(data)
            found = matches(data, secrets)
            if found:
                report["findings"].append({"path": str(path), "keys": found})
        except OSError:
            report["skipped"] += 1
            report["complete"] = False
    return report


def is_directory_link(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def scoped_files(root, traversal):
    # Do not follow directory links or traverse unrelated dependency/browser caches.
    excluded = {"node_modules", ".git", "__pycache__", "shared_env", "cache", "caches"}
    def unreadable(_error):
        traversal["errors"] += 1

    if is_directory_link(root):
        traversal["links_excluded"] += 1
        return
    for base, directories, files in os.walk(root, followlinks=False, onerror=unreadable):
        retained = []
        for name in sorted(directories):
            if name.lower() in excluded:
                continue
            try:
                if is_directory_link(Path(base, name)):
                    traversal["links_excluded"] += 1
                else:
                    retained.append(name)
            except OSError:
                traversal["errors"] += 1
        directories[:] = retained
        for name in sorted(files):
            yield Path(base, name)


def scan_history(root, secrets, maximum_file, maximum_total):
    # Check every reachable blob, including deleted files; never put secrets in git arguments.
    objects = git(root, "rev-list", "--objects", "--all").splitlines()
    report = {"blobs_scanned": 0, "bytes_scanned": 0, "skipped": 0, "findings": [], "complete": True}
    process = subprocess.Popen(["git", "-C", str(root), "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        for entry in objects:
            oid, _, name = entry.partition(b" ")
            process.stdin.write(oid + b"\n")
            process.stdin.flush()
            header = process.stdout.readline().split()
            if len(header) != 3:
                raise RuntimeError("git_object_unreadable")
            size = int(header[2])
            selected = header[1] == b"blob" and size <= maximum_file
            if report["bytes_scanned"] + size > maximum_total:
                report["complete"] = False
                break
            data = bytearray()
            remaining = size
            while remaining:
                chunk = process.stdout.read(min(remaining, 1024 * 1024))
                if not chunk:
                    raise RuntimeError("git_object_truncated")
                if selected:
                    data.extend(chunk)
                remaining -= len(chunk)
            process.stdout.read(1)
            if header[1] != b"blob":
                continue
            if not selected:
                report["skipped"] += 1
                report["complete"] = False
                continue
            report["blobs_scanned"] += 1
            report["bytes_scanned"] += size
            found = matches(data, secrets)
            if found:
                report["findings"].append({"object": oid.decode("ascii"), "path": name.decode("utf-8", "replace"), "keys": found})
    finally:
        process.stdin.close()
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=10)
        process.stdout.close()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--scan-root", action="append", default=[], type=Path)
    parser.add_argument("--history", action="store_true")
    parser.add_argument("--output", type=Path, help="Optional redacted JSON report, never credential contents")
    parser.add_argument("--max-file-mib", type=int, default=16)
    parser.add_argument("--max-total-mib", type=int, default=512)
    args = parser.parse_args()
    secrets = []
    try:
        import tomllib  # Maintenance audit requires Python 3.11+; no package installation.

        if args.max_file_mib <= 0 or args.max_total_mib <= 0:
            raise ValueError("positive_limits_required")
        with args.config.open("rb") as stream:
            secrets = credential_values(tomllib.load(stream))
        if not secrets:
            raise RuntimeError("no_literal_credentials_to_check")
        file_limit, total_limit = args.max_file_mib * 1024**2, args.max_total_mib * 1024**2
        names = git(args.repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split(b"\0")
        files = [args.repo / os.fsdecode(name) for name in dict.fromkeys(names) if name]
        report = {"mode": "read_only_exact_configured_key_audit", "credential_count": len(secrets),
                  "limits": {"max_file_bytes": file_limit, "max_scope_bytes": total_limit},
                  "working_tree": scan_files(files, secrets, file_limit, total_limit, [args.config]),
                  "local_scopes": [], "limitations": [
                      "Only current configured API key values are checked; older/rotated credentials and transformed encodings may be missed.",
                      "Git history is local reachable refs only; no fetch, reflog, dangling object or remote-provider audit.",
                      "Directory links and dependency/cache directories are excluded; archives are not unpacked.",
                      "File and per-scope byte limits apply; skipped or incomplete scopes do not prove absence of exposure."]}
        if args.history:
            report["history"] = scan_history(args.repo, secrets, file_limit, total_limit)
        for root in args.scan_root:
            if not root.is_dir():
                report["local_scopes"].append({"root": str(root), "complete": False, "error": "scope_unavailable"})
            else:
                traversal = {"errors": 0, "links_excluded": 0}
                result = scan_files(scoped_files(root, traversal), secrets, file_limit, total_limit, [args.config])
                if traversal["errors"] or traversal["links_excluded"]:
                    result["complete"] = False
                report["local_scopes"].append({"root": str(root), **result, "traversal": traversal})
        output = json.dumps(report, ensure_ascii=True, indent=2)
        for secret in secrets:
            output = output.replace(secret, "[REDACTED]").replace(json.dumps(secret, ensure_ascii=True)[1:-1], "[REDACTED]")
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            # Do not overwrite an earlier audit or any live configuration.
            with args.output.open("x", encoding="utf-8") as stream:
                stream.write(output + "\n")
            print(json.dumps({"status": "redacted_report_written", "credential_count": len(secrets)}))
        else:
            print(output)
    except Exception as error:
        # Parser, subprocess and filesystem diagnostics must never echo a secret-bearing line.
        print(json.dumps({"status": "audit_failed", "error_type": type(error).__name__}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

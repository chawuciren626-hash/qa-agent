"""环境基线（G1a）冒烟测试：只测判定，不连被测环境。

重点覆盖三类容易写错的地方：
    · 指纹稳定性——同一环境重复采集必须同哈希，否则基线一次也用不上；
    · 缺版本的降级——G3 要求缺 sut_version 标 inconclusive，而不是"默认可比"；
    · 写入的不可回改——run 目录里的基线一旦写下，就不许被后来者悄悄覆盖。
"""
import json
import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from aitestharness_tools.exec.baseline import (BASELINE_FILE, build_baseline,
                                               collect_baseline, compare_baseline,
                                               content_hash, credential_fingerprint,
                                               digest_rows, fingerprint_db,
                                               fingerprint_files, read_baseline,
                                               verdict, write_baseline)


def _baseline(**overrides):
    args = dict(
        sut_version="2026.11.19-1",
        db={"orders": {"rows": 3, "digest": "d1", "critical": False}},
        files={"fixtures/seed.json": {"sha256": "f1", "size": 10}},
        mock={"user-service": "m1"},
        credential_refs=["qa-secret://orders-admin@v3"],
    )
    args.update(overrides)
    return build_baseline("test", **args)


def test_same_environment_same_hash():
    now = _baseline()
    later = _baseline()
    assert now["content_hash"] == later["content_hash"], "同环境重复采集必须同哈希"


def test_collected_at_does_not_change_hash():
    first = _baseline(collected_at="2026-11-19T10:00:00Z")
    second = _baseline(collected_at="2026-11-19T18:00:00Z")
    assert first["content_hash"] == second["content_hash"], "采集时间不能进指纹，否则基线永远不一致"


def test_note_does_not_change_hash():
    # note 是人事后写的说明，不是环境事实
    assert _baseline(note="a")["content_hash"] == _baseline(note="b")["content_hash"]


def test_digest_ignores_row_order():
    a = digest_rows([(1, "x"), (2, "y")])
    b = digest_rows([(2, "y"), (1, "x")])
    assert a == b, "行序无语义，物理顺序不同不能算漂移"
    assert a["rows"] == 2


def test_digest_detects_value_change():
    assert digest_rows([(1, "x")])["digest"] != digest_rows([(1, "y")])["digest"]
    # 重复行不能被集合去重掉
    assert digest_rows([(1, "x")])["digest"] != digest_rows([(1, "x"), (1, "x")])["digest"]
    assert digest_rows([(1, "x"), (1, "x")])["rows"] == 2


def test_null_and_empty_string_differ():
    # NULL 与 '' 在数据语义上不同，摘要不能把它们压成同一个
    assert digest_rows([(None,)])["digest"] != digest_rows([("",)])["digest"]


def test_identical_baseline_is_comparable():
    result = verdict(_baseline(), _baseline())
    assert result["status"] == "comparable", result
    assert result["comparison"]["same"] is True


def test_version_change_is_blocking():
    result = verdict(_baseline(), _baseline(sut_version="2026.11.20-1"))
    assert result["status"] == "not_comparable", result
    assert any(item["section"] == "sut_version" for item in result["comparison"]["drift"])


def test_missing_version_is_inconclusive_not_comparable():
    reference = _baseline(sut_version=None)
    result = verdict(reference, _baseline(sut_version=None))
    # 没漂移，但版本未知 —— G3 要求标 inconclusive，不能因为"看起来一样"就放行
    assert result["status"] == "inconclusive", result
    assert result["comparable"] is False


def test_critical_table_drift_blocks_non_critical_warns():
    critical = verdict(
        _baseline(db={"orders": {"rows": 3, "digest": "d1", "critical": True}}),
        _baseline(db={"orders": {"rows": 4, "digest": "d2", "critical": True}}))
    assert critical["status"] == "not_comparable", critical

    soft = verdict(_baseline(), _baseline(db={"orders": {"rows": 4, "digest": "d2", "critical": False}}))
    assert soft["status"] == "comparable_with_warnings", soft
    assert soft["comparable"] is True


def test_critical_flag_cannot_be_downgraded_by_later_run():
    # 后一次采集把 critical 改成 false，不能因此把 blocking 抹成 warning
    result = verdict(_baseline(db={"orders": {"rows": 3, "digest": "d1", "critical": True}}),
                     _baseline(db={"orders": {"rows": 4, "digest": "d2", "critical": False}}))
    assert result["status"] == "not_comparable", result


def test_same_rows_different_content_is_drift():
    # 行数相同但内容变了：只看 count 的基线会漏掉这一类
    result = compare_baseline(_baseline(),
                              _baseline(db={"orders": {"rows": 3, "digest": "zzz", "critical": True}}))
    assert result["comparable"] is False
    assert result["drift"][0]["detail"] == "行数相同但内容不同"


def test_mock_change_is_blocking():
    result = verdict(_baseline(), _baseline(mock={"user-service": "m2"}))
    assert result["status"] == "not_comparable"
    assert any(item["section"] == "mock" and item["severity"] == "blocking"
               for item in result["comparison"]["drift"])


def test_file_drift_severity_follows_critical_flag():
    soft = verdict(_baseline(), _baseline(files={"fixtures/seed.json": {"sha256": "f2", "size": 10}}))
    assert soft["status"] == "comparable_with_warnings", soft
    hard = verdict(_baseline(), _baseline(
        files={"fixtures/seed.json": {"sha256": "f2", "size": 10, "critical": True}}))
    assert hard["status"] == "not_comparable", hard


def test_credential_rotation_is_warning_not_blocking():
    result = verdict(_baseline(), _baseline(credential_refs=["qa-secret://orders-admin@v4"]))
    assert result["status"] == "comparable_with_warnings", result


def test_credential_refs_reject_raw_secret():
    for bad in ("P@ssw0rd!", "hunter2 with space", "abcdefghijklmnop"):
        try:
            credential_fingerprint([bad])
        except ValueError:
            continue
        raise AssertionError(f"raw secret accepted: {bad!r}")


def test_missing_section_is_unknown_not_equal():
    # 一侧没有 files 段 → 该段记 unknown，不能当作"一致"
    reference = build_baseline("test", sut_version="2026.11.19-1")
    current = _baseline()
    result = compare_baseline(reference, current)
    assert any(item["section"] == "files" and item["kind"] == "unknown" for item in result["drift"]), result["drift"]
    assert result["comparable"] is True, "unknown 不该被当成 blocking"


def test_missing_reference_is_baseline_missing():
    assert verdict(None, _baseline())["status"] == "baseline_missing"
    assert verdict(_baseline(), None)["status"] == "baseline_missing"


def test_write_read_roundtrip_and_immutability():
    with tempfile.TemporaryDirectory() as run_dir:
        path = write_baseline(run_dir, _baseline())
        assert os.path.basename(path) == BASELINE_FILE
        loaded = read_baseline(run_dir)
        assert loaded["content_hash"] == _baseline()["content_hash"]

        # 同内容再写一次是幂等的
        write_baseline(run_dir, _baseline())

        try:
            write_baseline(run_dir, _baseline(sut_version="2026.11.20-1"))
        except ValueError:
            pass
        else:
            raise AssertionError("changed baseline must not overwrite silently")

        write_baseline(run_dir, _baseline(sut_version="2026.11.20-1"), overwrite=True)
        assert read_baseline(run_dir)["sut_version"] == "2026.11.20-1"


def test_read_detects_tampering():
    with tempfile.TemporaryDirectory() as run_dir:
        write_baseline(run_dir, _baseline())
        target = os.path.join(run_dir, BASELINE_FILE)
        payload = json.load(open(target, encoding="utf-8"))
        payload["sut_version"] = "forged"
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        try:
            read_baseline(run_dir)
        except ValueError:
            return
        raise AssertionError("tampered baseline must not be trusted")


def test_read_missing_returns_none():
    with tempfile.TemporaryDirectory() as run_dir:
        assert read_baseline(run_dir) is None


def test_fingerprint_files_marks_missing():
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, "fixtures"))
        with open(os.path.join(root, "fixtures", "seed.json"), "w", encoding="utf-8") as handle:
            handle.write('{"a":1}')
        result = fingerprint_files(["fixtures/seed.json", "fixtures/gone.json"], root,
                                   critical=["fixtures/gone.json"])
        assert result["fixtures/seed.json"]["size"] == 7
        assert result["fixtures/gone.json"]["missing"] is True
        assert result["fixtures/gone.json"]["critical"] is True


def test_fingerprint_db_sqlite():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "sut.db")
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE orders(id INTEGER, state TEXT)")
        conn.executemany("INSERT INTO orders VALUES (?,?)", [(1, "new"), (2, "paid")])
        conn.execute("CREATE TABLE logs(msg TEXT)")
        conn.execute("INSERT INTO logs VALUES ('x')")
        conn.commit()
        conn.close()

        facts = fingerprint_db(path, ["orders"], critical=["orders"])
        assert facts["orders"]["rows"] == 2
        assert facts["orders"]["critical"] is True

        # 数据变了，摘要要跟着变
        conn = sqlite3.connect(path)
        conn.execute("UPDATE orders SET state='done' WHERE id=1")
        conn.commit()
        conn.close()
        assert fingerprint_db(path, ["orders"])["orders"]["digest"] != facts["orders"]["digest"]


def test_fingerprint_db_rejects_unknown_format():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "dump.sql")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("INSERT INTO orders VALUES (1);")
        try:
            fingerprint_db(path)
        except ValueError:
            return
        raise AssertionError("unsupported dump format must be rejected, not hashed blindly")


def test_collect_baseline_from_config():
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "sut.db")
        conn = sqlite3.connect(db_path)
        conn.execute("CREATE TABLE orders(id INTEGER)")
        conn.executemany("INSERT INTO orders VALUES (?)", [(1,), (2,)])
        conn.commit()
        conn.close()
        os.makedirs(os.path.join(tmp, "fixtures"))
        with open(os.path.join(tmp, "fixtures", "seed.json"), "w", encoding="utf-8") as handle:
            handle.write("{}")

        baseline = collect_baseline({
            "env": "staging",
            "sut_version": "v1",
            "db": {"path": db_path, "tables": ["orders"], "critical": ["orders"]},
            "files": {"root": tmp, "paths": ["fixtures/seed.json"]},
            "mock": {"user-service": "m1"},
            "credential_refs": ["qa-secret://orders-admin@v3"],
        })
        assert baseline["env"] == "staging"
        assert baseline["db"]["orders"] == {"rows": 2, "digest": baseline["db"]["orders"]["digest"], "critical": True}
        assert baseline["files"]["fixtures/seed.json"]["size"] == 2
        assert baseline["credentials"]["ref_count"] == 1
        assert len(baseline["content_hash"]) == 64

        # 配置段存在但采集失败 → 抛错，不允许静默产出空段
        try:
            collect_baseline({"env": "staging", "db": {"path": os.path.join(tmp, "nope.db")}})
        except FileNotFoundError:
            pass
        else:
            raise AssertionError("missing db snapshot must fail loudly")


def test_content_hash_matches_recomputation():
    baseline = _baseline()
    assert content_hash(baseline) == baseline["content_hash"]


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as error:
                fails += 1
                import traceback
                print(f"FAIL {name}: {error}")
                traceback.print_exc()
    print("ALL PASS" if fails == 0 else f"{fails} FAILED")
    sys.exit(1 if fails else 0)

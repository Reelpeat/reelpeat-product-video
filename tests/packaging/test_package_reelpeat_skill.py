"""离线检查宿主可解析包、资源完整性及公开包边界，不访问生成服务。"""

import importlib.util
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

import yaml

ROOT = Path(__file__).resolve().parents[2]
# 中文注释：同一套测试分别覆盖主项目脚本位置与公开仓库tools位置。
PACKAGER = ROOT / ("tools/package_reelpeat_skill.py" if (ROOT / "SKILL.md").is_file()
                   else "scripts/package_reelpeat_skill.py")
SPEC = importlib.util.spec_from_file_location("package_skill", PACKAGER)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SkillPackageTest(unittest.TestCase):
    """直接读取产物，避免把源文本存在误判为可以安装。"""

    def test_both_hosts_have_resolvable_resources_and_metadata(self):
        """宿主需要的元信息、入口和所有引用必须能从单层 ZIP 找到。"""
        source_text = (MODULE.SOURCE / "SKILL.md").read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as directory:
            for host in ("codex", "workbuddy"):
                output = MODULE.package_skill(MODULE.SOURCE, Path(directory) / f"{host}.zip", host)
                with ZipFile(output) as archive:
                    self.assertIsNone(archive.testzip())
                    names = archive.namelist()
                    root = "reelpeat-product-video/"
                    self.assertTrue(all(name.startswith(root) and ".." not in name.split("/") for name in names))
                    text = archive.read(root + "SKILL.md").decode()
                    front = yaml.safe_load(text.split("---", 2)[1])
                    self.assertEqual(front["name"], "reelpeat-product-video")
                    for ref in re.findall(r"\]\((references/[^)]+)\)", text):
                        self.assertIn(root + ref, names)
                    if host == "workbuddy":
                        self.assertTrue(all(front.get(key) for key in ("description_zh", "description_en", "version", "author")))
                        self.assertFalse(any("/agents/" in name for name in names))
                    else:
                        self.assertEqual(text, source_text)
                        interface = yaml.safe_load(archive.read(root + "agents/openai.yaml"))["interface"]
                        self.assertIn("$reelpeat-product-video", interface["default_prompt"])
                    self.assertFalse(any(name.endswith((".py", ".js", ".env")) or "mcp.json" in name for name in names))
                    # 中文注释：仅发布明确客户端模块，不把配置和任务数据打进公开包。
                    self.assertEqual(
                        sorted(name.removeprefix(root + "scripts/") for name in names if name.startswith(root + "scripts/")),
                        sorted(MODULE.CLIENT_SCRIPTS),
                    )

    def test_zip_bytes_do_not_depend_on_source_mtime(self):
        """中文注释：改变资源时间后包字节仍一致，且每项时间与权限均为固定值。"""
        import os
        import shutil
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            shutil.copytree(MODULE.SOURCE, source)
            for host in ("codex", "workbuddy"):
                first = MODULE.package_skill(source, root / f"{host}-one.zip", host)
                for path in source.rglob("*"):
                    if path.is_file():
                        os.utime(path, (1700000000, 1700000000))
                second = MODULE.package_skill(source, root / f"{host}-two.zip", host)
                self.assertEqual(first.read_bytes(), second.read_bytes())
                with ZipFile(second) as archive:
                    for entry in archive.infolist():
                        self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
                        self.assertEqual(entry.external_attr >> 16, 0o100644)
                        self.assertEqual(entry.create_system, 3)

    def test_output_cannot_modify_source(self):
        """打包命令不得把 ZIP 写进唯一维护源。"""
        with self.assertRaises(ValueError):
            MODULE.package_skill(MODULE.SOURCE, MODULE.SOURCE / "bad.zip", "codex")

    def test_external_resource_symlink_is_rejected(self):
        """夹带到资料目录的外部文件软链接不能进入公开包。"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            (source / "references").mkdir(parents=True)
            # 中文注释：中文Skill夹具固定UTF-8，不依赖Windows默认GBK编码。
            (source / "SKILL.md").write_text((MODULE.SOURCE / "SKILL.md").read_text(encoding="utf-8"), encoding="utf-8")
            outside = root / "private.md"
            outside.write_text("synthetic private fixture")
            (source / "references/private.md").symlink_to(outside)
            with self.assertRaises(ValueError):
                MODULE.package_skill(source, root / "bad.zip", "workbuddy")

    def test_external_skill_entry_is_rejected_before_reading(self):
        """中文注释：主入口外链即使内容不可解析，也先按资源边界拒绝且不生成ZIP。"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            outside = root / "private.md"
            outside.write_text("synthetic private fixture", encoding="utf-8")
            (source / "SKILL.md").symlink_to(outside)
            output = root / "bad.zip"
            with self.assertRaisesRegex(ValueError, "普通文件"):
                MODULE.package_skill(source, output, "workbuddy")
            self.assertFalse(output.exists())

    def test_internal_directory_symlink_is_rejected(self):
        """中文注释：即使目标仍在源目录内，资源目录别名也不能绕过无软链接规则。"""
        import shutil
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            shutil.copytree(MODULE.SOURCE, source)
            # 中文注释：只移动本测试创建的临时引用目录，不触碰真实Skill源。
            refs = source / "references"
            refs.rename(source / "actual-references")
            refs.symlink_to(source / "actual-references", target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "软链接"):
                MODULE.package_skill(source, root / "bad.zip", "workbuddy")

    def test_extracted_client_runs_without_repository_or_private_files(self):
        """中文注释：实际运行独立解压包，且混入源目录的凭据/状态不能被白名单发布。"""
        with tempfile.TemporaryDirectory(prefix="reelpeat 独立包 ") as directory:
            root = Path(directory)
            source = root / "source"
            shutil.copytree(MODULE.SOURCE, source)
            for name in ("credentials.json", "state.json", ".env", "unapproved.mjs"):
                (source / "scripts" / name).write_text("synthetic-private-fixture", encoding="utf-8")
            node = os.environ.get("REELPEAT_TEST_NODE", "node")
            for host in ("codex", "workbuddy"):
                output = MODULE.package_skill(source, root / f"{host}.zip", host)
                extracted = root / host
                with ZipFile(output) as archive:
                    archive.extractall(extracted)
                entry = extracted / "reelpeat-product-video/scripts/reelpeat.mjs"
                result = subprocess.run([node, str(entry), "--help"], cwd=extracted,
                                        capture_output=True, text=True, encoding="utf-8", check=True)
                self.assertEqual(json.loads(result.stdout)["operation"], "help")
                self.assertEqual(result.stderr, "")
                missing = extracted / "unconfigured/credentials.json"
                result = subprocess.run([node, str(entry), "doctor", "--config", str(missing)],
                                        cwd=extracted, capture_output=True, text=True, encoding="utf-8")
                self.assertEqual(result.returncode, 1)
                self.assertEqual(json.loads(result.stdout)["result_type"], "setup_required")
                self.assertFalse(any((entry.parent / name).exists() for name in
                                     ("credentials.json", "state.json", ".env", "unapproved.mjs")))


if __name__ == "__main__":
    unittest.main()

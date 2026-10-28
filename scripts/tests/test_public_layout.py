"""隔离验证公开仓库的文档、忽略规则与CI权限，不连接业务服务。"""

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


class PublicLayoutTest(unittest.TestCase):
    """中文注释：准备目录与GitHub中运行同一套断言，不依赖原业务仓库。"""

    def test_readme_links_and_release_boundaries(self):
        text = (ROOT / "README.md").read_text(encoding="utf-8")
        # 中文注释：导出后的安装说明应指向新仓库，避免后续发布恢复旧地址。
        self.assertIn("https://github.com/Reelpeat/reelpeat-product-video", text)
        for reference in re.findall(r"\]\(([^)]+)\)", text):
            # 中文注释：仓库外部链接不当成本地文件；随包资源链接仍必须可解析。
            if reference.startswith(("https://", "http://", "#")):
                continue
            self.assertTrue((ROOT / reference).is_file(), reference)
        self.assertIn("https://www.reelpeat.com/", text)
        self.assertIn("不包含LICENSE", text)
        skill = ROOT / ".codex/skills/reelpeat-product-video"
        for file in skill.rglob("*"):
            self.assertFalse(file.is_symlink())
            self.assertNotIn(file.name, {"credentials.json", "state.json", ".env", "mcp.json"})

    def test_shared_ignore_protects_private_files(self):
        # 中文注释：只初始化自己的临时Git仓库，避免把主项目或用户文件加入版本控制。
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copyfile(ROOT / ".gitignore", root / ".gitignore")
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            for name in (".reelpeat/credentials.json", ".reelpeat-local/runs/a/state.json",
                         "credentials.json", ".env", "nested/private.key", "output/a.zip"):
                result = subprocess.run(["git", "check-ignore", "--", name], cwd=root, capture_output=True)
                self.assertEqual(result.returncode, 0, name)
            result = subprocess.run(["git", "check-ignore", "--", "README.md"], cwd=root, capture_output=True)
            self.assertEqual(result.returncode, 1)

    def test_ci_has_lts_matrix_and_no_publish_or_secrets(self):
        text = (ROOT / ".github/workflows/check.yml").read_text(encoding="utf-8")
        config = yaml.load(text, Loader=yaml.BaseLoader)
        self.assertEqual(config["permissions"], {"contents": "read"})
        self.assertEqual(config["on"], ["push", "pull_request", "workflow_dispatch"])
        self.assertEqual(config["jobs"]["check"]["strategy"]["matrix"]["node"], ["22", "24"])
        self.assertNotIn("secrets.", text)
        self.assertNotIn("pull_request_target", text)
        for step in config["jobs"]["check"]["steps"]:
            if "uses" in step:
                self.assertRegex(step["uses"], r"^actions/[a-z-]+@[a-f0-9]{40}$")
            self.assertNotRegex(step.get("run", ""), r"git push|gh release|generate-video|auth setup")


if __name__ == "__main__":
    unittest.main()

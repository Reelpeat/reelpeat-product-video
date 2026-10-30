"""隔离验证公开仓库的文档、忽略规则与CI权限，不连接业务服务。"""

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]


class PublicLayoutTest(unittest.TestCase):
    """中文注释：准备目录与GitHub中运行同一套断言，不依赖原业务仓库。"""

    def test_readme_registration_uses_the_packaged_account_entry(self):
        """中文注释：README直接注册与Agent引导必须是同版入口，不能回退到无来源官网。"""
        text = (ROOT / "README.md").read_text(encoding="utf-8")
        entry = (ROOT / "scripts/setup.mjs").read_text(encoding="utf-8")
        account = re.search(r"const ACCOUNT_URL = DEFAULT_API_BASE \+ '([^']+)'", entry)[1]
        link = re.search(r"\[注册／登录 Reelpeat\]\(([^)]+)\)", text)
        self.assertIsNotNone(link)
        self.assertEqual(link[1], "https://www.reelpeat.com/" + account)
        params = parse_qs(urlsplit(link[1]).query)
        self.assertEqual(params["skill_id"], ["reelpeat-product-video"])
        self.assertEqual(params["redirect"], ["/vorder/app?account_action=api-keys"])

    def test_readme_links_and_release_boundaries(self):
        text = (ROOT / "README.md").read_text(encoding="utf-8")
        # 中文注释：导出后的安装说明应指向新仓库，避免后续发布恢复旧地址。
        self.assertIn("https://github.com/Reelpeat/reelpeat-product-video", text)
        # 中文注释：首页图片和拆出的维护文档都按各自目录核验链接，防止发布后断图或断链。
        for document in (ROOT / "README.md", ROOT / "docs/maintaining.md"):
            for reference in re.findall(r"\]\(([^)]+)\)", document.read_text(encoding="utf-8")):
                if reference.startswith(("https://", "http://", "#")):
                    continue
                self.assertTrue((document.parent / reference).is_file(), reference)
        self.assertIn("https://www.reelpeat.com/", text)
        self.assertIn("不包含LICENSE", (ROOT / "docs/maintaining.md").read_text(encoding="utf-8"))
        # 中文注释：通用入口必须可直接发现，不依赖任何Agent隐藏目录。
        self.assertTrue((ROOT / "SKILL.md").is_file())
        self.assertFalse((ROOT / ".codex").exists())
        skill = ROOT
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

#!/usr/bin/env python3
"""从唯一 Skill 源生成 Codex 或 WorkBuddy ZIP，不包含连接器凭据和后端代码。"""

import argparse
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

import yaml

SOURCE = Path(__file__).resolve().parents[1] / ".codex/skills/reelpeat-product-video"
# 中文注释：仅收录官方客户端模块，凭据、状态和临时文件即使混入scripts也不能发布。
CLIENT_SCRIPTS = (
    "api-client.mjs", "local-files.mjs", "credentials.mjs", "contracts.mjs",
    "workflow.mjs", "media.mjs", "setup.mjs", "reelpeat.mjs", "batch.mjs",
)


def package_skill(source: Path, output: Path, target: str) -> Path:
    """保留单层技能根目录；WorkBuddy 元信息从同一份 metadata 生成。"""
    if target not in {"codex", "workbuddy"}:
        raise ValueError("不支持的宿主")
    source = source.resolve()
    output = output.resolve()
    if output.is_relative_to(source):
        raise ValueError("发布产物不能覆盖技能源目录")
    # 中文注释：主入口同样执行资源边界检查，必须在读取正文之前拒绝外链。
    _validate_resource(source / "SKILL.md", source)
    text = (source / "SKILL.md").read_text(encoding="utf-8")
    match = re.match(r"\A---\n(.*?)\n---\n(.*)\Z", text, re.S)
    if not match:
        raise ValueError("Skill YAML 结构无效")
    front = yaml.safe_load(match[1])
    name = front["name"]
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        raise ValueError("技能名称不能作为安全包路径")
    if target == "workbuddy":
        # 中文注释：平台要求顶层多语言字段，Codex 则将扩展信息保留在 metadata 中。
        metadata = front["metadata"]
        front = {"name": name, "description": front["description"], **{
            key: metadata[key] for key in (
                "display_name", "display_name_en", "description_zh", "description_en", "version", "author"
            )
        }}
        text = "---\n" + yaml.safe_dump(front, allow_unicode=True, sort_keys=False) + "---\n" + match[2]
    resources = sorted((source / "references").glob("*.md"))
    resources += [source / "scripts" / name for name in CLIENT_SCRIPTS]
    if target == "codex":
        resources += [source / "agents/openai.yaml"]
    # 中文注释：拒绝资源软链接，避免将包外文件或本地凭据带入公开 ZIP。
    for path in resources:
        _validate_resource(path, source)
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        _write_stable_entry(archive, f"{name}/SKILL.md", text.encode("utf-8"))
        for path in resources:
            _write_stable_entry(archive, f"{name}/{path.relative_to(source).as_posix()}", path.read_bytes())
    return output


def _validate_resource(path: Path, source: Path) -> None:
    """中文注释：同时检查文件与中间目录软链接，禁止外链和目录别名绕过资源边界。"""
    if not path.resolve().is_relative_to(source) or not path.is_file():
        raise ValueError("发布资源必须是源目录内的普通文件")
    current = path
    while current != source:
        if current.is_symlink():
            raise ValueError("发布资源不得包含软链接")
        current = current.parent


def _write_stable_entry(archive: ZipFile, name: str, content: bytes) -> None:
    """中文注释：固定时间、权限与压缩参数，避免宿主文件时间及操作系统影响包哈希。"""
    entry = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    entry.create_system = 3
    entry.external_attr = 0o100644 << 16
    entry.compress_type = ZIP_DEFLATED
    archive.writestr(entry, content, compress_type=ZIP_DEFLATED, compresslevel=9)


def main() -> None:
    """只生成本地文件，不安装、发布或连接任何外部账户。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=("codex", "workbuddy"))
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(package_skill(SOURCE, args.output, args.target))


if __name__ == "__main__":
    main()

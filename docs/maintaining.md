# 维护、测试与打包

以下命令在仓库根目录执行。用户运行 Skill 只需要 Node.js；Python 仅用于维护者测试和打包。

## 本地自动测试

仅维护者运行打包和测试时需要Python 3.11+、Git及PyYAML；终端中的node应为拟验证版本。全部测试使用临时目录和合成回环HTTP服务，不需要个人Key，不调用真实网关或供应商，不产生真实费用。

```bash
python3 -m pip install -r requirements-dev.txt
node --test tests/client/*.test.js
python3 -m unittest discover -s tests/packaging -p 'test_*.py' -v
```

GitHub工作流：[check.yml](../.github/workflows/check.yml)。push、pull_request和手动触发时，Ubuntu在选取的Node测试样本上运行同一测试和打包命令，测试样本不构成用户安装版本白名单；Actions固定提交SHA、只读仓库权限，不注入真实Key，也不自动创建Release或推送代码。托管执行结果以仓库Actions页面为准，本地测试通过不能代替托管执行状态。

## 本地打包

```bash
python3 tools/package_reelpeat_skill.py --target codex --output output/reelpeat-product-video-codex.zip
python3 tools/package_reelpeat_skill.py --target workbuddy --output output/reelpeat-product-video-workbuddy.zip
```

两个ZIP均只有一层reelpeat-product-video根目录，包含随包.mjs模块及引用文档，不含测试、凭据或运行数据。Codex包含agents/openai.yaml；WorkBuddy包转换顶层元信息。不修改源目录，也不读取或打包用户目录。

## 已知边界及发布前检查

- 当前公开图片目录合同未就绪时，不发起新生图；可使用已开放的原图视频路径或查询本人历史图片，实际能力仍以context为准。
- Codex当前项目路径已有测试依据；WorkBuddy包结构验证不能替代WorkBuddy实机安装。Windows ACL和其他Agent/云端的权限、配置页及媒体验收不能宣称已通过。
- 当前未选定开源许可证，不包含LICENSE；代码公开不代表已授予开源使用许可，后续由版权方决定。
- 本仓库只发布Skill源码及必要配套文件，不包含真实商品下载、生成结果、用户任务记录或有效API Key。
- 分享截图、日志和Issue时删除Key、鉴权头、临时签名URL、个人账号资料及完整恢复文件。

## 维护与同步

唯一维护源仍为主项目 `.codex/skills/reelpeat-product-video/`，不改变主项目安装位置。本目录由主项目 `scripts/prepare_reelpeat_github.py` 显式白名单导出；不要同时手工维护两份Skill。后续GitHub修改应回流唯一维护源，再重新导出到新的空目录。导出不携带Git历史，也不覆盖已有目录中的许可证、提交或用户文件。

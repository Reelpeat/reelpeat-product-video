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

## 每次发布更新注册推广链接

1. 确定本次 `SKILL.md` 的 `metadata.version`，同步同包版本说明；两个宿主包使用同一版本。
2. 在 Reelpeat 后台“用户管理 → 推广链接”生成该版本的包内入口：来源平台 `skill`、获客方式 `skill`、素材位置 `first_setup`、Skill 标识 `reelpeat-product-video`、Skill 版本填写本次版本，落地页选“注册／登录页”；活动使用已确定的活动编码。操作必须有该次授权。每个版本新建独立记录；重试先核对同版本记录，避免重复创建。保留旧记录，不改写其版本或 ID。
3. 将后台返回的地址同步到唯一维护源 `scripts/setup.mjs` 的 `ACCOUNT_URL` 和 README 的注册／登录入口，保留来源参数和原有个人 Key 管理回跳；不要自行编造 `acq_id`，也不要只改 URL 中的版本号。已保存记录会覆盖传入的来源和版本参数；旧记录搭配新版本会使统计失真。公开目录测试会核对 README 与客户端链接完全一致。
4. 运行本地测试及两个宿主打包，再从唯一维护源导出公开仓库。打包器会阻断 Skill 标识／版本不一致或缺少合法 `acq_id`；该检查离线执行，不能证明后台记录实际存在。发布前还须查回记录，核对启用状态、落地页、Skill 标识、版本及活动。
5. 用客户端 `--help`、未配置的 `doctor` 和临时配置页核对同一入口。匿名来源采集只验证记录解析及版本，不发送短信、不代表新增注册；来源票据不得进入日志或报告。真实注册验收仅在另有账号、短信和发奖授权时执行。
6. 注册验收应核对后台用户详情的“注册获客来源”和对应链接的注册人数。隔离回归需覆盖：新用户注册写入来源及版本、URL 篡改以保存记录为准、不同版本人数互不混计、老用户从新版登录不改写原注册版本、失败注册回滚。没有有效记录、版本不匹配或验收失败时暂停发布。

统计口径为 30 天内最后一次有效非直接来源带来的新账号注册。用户详情可查看首次触达和注册归因；链接列表按各版本独立链接统计注册人数，不统计下载量、安装量、升级量、访问量或付费转化。包内统一 `source=skill` 不能自动识别 Agent 或安装市场。

门户的登录、Key 管理及充值入口使用独立的 `source=reelpeat_agents` 推广记录，不填写 `skill_id` 或 `skill_version`；保留各自的账户动作。网站指南访问不证明用户安装了某版 Skill，不能套用包内版本。更新时同时核对公开仓库已经推送且 CI 通过；本地目录修改不代表用户已能下载。

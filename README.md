# Reelpeat 商品链接带货视频 Skill

给出商品链接和目标市场，由宿主 Agent 读取商品事实、实际看图、设计脚本，再通过随包 Node.js 客户端取得正式报价。只有用户明确同意对应输入与费用后才能提交生成。

当前 Skill 版本：**1.5.0**。仓库：[Reelpeat/reelpeat-product-video](https://github.com/Reelpeat/reelpeat-product-video)。入口：[SKILL.md](.codex/skills/reelpeat-product-video/SKILL.md)。本仓库仅包含Skill及其必要文档、打包和测试资源，不包含原业务仓库的历史、后端、MCP服务或个人凭据。

## 安装与运行条件

- 最低Node.js 18.3.0；不限制版本上限，不绑定指定主版本或LTS编号。已有满足要求的Node可直接使用，无需升降级或另装运行时。
- 宿主能加载 Skill、执行固定 Node 脚本、联网并读写本次授权工作区。
- 宿主需要实际图像查看能力；无法看图或播放视频时必须说明核验限制。
- 运行客户端无需 npm install、Python、MCP SDK或常驻本机连接器。

Codex项目使用时，将本目录中的完整 `.codex/skills/reelpeat-product-video/` 放入目标项目相同位置。不要只复制SKILL.md；scripts、references、agents须一起保留。其他宿主按其当前版本的Skill安装入口导入完整目录，不能由Node可执行推定宿主已兼容。

可先获取源码：

```bash
git clone https://github.com/Reelpeat/reelpeat-product-video.git
cd reelpeat-product-video
```

WorkBuddy使用下文打包命令生成的专用ZIP，其顶层多语言元信息由同一维护源转换。ZIP附件以实际Release为准，源码上传不代表已创建Release。

```bash
node .codex/skills/reelpeat-product-video/scripts/reelpeat.mjs --help
```

## 当前网关与Key配置

默认生产网关：

`https://www.reelpeat.com/`

门户和Skill统一引导使用生产地址。需要连接其他环境时，请主动告知Agent具体地址，不根据当前页面域名自动切换。未提供网关时，新配置使用此默认地址；用户显式提供其他网关时以其为准，已有配置不被默认值覆盖。发布源码不修改服务器网关、不读取或复制维护者已有Key。首次配置可省略 `--api-base`，也可显式指定：

```bash
node .codex/skills/reelpeat-product-video/scripts/reelpeat.mjs auth setup --api-base "https://www.reelpeat.com/"
```

配置引导默认同时提供三种选择：**Agent代配、临时网页、终端隐藏输入**。允许用户将个人Key直接发给Agent代配；聊天或工具记录可能保留输入，用户也可以选择自行填写，不必把Key发给Agent。Agent不复述Key、不把它放进命令参数、URL或报告，只通过官方客户端的受控stdin/隐藏终端传入，不修改其他Agent全局配置。

自行在终端配置时运行下面不含Key的命令，按提示粘贴后回车，输入不回显；Ctrl+C取消，不更改原配置：

```bash
node .codex/skills/reelpeat-product-video/scripts/reelpeat.mjs auth set --api-base "https://www.reelpeat.com/"
```

Agent或受控进程可用auth set --stdin，通过工具的标准输入传入原始Key后结束输入；不要改成--key或echo明文Key的shell命令。临时网页仍用上方auth setup启动，用户按“验证账号→确认保存”完成，不是只点验证。Key从已核验的Reelpeat账户入口创建，使用doctor或--help返回的完整account_url引导注册/登录；已有账号不用重复注册，充值仍走已核验账户入口。

保存结果返回config_file和绑定该路径的doctor下一步，网页可用auth status --setup-file查询；随后显式doctor --config核验相同绝对路径与执行环境。不会把鉴权/权限错误统一当作缺配置，不要求重复创建Key。

任一方式未成功时，助手会先说明具体错误或未知点，再介绍并引导其他实际可用方式，给出推荐理由、真实网页链接或已补齐路径/网关的完整命令，以及完成后的检查方法。网页打不开可改用终端隐藏输入或Agent代配；Agent没有输入工具可改为用户网页/终端。已保存先核对原路径，权限受限先说明可选存储范围；失效Key、网络不通或缺Node须处理共同前置，不会只换入口反复重试。用户已有明确选择与输入时沿用，不要求重发Key，也不自动改变存储位置。

默认保存在用户目录 `.reelpeat/credentials.json`，网关、Key和账号绑定在一起。文件每次命令重新读取，更换Key无需重启Agent。macOS/Linux目录0700、文件0600；普通文件是明文，不能防同一用户的其他进程读取。显式项目模式及宿主secret用法见[客户端合同](.codex/skills/reelpeat-product-video/references/client-usage.md)。云端localhost不等于用户电脑，没有可达配置页时使用Agent代配、受控secret或用户终端方式，并核实实际保存环境与权限。

```bash
node .codex/skills/reelpeat-product-video/scripts/reelpeat.mjs doctor --config "<保存结果返回的config_file绝对路径>"
```

doctor仅检查身份、能力及有权限时的余额，不解析商品、不准备或生成。不要读取凭据文件内容发给Agent。

## 使用示例与费用

在已加载此Skill的宿主中提出：

> 使用 reelpeat-product-video，将这个商品链接制作成马来西亚市场的带货视频。先解析商品、实际查看选定颜色原图并给出创意与正式报价，先不要提交付费生成。

商品链接不按电商平台白名单预先拒绝：解析能力与免费政策开放后，公开HTTP(S)商品链接（包括Lazada、Amazon及其他商城）保留SKU/变体参数交给服务端尝试。能否成功以实际来源响应为准；遇到登录、验证、无可信商品事实或服务不可用时如实说明并暂停。URL安全、真实看图与付费授权要求仍保留。

用户只提供图片与商品信息时，核验独立product_import能力，通过import-product传target_market直接创建，不要求商品链接或原解析任务；随后下载看图、先展示图片，再准备剧本与正式报价。解析失败或缺必要资料时，宿主可通过浏览器或用户提供的其他链接、商品信息与原图取材，经免费import-product导入继续；服务须明确公布fallback_import能力。见[失败补充合同](.codex/skills/reelpeat-product-video/references/product-fallback.md)。单条依次执行resolve（必要时import-product）、download并实际看图，**获取商品后先在用户可见回复中展示商品信息及至少一张真实商品图**，再设计剧本和prepare，停在quote_ready。首次出图不能推迟到报价或生成后；图片编号、JSON、路径文字和Agent自己看图不能代替向用户展示。不能内嵌时使用宿主实际可用的图片附件/用户可达预览，仍无法查看则说明阻塞并保留原任务，暂停单条后续准备/生成，不额外付费生图。默认一次展示“分镜与口播＋所选参考图预览＋规格与正式报价”，用户确认后才调用generate-video；已有明确覆盖本次输入、数量与金额的授权可以沿用。用户有明确要求时以用户要求为准，例如静音不额外补口播，首轮已展示且最终选图相同、明确不需重复时可引用图号；省略展示不自动授权未知费用。所有业务参数通过UTF-8 JSON文件或stdin传入，详细阶段、参数和授权格式见[客户端合同](.codex/skills/reelpeat-product-video/references/client-usage.md)。价格、余额及规格来自本次正式API响应，示例不保证平台、模型或价格恒定可用。

生成选档与页面统一为**轻量模型、标准模型、专业模型**，再选择该档实际开放的清晰度；单条确认和批次授权使用同一名称。宿主按[模型映射](.codex/skills/reelpeat-product-video/references/creative-guidance.md)转换为原接口值，客户端传参不变；模型推荐不替代正式报价与费用授权。

- `accepted`只代表受理或当前命令完成职责，不等于成片。
- 退出码2表示等待窗口耗尽，用原恢复文件resume；不能新建任务碰运气。
- 退出码3表示原任务成功但媒体交付不完整，只重试download。
- 原任务、授权及素材绑定账号和API地址，换账号或网关不能直接沿用旧记录。
- 保存的原图、提示词和恢复记录属于用户资料，默认位于工作区 `.reelpeat-local/`，不应提交Git。

每个用户可感知阶段都会说明当前结果/阻塞、下一步具体操作以及由谁执行。需要用户操作时给真实链接、完整命令或可直接回复的内容；助手可在既有授权内继续时说明后直接推进，不每一步都问是否继续。等待窗口结束给原任务续查方式，交付完成说明查看/下载方式和无需其他必做操作。批次仍一次确认范围内连续执行，不能把进度提示变成逐行审批。详见[分阶段用户引导](.codex/skills/reelpeat-product-video/references/progress-guidance.md)。

## 表格批次制作

支持由宿主已授权工具读取飞书、企微、钉钉等商品表；无工具时用导出CSV/XLSX。默认逐行解析、实际看图、准备分镜与正式报价，再展示完整批次清单，一次确认后在范围内串行生成。大批量可明确选择按固定商品、创意范围、规格、单行与整批上限授权后自主创作；其预算上限不是正式总报价。

助手会根据本次信息拟好可修改的授权建议，用户可以直接回复“按此批次执行”，无需自己写JSON或授权书；建议未确认前不消费。明确要求优先，已有匹配授权不重复询问。新增行、改商品/变体和超预算不会自动纳入；失败不自动付费重做。回写仅在明确要求及有权限时更新指定列。

客户端增加batch-init、batch-status，生成绑定原batch.json及稳定行ID；保留逐条Quote/指纹校验、原购买身份和费用记录。超预算、原任务未知或未结算时暂停后续收费，原任务resume/download不重做。详见[批次流程](.codex/skills/reelpeat-product-video/references/recovery-and-batch.md)与[命令合同](.codex/skills/reelpeat-product-video/references/client-usage.md)。客户端不读取表格、不安装平台SDK，也不提供会话结束后的自动调度。批次本地预算控制不能替代跨机器的服务端账户级预占。

## 本地自动测试

仅维护者运行打包和测试时需要Python 3.11+、Git及PyYAML；终端中的node应为拟验证版本。全部测试使用临时目录和合成回环HTTP服务，不需要个人Key，不调用真实网关或供应商，不产生真实费用。

```bash
python3 -m pip install -r requirements-dev.txt
node --test tests/client/*.test.js
python3 -m unittest discover -s scripts/tests -p 'test_*.py' -v
```

GitHub工作流：[check.yml](.github/workflows/check.yml)。push、pull_request和手动触发时，Ubuntu在选取的Node测试样本上运行同一测试和打包命令，测试样本不构成用户安装版本白名单；Actions固定提交SHA、只读仓库权限，不注入真实Key，也不自动创建Release或推送代码。托管执行结果以仓库Actions页面为准，本地测试通过不能代替托管执行状态。

## 本地打包

```bash
python3 scripts/package_reelpeat_skill.py --target codex --output output/reelpeat-product-video-codex.zip
python3 scripts/package_reelpeat_skill.py --target workbuddy --output output/reelpeat-product-video-workbuddy.zip
```

两个ZIP均只有一层reelpeat-product-video根目录，包含十个.mjs模块及引用文档，不含测试、凭据或运行数据。Codex包含agents/openai.yaml；WorkBuddy包转换顶层元信息。不修改源目录，也不读取或打包用户目录。

## 已知边界及发布前检查

- 当前公开图片目录合同未就绪时，不发起新生图；可使用已开放的原图视频路径或查询本人历史图片，实际能力仍以context为准。
- Codex当前项目路径已有测试依据；WorkBuddy包结构验证不能替代WorkBuddy实机安装。Windows ACL和其他Agent/云端的权限、配置页及媒体验收不能宣称已通过。
- 当前未选定开源许可证，不包含LICENSE；代码公开不代表已授予开源使用许可，后续由版权方决定。
- 本仓库只发布Skill源码及必要配套文件，不包含真实商品下载、生成结果、用户任务记录或有效API Key。
- 分享截图、日志和Issue时删除Key、鉴权头、临时签名URL、个人账号资料及完整恢复文件。

## 维护与同步

唯一维护源仍为主项目 `.codex/skills/reelpeat-product-video/`。本目录由主项目 `scripts/prepare_reelpeat_github.py` 显式白名单导出；不要同时手工维护两份Skill。后续GitHub修改应回流唯一维护源，再重新导出到新的空目录。导出不携带Git历史，也不覆盖已有目录中的许可证、提交或用户文件。

# 官方 Node.js 客户端执行合同

本文件与 Skill v1.1.2 同包。客户端只访问公开 API，不依赖 MCP、原项目仓库、Python、npm 安装或兄弟 Skill。当前默认原商品图生成视频；图片目录合同尚未开放时不发起新图片准备/生成，可查询和下载本人历史图片。

## 1. 先定位，再执行

从宿主已加载的 SKILL.md 确定技能根目录，调用其 scripts/reelpeat.mjs 的绝对路径。脚本内部按自身位置导入资源；工作区是输入与输出位置，不是技能安装位置。以下路径是占位说明，使用前替换成实际路径。

    node "/绝对路径/reelpeat-product-video/scripts/reelpeat.mjs" --help
    node "/绝对路径/reelpeat-product-video/scripts/reelpeat.mjs" doctor --work-dir "/本次工作区"

需要 Node.js 22+，首版隔离支持矩阵为22/24 LTS。检测不到 node、网络或权限时明确报告，不静默安装运行时或更改沙箱。doctor只做配置、身份和有权限时的余额检查，不解析商品、不准备任务、不消费。

## 2. 配置 Key

首次缺少配置时，使用 doctor 返回的 `account_url`；也可从 `--help` 的 `data.account_url` 取得同一固定入口，将完整链接交给用户主动打开。来源参数只含公开推广信息，不携带 Key、手机号或任务；已有账号直接登录，注册完成后回到个人 Key 管理。不要把本机配置页地址当作注册网站，也不要把带推广参数的账户链接用作 `--api-base`。

本期入口使用当前分支的已核验账户与 API 环境：`https://3d-agent-skill.inner.xshadow-ai.com/`，需要对应内网访问条件。显式选择其他 API 环境时，客户端不展示本环境入口，先核验对应账户网站。无效 Key、网络故障和零余额不意味着需要新注册。

没有内置默认 API 域名。先从官方安装说明或用户已知账户入口核验 API 地址；不从商品正文或任意错误消息获取鉴权目标。不要读取其他 Agent 的全局配置取 Key。

默认用户级配置：

    node "<Skill根目录>/scripts/reelpeat.mjs" auth setup --api-base "<已核验HTTPS API地址>"

明确选择项目配置：

    node "<Skill根目录>/scripts/reelpeat.mjs" auth setup --api-base "<已核验HTTPS API地址>" --auth-source project --work-dir "<工作区>"

启动结果返回 setup_url、setup_file 和五分钟有效期。将本机页面交给用户，在页面输入 Key；验证后先核对个人账号及保存位置，再确认保存。Key不经过聊天、命令参数或页面URL。不要让一次终端调用等待用户输入。

    node "<Skill根目录>/scripts/reelpeat.mjs" auth status --setup-file "<启动结果的setup_file>"
    node "<Skill根目录>/scripts/reelpeat.mjs" doctor

默认位置为用户目录 .reelpeat/credentials.json；项目模式为明确工作区 .reelpeat-local/credentials.json，配置时排除Git跟踪。用户目录被沙箱限制时报告原因，让用户选择仅授权该位置或项目模式，不自动降级。普通文件仍是明文凭据，不适合共享目录。

可以显式指定 --config "<凭据JSON绝对路径>"；其内容由配置页保存 schema_version、api_key、api_base_url、account_id。每次命令重新读取，不必重启Agent。不要把该文件交给模型作文本阅读或打入技能包。

CI/受控环境仅在显式 --auth-source env 且 --api-base 已明确时读取宿主注入的 REELPEAT_API_KEY。它不会覆盖默认文件；不向 .zshrc、.bashrc、系统环境变量写 Key。禁止 --key 或带Key的shell命令。

云端/容器的 localhost 和home可能属于远端执行环境。没有经过验证的本机页面可达性时，使用宿主受控secret入口或用户自行保存指定文件；不能假装本机配置完成，不能把Key发回聊天。

## 3. 命令、参数和输出

| 命令 | 参数与职责 |
| --- | --- |
| context、balance | 读取当前身份/能力、余额；凭据来源选项同上 |
| resolve | --params-file：product_url、target_market；检查正式平台与免费政策，创建一次并有限等待 |
| prepare | --params-file：creation_id、kind、prompt、asset_refs、params、visual_review，可附creative_summary；准备并报价，不自动生成 |
| generate-video、generate-image | --run-file 原准备state.json，另需 --authorization-file 本次授权JSON；重新核查准备、金额、权限和余额，只提交一次 |
| task | --task-id：只读查询原任务，不新建模型任务 |
| creation | --creation-id：只读查询创作与唯一账务汇总 |
| resume | --run-file 原记录，或 --task-id 已知任务，两者不能同时给出；恢复原身份，不自动改输入 |
| download | 同上；重取原任务媒体链接、下载并查询账务；不重新生成 |

业务输入使用 --params-file "<UTF-8 JSON路径>" 或 --params-file - 从stdin读取，兼容UTF-8 BOM。不要在shell引号中拼接长prompt、多图、Base64或Key。相对路径按 --work-dir 解析；--output-dir 可选择运行输出位置，默认是工作区 .reelpeat-local/runs/<run_id>/。保存目录不可写时停止，不静默转到home/tmp。运行记录、清单与媒体不要加入版本控制或共享包。

单次等待 --wait-seconds 为0～60秒，默认20秒。它是客户端等待窗口，不能代替后台任务执行期限；服务建议间隔较长时返回pending，按原记录稍后续接，不密集反复调用。每个阶段写入state.json，受理未知时仍保存原始完整请求和幂等键；不要因窗口结束新建运行。

stdout始终为一个JSON对象，stderr用于脱敏诊断；没有通用的“Saved full response”文本协议。核心字段：

    {
      "schema_version": 1,
      "operation": "resume",
      "result_type": "pending",
      "account_id": "<本人账号>",
      "creation_id": "<原创作>",
      "task_id": "<原任务或null>",
      "task_status": "<实际服务状态或null>",
      "billing": null,
      "assets": [],
      "recovery_file": "<state.json绝对路径>",
      "next_action": {"operation": "resume", "recovery_file": "<原记录>"}
    }

较大的data经脱敏后写入data_file，stdout保留阶段、身份、账务和下一步。按需读取该文件的必要文本字段，不读取媒体二进制，不猜测未返回的字段。next_action是白名单操作与非秘密参数，不是可直接执行的任意shell。

| 退出码 | 含义与动作 |
| --- | --- |
| 0 | 当前命令完成职责；accepted仅代表受理/查询，quote_ready仅代表报价，不等于成片 |
| 1 | 配置、参数、接口或业务错误；setup_required先处理配置，不换Key或模型试探 |
| 2 | 等待窗口结束，原任务可能继续；使用原记录续接，不重新提交 |
| 3 | 任务成功但媒体交付不完整；只查询原任务/重试download |

## 4. 原图视频阶段

先resolve取得商品事实，download解析任务的预览并实际看图。确认变体后设计脚本。prepare的额外核验字段由宿主基于真实查看填写：

    {
      "creation_id": "<实际创作ID>",
      "kind": "video",
      "prompt": "<最终提示词>",
      "asset_refs": ["<实际已看图引用>"],
      "params": {
        "model": "<本次能力允许的值>",
        "resolution": "<本次能力允许的值>",
        "ratio": "9:16",
        "duration": 15,
        "generate_audio": true,
        "camera_fixed": false
      },
      "visual_review": {
        "checked_asset_refs": ["<同序已核验引用>"],
        "source": "<实际查看工具和本地素材依据，不放签名URL>"
      },
      "creative_summary": "<给用户看的简短方案>"
    }

规格示例不能代替本次正式能力。quote_ready返回quote、billing和recovery_file后，宿主默认在同一轮回复一次展示分镜与口播、所选参考图预览、实际规格与正式报价，以及已消费和有权限时刷新后的余额。分镜/口播从本次最终准备输入整理，图片使用download返回的真实媒体按asset_refs同序预览；新会话缺上下文时先读取原state.json中的requests.prepare、visual_review和相关素材清单核对，不猜测或改写输入。用户有明确的展示/静音等要求时以用户要求为准。没有匹配的明确授权则等待确认；已有覆盖本次输入、数量与金额的明确授权时告知沿用，不重复询问。客户端不创建额外确认UI，也不以内部ID或JSON代替图片展示。

取得用户针对本次账号、输入、数量和上限的明确授权后，宿主创建UTF-8授权JSON：

    {
      "account_id": "<本人账号>",
      "creation_id": "<原准备的创作>",
      "preparation_id": "<原准备ID>",
      "quote_id": "<正式Quote>",
      "input_fingerprint": "<原指纹>",
      "max_credits": 0,
      "count": 1,
      "source": "<本对话明确授权的可追溯依据>",
      "authorized_at": "<实际带时区RFC3339时刻>"
    }

max_credits=0仅是占位，不代表免费或可以省略授权。填入用户明确批准的整数上限；授权文件本身不能证明用户已同意，宿主必须先检查对话。没有永久approved标志，不把创建Key或Key上限当消费授权。

    node "<Skill根目录>/scripts/reelpeat.mjs" generate-video --run-file "<原准备state.json>" --authorization-file "<本次授权文件>"

状态未知时使用resume；不能换MCP入口、换幂等键或复制作新运行来重做。报价过期时先核查原受理事实，再按主Skill规则重新准备/询价；客户端不静默刷新报价或扩大授权。

## 5. 媒体交付与费用

完成后download返回实际本地绝对路径、manifest_file、任务及创作账务，有余额权限时另查余额。脚本不会重算价格；缺金额是未知，final=false仍待结算。单个媒体上限256MiB，拒绝空文件、类型/文件头不符、重定向和不完整下载；超限时说明限制，不自动降低生成规格。

媒体清单将生成、下载和content_review分开。初始not_checked，由宿主使用实际图像/视频查看能力核验；存在文件不等于商品一致性通过。下载失败只刷新原任务链接并下载失败项，已有文件保留；不重新购买。

在Codex或其他能渲染本地媒体的宿主中，使用实际绝对路径展示图片/视频；不能把JSON报告冒充媒体。Claude Code、WorkBuddy桌面、CodeBuddy Code CLI、IDE和云端的展示与权限分别验证，不依赖同品牌其他产品的变量或产物通道。没有查看/播放能力时如实说明，不能伪报画面或口播验收通过。

## 6. 安装包与宿主验收边界

发布包由同一份技能源生成，均只有一层 reelpeat-product-video 根目录。Codex 包包含 agents/openai.yaml；WorkBuddy 包转换顶层多语言元信息。两包都携带全部八个 .mjs 模块和引用文档，不包含凭据、任务数据、媒体、Python 或 MCP 服务。更新只替换技能资源，不覆盖位于技能目录之外的凭据与恢复文件。安装和卸载遵守当前宿主实际入口，不替用户改全局配置。

| 宿主 | 安装与调用要求 | 本轮验收状态 |
| --- | --- | --- |
| Codex 桌面 / CLI / IDE | 各自使用实际版本的技能安装入口；从已加载 SKILL.md 定位脚本。桌面、CLI、IDE及远程工作区分别记录运行位置和权限 | 已从当前 Codex 工具运行隔离测试和独立包；没有新安装包的完整真实商品流程证据 |
| WorkBuddy 桌面 | 使用 WorkBuddy 目标 ZIP，按当前版本入口导入；核实真实 cwd、Node、配置页与原生媒体展示 | 独立包结构及解压后执行已测试；未在 WorkBuddy 实机安装 |
| Claude Code | 按实际支持的技能或插件安装入口加载资源；只有核验版本支持时才使用其专属目录变量 | 未实测，不使用其他品牌变量或竞品说明代替验收 |
| CodeBuddy Code CLI | 与 WorkBuddy 桌面分别验收；以实际版本的发现机制和已加载路径为准 | 未实测，不假设桌面包和CLI产物通道通用 |
| Cursor Agent / Gemini CLI | 先确认当前版本可加载本 Skill，再检测 Node、网络、文件权限与媒体工具 | 未实测，不因能执行JavaScript就标兼容 |
| 云端 / 容器 / SSH远端 | 明确实际执行位置；安全secret、持久化、配置页转发及产物交付须逐一可用 | 未实测；没有安全配置和用户可达产物通道时阻塞，不能交付远端localhost当成本机页面 |

Windows 原生终端与 WSL 分开验收。客户端在 Windows 使用系统 PowerShell 设置并核验私有 ACL，缺工具或失败则停止；本轮仅在 macOS 跑隔离合同测试，未执行 Windows ACL 分支。完整兼容矩阵及 AC-01～10 见项目改造方案，只有对应宿主/版本/系统有实际证据后才能声明支持。

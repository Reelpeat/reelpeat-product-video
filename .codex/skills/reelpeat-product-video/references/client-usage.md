# 官方 Node.js 客户端执行合同

本文件与 Skill v1.3.5 同包。客户端只访问公开 API，不依赖 MCP、原项目仓库、Python、npm 安装或兄弟 Skill。当前默认原商品图生成视频；图片目录合同尚未开放时不发起新图片准备/生成，可查询和下载本人历史图片。

## 1. 先定位，再执行

从宿主已加载的 SKILL.md 确定技能根目录，调用其 scripts/reelpeat.mjs 的绝对路径。脚本内部按自身位置导入资源；工作区是输入与输出位置，不是技能安装位置。以下路径是占位说明，使用前替换成实际路径。

    node "/绝对路径/reelpeat-product-video/scripts/reelpeat.mjs" --help
    node "/绝对路径/reelpeat-product-video/scripts/reelpeat.mjs" doctor --work-dir "/本次工作区"

最低需要Node.js 18.3.0，不限制版本上限，不要求使用指定主版本或LTS编号。宿主已有满足最低要求的Node时直接使用，不要求升级、降级或另装一份。检测不到 node、网络或权限时明确报告，不静默安装运行时或更改沙箱。doctor只做配置、身份和有权限时的余额检查，不解析商品、不准备任务、不消费。

## 2. 配置 Key

首次缺少配置时，使用 doctor 返回的 `account_url`；也可从 `--help` 的 `data.account_url` 取得同一固定入口，将完整链接交给用户主动打开。来源参数只含公开推广信息，不携带 Key、手机号或任务；已有账号直接登录，注册完成后回到个人 Key 管理。不要把本机配置页地址当作注册网站，也不要把带推广参数的账户链接用作 `--api-base`。

本期入口使用当前分支的已核验账户与 API 环境：`https://3d-agent-skill.inner.xshadow-ai.com/`，需要对应内网访问条件。显式选择其他 API 环境时，客户端不展示本环境入口，先核验对应账户网站。无效 Key、网络故障和零余额不意味着需要新注册。

`--api-base` 使用同站根地址 `https://3d-agent-skill.inner.xshadow-ai.com/`，身份接口为 `/api/open/v1/context`。用户给出 `/vorder/app` 工作台链接时，客户端将这一明确页面路径规范到同站根地址；保存、重读及 MCP 请求使用相同规则。其他部署前缀保留，URL 中的凭据、查询参数和片段仍拒绝。此兼容不证明已有 Key 有效，也不跨环境迁移 Key。

没有内置默认API域名。先从官方安装说明或用户已知账户入口核验API地址；不从商品正文或任意错误消息获取鉴权目标，不读取其他Agent全局配置取Key。

### 三种配置选择

默认允许用户直接将个人Key发给Agent代配；首次引导在同一回复中同时提供以下三种选择，不要求用户必须打开网页，也不要求用户必须发Key。简短提示“聊天或工具记录可能保留你发送的Key，也可选择网页或终端自行输入”，用户明确选择后沿用，不重复确认。

1. **Agent代配：**用户主动提供Key并要求配置时，Agent使用官方auth set，通过受控stdin或隐藏输入的终端传入；不复述Key，不把Key插入shell命令、参数、URL、临时文件、报告或运行记录。工具输入记录可能保留用户提供的Key，不能承诺模型或平台看不到。工具只支持把秘密拼进命令字符串时，不这样代配，改提供网页或用户终端方式。先核验API目标和实际执行环境；代配只保存配置，不授权充值或生成。
2. **临时网页：**在实际执行环境启动本机页面，由用户填写Key、验证账号并确认保存；需要用户浏览器确实可访问该环境的回环服务。
3. **用户终端命令：**给出下面不含Key的完整命令，用户在自己的终端执行并粘贴Key，输入不回显；不要求安装Python或npm依赖。

用户终端配置（用实际Skill路径及已核验API替换占位）：

    node "<Skill根目录>/scripts/reelpeat.mjs" auth set --api-base "<已核验HTTPS API地址>"

按提示粘贴Key后回车即可验证和保存，Ctrl+C取消。使用--config "<指定文件绝对路径>"可选择位置；明确选择项目配置时追加--auth-source project --work-dir "<工作区>"，否则仍用默认用户目录。命令不包含Key，不写shell历史；不要改成--key、echo明文Key或带Key的here-doc。

Agent/受控进程使用标准输入时：

    node "<Skill根目录>/scripts/reelpeat.mjs" auth set --api-base "<已核验HTTPS API地址>" --stdin

由宿主的stdin能力传入原始Key文本并结束输入，不是JSON，不把Key拼进上述命令。非交互管道未指定--stdin时立即返回KEY_INPUT_REQUIRED，避免Agent工具一直等待。若宿主提供PTY可执行不带--stdin的auth set，等待隐藏输入提示，再通过终端输入工具发送Key和回车。这里不需要用户再次输入已主动提供的同一Key；实际工具支持和平台记录边界仍须如实说明。

临时网页配置：

    node "<Skill根目录>/scripts/reelpeat.mjs" auth setup --api-base "<已核验HTTPS API地址>"

明确选择项目配置：

    node "<Skill根目录>/scripts/reelpeat.mjs" auth setup --api-base "<已核验HTTPS API地址>" --auth-source project --work-dir "<工作区>"

启动结果返回setup_url、setup_file和五分钟有效期。用户打开页面，依次“验证账号→核对个人账号及保存位置→确认保存”；仅验证账号不等于保存。配置页过期不删除已保存凭据。不要延长有效期、加原始请求日志或修改随包脚本来绕过环境问题。

### 保存与同路径核验

auth set验证个人账号、保存并从相同文件重读后返回setup_status=completed、account_id、config_file与next_action。网页保存后通过以下命令取回相同字段：

    node "<Skill根目录>/scripts/reelpeat.mjs" auth status --setup-file "<启动结果的setup_file>"
    node "<Skill根目录>/scripts/reelpeat.mjs" doctor --config "<保存结果返回的config_file绝对路径>"

必须在相同执行环境核验返回的绝对路径；不要从指定文件/项目模式改用裸doctor去读另一个默认目录。doctor区分setup_required（配置缺失）与error（鉴权、权限、网络等失败），保留error.code/message；不能将所有错误概括为“未配置”并要求重复创建Key。成功只告知账号、保存位置与检查结论，不输出Key或配置文件正文。

默认位置为用户目录 .reelpeat/credentials.json；项目模式为明确工作区 .reelpeat-local/credentials.json，配置时排除Git跟踪。用户目录被沙箱限制时报告原因，让用户选择仅授权该位置或项目模式，不自动降级。普通文件仍是明文凭据，不适合共享目录。

可以显式指定 --config "<凭据JSON绝对路径>"；其内容由配置页保存 schema_version、api_key、api_base_url、account_id。每次命令重新读取，不必重启Agent。不要把该文件交给模型作文本阅读或打入技能包。

CI/受控环境仅在显式 --auth-source env 且 --api-base 已明确时读取宿主注入的 REELPEAT_API_KEY。它不会覆盖默认文件；不向 .zshrc、.bashrc、系统环境变量写 Key。禁止 --key 或带Key的shell命令。

云端/容器的 localhost 和home可能属于远端执行环境。没有经过验证的本机页面可达性时，使用宿主受控secret入口或用户自行保存指定文件；不能假装本机配置完成；用户选择Agent代配时只配置其认可的执行环境和存储位置，保存后返回路径供核验，不复述Key。

### 失败后的替代配置

身份检查按服务端证据解释：`INVALID_API_KEY` 表示当前服务无法识别输入值，先核对创建网站与 API 是否同环境、完整值是否正确；不代表团队 Key。`API_KEY_INACTIVE` 表示已过期、已删除或账号不可用。`PERSONAL_WORKSPACE_REQUIRED` 表示请求携带了 `X-Workspace-Id`，不能据此声称 Key 来自团队。`API_KEY_MASKED` 表示误填列表掩码。只有成功身份响应明确返回 `workspace=team` 才解释为团队空间；`AUTH_CHECK_FAILED` 或 `CONTEXT_INVALID` 不能证明 Key 的空间类型。用户已点击新建后的复制按钮时，不再假设复制了掩码；核对实际 API 地址和具体错误，不要求反复重建 Key。

用户说“配置没成功”即进入本节，不必等用户能提供完整错误日志。先说明已确认的失败阶段、受控错误码和仍未知的部分，保留已选API、账号/存储范围、setup_file、config_file与原制作需求；不要为排错索取Key截图、配置文件正文或原始请求日志。能用auth status/同路径doctor只读核验时先核验；拿不到远端结果时如实说明，不用当前电脑的结果代替另一环境。

| 当前问题 | 先核对什么 | 如何引导其他可用方式 |
| --- | --- | --- |
| 网页打不开、过期、页面操作受阻 | 启动是否成功、是否在同一电脑/沙箱、是否只到“验证账号”未确认保存 | 推荐用户终端隐藏输入，或在有受控stdin/PTY的宿主中由Agent代配；用户仍想用网页且环境可达时再启动新临时页，不反复只换页面地址 |
| Agent无法接收stdin/PTY，或用户不想在聊天提供Key | 宿主真实工具能力与用户选择 | 给用户可达的临时网页，或其本机可执行的auth set完整命令；不编造已经启动的页面，也不将Key拼入shell命令 |
| 终端命令无法执行 | Skill真实路径、Node是否满足最低要求、命令运行位置 | 修正可确认的命令问题；用户不便使用终端时介绍可达网页或Agent代配。相同环境缺Node时三种方式都会受影响，不能承诺换入口就能解决，不要求可用高版本升降级 |
| 已保存但doctor报错 | auth status的保存路径与doctor的读取路径、实际执行环境、error.code | 先显式doctor --config核验原绝对路径；确认原配置不可用后再介绍其他方式，不误将已验证的Key当作未提供 |
| 目录或权限受限 | 当前所选文件是否可读写、用户允许的工作区范围 | 说明可授权原位置，或明确选择项目配置；用户选择后给带--auth-source project和实际--work-dir的网页/终端命令，不自动降级、不放宽文件权限 |
| 鉴权、账号/API不匹配、网络或限流失败 | 已核验的API、个人空间、具体错误及可达性 | 先处理共同前置；换输入方式不会修复失效Key或服务不通。确认需换Key才引导用户创建新的个人Key，网络问题不要求重复注册；只有已确认另一执行环境可达时才建议在该环境配置 |

给出替代方式时，在同一回复提供：**本次受阻原因或未知点＋推荐替代方式及理由＋实际链接/不含Key的完整命令＋完成后如何检查**。仅列“网页、命令、代配”三个名词不算完成引导。终端方式用上文auth set命令，补齐本次真实Skill路径和已核验API；网页仅使用本次实际返回的setup_url。涉及改变存储位置时补齐对应范围参数；不确定路径或工具是否可用时先核实，不让用户执行占位命令。

例如用户本机网页打不开、但本机终端已具备Node与该Skill时，可说明：“这次临时页尚未打开成功，可以改用终端隐藏输入，省去网页步骤。运行下面已填好路径和网关的命令，粘贴Key后回车；如果更希望我代配，也可以选择Agent代配。”随后给出实际auth set命令，并说明保存后按返回的config_file运行doctor。用户已提供Key且明确要求可用的Agent代配时直接处理，不再要求重发。

用户选择其他方式后只执行该方式，失败原因未变化时不无限轮换入口；保留已验证结果、具体阻塞和可选下一步。配置通过后按本次保存返回的config路径检查；账号/API与原任务一致时沿用原恢复点，不因切换配置方式重新解析或重新提交付费任务。若账号/API变化，停止沿用原素材和授权。

## 3. 命令、参数和输出

| 命令 | 参数与职责 |
| --- | --- |
| context、balance | 读取当前身份/能力、余额；凭据来源选项同上 |
| resolve | --params-file：product_url、target_market；检查解析能力与免费政策，公开HTTP(S)商品链接不按平台预拦截，保留变体参数并交给服务端尝试，创建一次并有限等待 |
| prepare | --params-file：creation_id、kind、prompt、asset_refs、params、visual_review，可附creative_summary；准备并报价，不自动生成 |
| generate-video、generate-image | --run-file 原准备state.json，单条另需 --authorization-file 本次授权JSON；批次用 --batch-file 与 --batch-row；重新核查准备、金额、权限和余额，只提交一次 |
| batch-init | --params-file：已明确确认的固定批次清单；创建本地batch.json，不提交生成 |
| batch-status | --batch-file：核对原批次任务与账务，返回各行状态和预算占用 |
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

先resolve取得商品事实，download解析任务的原图并实际看图。**单条在此阶段先给用户展示商品信息和真实商品图，完成后才设计脚本与prepare；不是只在工具内部看图，也不能等quote_ready后才首次输出。**download返回的assets.local_path/manifest_file是取图依据，JSON本身不是图片。选取能辨认商品/已确定变体的主图，至少展示一张；需要用户确定颜色时展示必要候选图、图号及变体，不默选未知款式。

宿主使用实际支持的图片附件、图集或图片嵌入输出。能渲染本地媒体时用返回的真实绝对路径；远端/云端产物须通过用户可达的宿主媒体通道，不能把远端磁盘路径当用户可见图片。没有内嵌能力时可提供可打开的实际图片预览并明确说明；只有asset_ref、路径文字、图片编号或“已展示”的陈述均不算完成。不得编造豆包等宿主专用协议或假设Markdown本地路径一定可显示。

下载或展示失败时，只用原任务download/查询恢复或尝试宿主可用媒体通道；没有实际可查看的商品图就明确阻塞，暂停单条prepare/生成，不重新解析碰运气或付费生图代替商品原图。商品图展示不额外要求每张审批；已知变体时展示后可继续无费用创意，正式生成仍按原报价授权规则。批次模式沿用批次合同。

确认变体后设计脚本。对用户按[模型选档与接口映射](creative-guidance.md)展示轻量模型、标准模型、专业模型；宿主在准备前映射到原有params.model，客户端不新增中文档位字段。prepare的额外核验字段由宿主基于真实查看填写：

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

规格示例不能代替本次正式能力。quote_ready返回quote、billing和recovery_file后，单条任务的宿主默认在同一轮回复一次展示分镜与口播、所选参考图预览、实际规格与正式报价，以及已消费和有权限时刷新后的余额。分镜/口播从本次最终准备输入整理，图片使用download返回的真实媒体按asset_refs同序预览；新会话缺上下文时先读取原state.json中的requests.prepare、visual_review和相关素材清单核对，不猜测或改写输入。用户有明确的静音或展示粒度要求时沿用；不重复预览仅适用于首轮已展示且最终选图未变，不能省略首次商品图。没有匹配的明确授权则等待确认；已有覆盖本次输入、数量与金额的明确授权时告知沿用，不重复询问。客户端不创建额外确认UI，也不以内部ID或JSON代替图片展示。表格批次按下文批次命令一次确认，不逐行重复要求确认。

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

## 批次命令

先读[批次确认与授权建议](recovery-and-batch.md)。宿主负责已授权的表格读取、源行变化核验、实际看图、创意语义和展示；客户端负责固定行/输入或规格/原图范围、串行购买、幂等、单行及整批金额检查。它不自动读取表格或运行常驻循环。主SKILL的一次确认要求可由整批完整清单满足，或由明确的规则授权替代逐行创意确认。

宿主先拟好用户可读建议，用户明确确认后才创建以下UTF-8 JSON并执行batch-init。不要要求用户填写文件；source保存本次建议版本、用户明确回复及其可追溯依据，不是模型替用户写“已批准”。规则/来源/时刻及上限都须来自实际确认。

    {
      "mode": "prepared",
      "table_source": "<表/工作表/筛选范围的非秘密说明>",
      "rows": [{
        "row_id": "<稳定行ID或每视频子项ID>",
        "resolve_file": "<本行已完成解析的state.json绝对路径>",
        "variant": "<已确定变体>",
        "prepare_file": "<本行正式准备的state.json绝对路径>",
        "max_credits": 0
      }],
      "max_credits": 0,
      "on_failure": "stop",
      "duplicate_policy": "reject",
      "source": "<本次确认建议版本与用户明确回复的对话依据>",
      "authorized_at": "<实际带时区RFC3339时刻>"
    }

0只是整数占位；填用户明确确认的单行与整批上限。每子项制作一条，独立creation与row_id；默认禁止重复商品链接，用户确认有意重复制作才用duplicate_policy=keep。on_failure=stop表示明确失败后停止；skip表示该行费用终结后记录失败并继续其他行，不授权重做。资料不全的跳过规则和回写列写在用户可读建议与来源依据中，由宿主执行。

- **prepared（默认）：**所有列入的行均已有正式视频报价与实际看图记录。客户端保存已批准的完整kind/prompt/有序asset_refs/params；同输入重新准备可以换Quote，改输入不能沿用。正式总报价由宿主从各行实际Quote合计展示，与预算上限分别说明。
- **rules（明确选择）：**先免费解析确定本批商品和变体。rows去掉prepare_file，增加rules对象，其params为本合同第4节六项完整视频规格，creative_scope为已确认的市场/语言及脚本、选图自主范围。客户端限制所选引用来自本行解析的image_refs，规格与rules.params完全一致；宿主仍须实际看图核验变体及创意语义。不得把规则模式当任意prompt或金额的永久许可。只有预算上限，没有整批正式报价。

    node "<Skill根目录>/scripts/reelpeat.mjs" batch-init --params-file "<用户确认后创建的批次JSON>" --work-dir "<工作区>"

返回data.batch_file、batch_id、scope_hash、row_count及max_credits。原批次保存到工作区.reelpeat-local/batches/<batch_id>/batch.json（私有目录/文件）；包含确认快照、来源和行→原准备运行映射，不能发布或发到公开表格。单次JSON读取上限2MiB，超出时明确拆成用户可核对的多个批次，不能无提示截断。该命令只写本地记录，不购买、不把预算预占到服务端。客户端不能验证人类是否真的同意，也不能用本地hash抵御同一用户主动篡改所有文件。

每行准备就绪且宿主核对创意范围后：

    node "<Skill根目录>/scripts/reelpeat.mjs" generate-video --run-file "<本行原准备state.json>" --batch-file "<原batch.json>" --batch-row "<稳定行ID>"
    node "<Skill根目录>/scripts/reelpeat.mjs" batch-status --batch-file "<原batch.json>"

批次与单条authorization-file互斥。客户端会从已确认批次派生绑定本次preparation/Quote/指纹、数量1的单次授权，重新核查正式金额、Key上限和余额。新购买前持久化行→run_file及本次报价占用；本行只能续接该原运行，不能换新prepare付费重做。报价过期而从未尝试购买的行，可在排除原受理后以同输入重新prepare，在行/批上限内继续。因余额不足已留下占用的行，充值后仍用原运行重试，不清零占用。

batch-status按每个creation唯一账务返回used_or_reserved_credits和remaining_credits：已终结用真实consumed_credits，未终结保留原报价。没有将task再加到creation上重复计数。为避免未知结算风险，批次串行等待当前任务和账务均终结，再执行后续收费；等待本身不自动触发新购买。接口失败或金额未知时停止，不能以本地旧状态推测可继续。

同一batch.json的消费使用排他锁；异常退出可能保留batch.json.lock。先核查锁内PID、原进程与原任务状态，确认没有并发执行者后再处理锁，保留batch.json及全部state.json；不自动过期抢锁。跨机器、不同批次或用户手工复制/修改文件不能获得统一账户级预算保证。换账号/API拒绝沿用；任务已受理后使用原state.json resume/download，不能重建批次绕过。

兼容验收需确认：宿主可持久保存batch.json与行state.json、重启后按稳定行标识续接、一次确认派生多笔单次授权、超预算与未知任务阻断、真实图片展示、表格只读/回写权限分开，以及无调度时如实说明停止。客户端隔离测试只覆盖客户端行为，不替代飞书/企微/钉钉连接器及各Agent实机验收。MCP兼容模式仍按宿主保存原记录编排，不声称具备本Node批次文件的自动预算门禁；未知受理不切换入口。

## 5. 媒体交付与费用

完成后download返回实际本地绝对路径、manifest_file、任务及创作账务，有余额权限时另查余额。脚本不会重算价格；缺金额是未知，final=false仍待结算。单个媒体上限256MiB，拒绝空文件、类型/文件头不符、重定向和不完整下载；超限时说明限制，不自动降低生成规格。

媒体清单将生成、下载和content_review分开。初始not_checked，由宿主使用实际图像/视频查看能力核验；存在文件不等于商品一致性通过。下载失败只刷新原任务链接并下载失败项，已有文件保留；不重新购买。

在Codex或其他能渲染本地媒体的宿主中，使用实际绝对路径展示图片/视频；不能把JSON报告冒充媒体。Claude Code、WorkBuddy桌面、CodeBuddy Code CLI、IDE和云端的展示与权限分别验证，不依赖同品牌其他产品的变量或产物通道。没有查看/播放能力时如实说明，不能伪报画面或口播验收通过。

## 6. 安装包与宿主验收边界

发布包由同一份技能源生成，均只有一层 reelpeat-product-video 根目录。Codex 包包含 agents/openai.yaml；WorkBuddy 包转换顶层多语言元信息。两包都携带全部十个 .mjs 模块和引用文档，不包含凭据、任务数据、媒体、Python 或 MCP 服务。更新只替换技能资源，不覆盖位于技能目录之外的凭据与恢复文件。安装和卸载遵守当前宿主实际入口，不替用户改全局配置。

| 宿主 | 安装与调用要求 | 本轮验收状态 |
| --- | --- | --- |
| Codex 桌面 / CLI / IDE | 各自使用实际版本的技能安装入口；从已加载 SKILL.md 定位脚本。桌面、CLI、IDE及远程工作区分别记录运行位置和权限 | 已从当前 Codex 工具运行隔离测试和独立包；没有新安装包的完整真实商品流程证据 |
| WorkBuddy 桌面 | 使用 WorkBuddy 目标 ZIP，按当前版本入口导入；核实真实 cwd、Node、配置页与原生媒体展示 | 独立包结构及解压后执行已测试；未在 WorkBuddy 实机安装 |
| Claude Code | 按实际支持的技能或插件安装入口加载资源；只有核验版本支持时才使用其专属目录变量 | 未实测，不使用其他品牌变量或竞品说明代替验收 |
| CodeBuddy Code CLI | 与 WorkBuddy 桌面分别验收；以实际版本的发现机制和已加载路径为准 | 未实测，不假设桌面包和CLI产物通道通用 |
| Cursor Agent / Gemini CLI | 先确认当前版本可加载本 Skill，再检测 Node、网络、文件权限与媒体工具 | 未实测，不因能执行JavaScript就标兼容 |
| 云端 / 容器 / SSH远端 | 明确实际执行位置；安全secret、持久化、配置页转发及产物交付须逐一可用 | 未实测；没有安全配置和用户可达产物通道时阻塞，不能交付远端localhost当成本机页面 |

Windows 原生终端与 WSL 分开验收。客户端在 Windows 使用系统 PowerShell 设置并核验私有 ACL，缺工具或失败则停止；本轮仅在 macOS 跑隔离合同测试，未执行 Windows ACL 分支。完整兼容矩阵及 AC-01～10 见项目改造方案，只有对应宿主/版本/系统有实际证据后才能声明支持。

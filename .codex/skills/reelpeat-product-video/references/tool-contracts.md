# MCP兼容工具合同与当前边界

默认官方Node客户端见[客户端执行合同](client-usage.md)。本页保留MCP兼容入口与同一组公开业务字段；选择MCP时才按工具Schema调用，禁止因写请求结果未知而跨入口重提。

本页按仓库 `ec6dc1b72`（2026-10-22）的 MCP Schema 与对客路由核对，不代表某个部署已经开启能力。工具实际 Schema 和可核验的服务能力优先。通过配套连接器调用，不从本页猜测域名或自行访问内部 API。

## 八个工具

以下为 **MCP 参数**，不是直接 HTTP 请求体。连接器把 `idempotency_key` 转为 `Idempotency-Key` 请求头，个人 Key 从宿主凭据层注入；两者都不需要用户在聊天填写。

| 工具 | 输入 | 输出与注意事项 |
| --- | --- | --- |
| `reelpeat_get_context` | `{}` | `data.account_id/workspace/capabilities/capability_details`；另返回当前 Key 的 `scopes` 与 `max_credits_per_generation`，响应 `no-store`。能力按本次 Key、开关及已发布目录读取，不是资金预占或后续受理保证；旧部署缺字段时不猜 |
| `reelpeat_get_balance` | `{}` | `data.available_credits/frozen_credits/account_status/as_of`；要求 `account:read`，零余额可查询，不隐式开户 |
| `reelpeat_resolve_product` | `product_url, target_market, idempotency_key` | `data.creation_id/task_id/status/result/poll_after_seconds`；MCP 对应 `POST /api/open/v1/products/resolve`，不是旧方案中的 POST creations |
| `reelpeat_prepare_generation` | `creation_id, kind, prompt, asset_refs, params, idempotency_key` | `data.preparation_id/creation_id/kind/status/poll_after_seconds` 等；随后把 preparation ID 作为 `task_id` 查询。kind 为 image 或 video；字段为 `params`，不是 `specification` |
| `reelpeat_generate_image` | `creation_id, preparation_id, quote_id, idempotency_key, max_credits` | 单张图片任务；不接受额外 prompt、规格或素材，使用准备快照 |
| `reelpeat_generate_video` | 与图片提交相同 | 视频任务；不在 MCP 请求中等待视频完成 |
| `reelpeat_get_task` | `task_id` | `data.task_id/creation_id/kind/status/stage/result/billing/poll_after_seconds/error_code`；四类任务均走此工具 |
| `reelpeat_get_creation` | `creation_id` | `data.creation_id/status/tasks/billing`；当前不返回顶层商品/素材集合，从相关任务的 result 续接，不能凭空读取 `data.assets` |

资源 ID 最多 128 字符；幂等键非空且最多 256 字符，不截短。prompt 长度 1–10000；asset refs 选 1–9 个不重复引用，实际服务可进一步收紧。不要传 `owner_user_id/payer_id/account_ref`、Key、团队空间、任意 URL、OSS Key 或本地路径来替代归属引用。

### 输入规格

新增能力发现合同保持 `capabilities` 为字符串列表，详情按同名键读取：

- `product_parse`：`billing.status=not_billable/credits=0` 表示解析不扣 R 币。`url_policy=public_http`、`platforms=["*"]` 表示公开 HTTP(S) 商品链接均可提交尝试，`availability=determined_by_parse_result` 表示以实际来源响应判断可用性；不是保证所有网站都能抓取成功。旧清单列出的平台、域名或路径仅作为历史提示，不用它提前拒绝 Lazada、Amazon、短链或其他商城；权限、URL安全与缺失事实检查仍保留。
- `video_generation`：`specifications` 每项含 `model/resolution/sku_id/durations`，与同级 `ratios/generate_audio/camera_fixed/required_params` 组合出完整 `params`。只使用清单实际包含的组合和整数秒数。规格取执行能力与当前目录、业务倍率的交集，不把目录中的其他 SKU 当成支持值。
- 视频 `billing.preparation_credits=0/quote_required=true` 表示准备不扣 R 币、生成仍须取得正式 Quote。能力发现不创建 Quote、不返回本次正式价格，也不证明余额足够。Key 额度与费用授权仍分别校验。

当前先提供原商品图直接成片所需的解析与视频能力。没有图片能力详情时不补图；官方帮助入口尚未交付时仍从用户已知账户页配置，不拼造 URL。

视频准备的 `params` 必须显式含六项，不能只写时长或靠后端默认补齐：

```json
{
  "model": "fast",
  "resolution": "720p",
  "ratio": "9:16",
  "duration": 15,
  "generate_audio": true,
  "camera_fixed": false
}
```

这是结构示例，**只有实际部署明确开放这一组合时才可用**。代码可识别 mini/fast/standard；对应用户档位分别是轻量模型/标准模型/专业模型，用户选项与接口映射按[模型选档与接口映射](creative-guidance.md)，MCP传参保持原值。视频时长整数 4–15 秒，比率 16:9 或 9:16，分辨率受模型组合限制。不能从代码识别范围推断已售规格。

图片 `params` 只接受 `{"sku_id":"服务明确开放的图片SKU"}`；不传 model/size/quality/resolution，模型调用规格由可信目录确定。八个工具当前没有完整的公开图片目录查询能力，缺 SKU 时暂停补图，不套用历史测试 SKU 或价格。

### 任务结果

普通成功响应为 `{code:0,message,data}`。连接器附加 `http_status`，MCP 还可能通过 `isError` 表达错误；不以 HTTP 200 单独认定业务成功。FastAPI 错误可为 `detail: "ERROR_CODE"` 或 `detail: {error_code, message}`，也可能是参数校验列表；结合 HTTP、code、error_code 和 detail 判断，不假定错误总在顶层。

- 解析：读取 `result` 的商品事实、来源、时效、变体、缺失和警告。部署版本 `b7bb554cb` 的统一查询 `image_refs` 项可含 `{asset_ref,index,preview_url}`；预览经本人素材归属和版本校验后短期签名，签名暂不可用时可省略。使用实际返回的预览查看图片，不能把不透明引用送进图片查看器。链接到期重新查询原任务，不重新生成。创建受理响应若为空，需后续查询；缺预览时停在视觉核验阶段。
- 准备：初始可以是 `queued`，统一查询使用 `pending/running/completed/failed/unknown`。`completed` 时读取 `result.preparation_id/quote_id/input_fingerprint/quote_expires_at`、`billing.quoted_credits`。Quote 到期时间为 UTC；未完成时不使用残留 Quote。缺指纹/到期/金额说明不可核验，不猜默认值。
- 图片：`completed` 且存储/付款证明就绪后，`result.asset_ref/preview_url` 可用。缺引用、预览或仍需账务/存储恢复时继续查询原任务，不能认为视频素材已就绪。
- 视频：当前 `result.video_url` 是重新签发的交付链接；只展示实际返回字段，不虚构独立 download_url、尺寸或时长。实际媒体信息可由宿主在获准情况下查看核对。
- 不等待不存在的 `succeeded`。业务 completed/failed 后 `billing.final=false` 仍需查账务恢复；`unknown` 不等于失败，不换身份重提。

## 幂等、续接与费用

创建、每次准备、每次图片生成、每次视频生成各有自己的请求身份。同一意图重传保留**原键和原始完整参数**；同键换参数可能冲突。Key 轮换不改变购买身份。已知任务先查任务；准备已完成、报价过期而提交结果未知时，仍先查原生成任务/创作，不能先新开准备和购买。

`max_credits` 为整数且非负，表示这一次提交愿付的上限，不能超过用户授权；不是让 Agent 计算实际价格。服务端按有效 Quote、Key 策略与可用余额受理。不要向外暴露或尝试执行 freeze/settle/release。

| billing 字段 | 含义 |
| --- | --- |
| `quoted_credits` | 本次正式报价；准备未就绪可为空；不是消费 |
| `frozen_credits` | 当前仍冻结的 R 币；不是原始预占总额或消费 |
| `consumed_credits` | 已结算真实消费 |
| `released_credits` | 已释放并恢复可用的部分 |
| `expired_credits` | 释放时因到期未恢复可用的部分 |
| `status` / `final` | 账务阶段与是否终结，独立于业务结果 |

未收费任务为 `not_billable`；可见状态还包括 pending/frozen/settled/released/partially_settled/reconciling。准备有 Quote 不代表已消费。creation 按支付单汇总，不能再把各 task 金额加到 creation 金额上重复计数。账户余额独立查询，不能用初始余额减本创作费用推算。

## 错误分流

| 事实 | 应做什么 |
| --- | --- |
| 无连接/401/Key 失效或撤销 | 保留创作，引导官方Key设置；用户可选择Agent代配、临时网页或终端命令。MCP代配仍须宿主有对应凭据设置能力，不将Key塞进八个业务工具参数 |
| 403/scope 不足 | 引导本人管理页调整；缺余额权限不显示余额或差额 |
| `INVALID_PRODUCT_URL` / `UNSUPPORTED_PRODUCT_URL` / `PRODUCT_PARSE_NOT_ENABLED` | 按本次实际响应说明链接安全/格式或服务不可用，不从平台名称预先断言失败；保留原链接与需求。解析失败可请用户提供商品信息和原图，不绕过官方入口、不伪造事实 |
| `FULL_VIDEO_PARAMS_REQUIRED` / `IMAGE_SPEC_NOT_QUOTABLE` | 依据可信能力补齐输入或暂停，不猜 SKU；修改输入须重新准备 |
| `QUOTE_EXPIRED` / `QUOTE_INPUT_MISMATCH` / `QUOTE_ALREADY_USED` | 先查原请求受理事实；确认新操作后按准备和授权规则处理 |
| 余额不足 | 用服务端已授权披露的差额，引导个人充值；不能保证充值套餐恰好等于差额 |
| 429 / 503 | 使用 `retry_after_seconds` 或服务建议等待；不密集重试，写请求不由连接器自动重试 |
| `UPSTREAM_UNAVAILABLE` / 网络中断 / unknown | 保留原身份查询和恢复；不能凭一次超时认定未受理 |
| `BILLING_UNAVAILABLE` / 完成但无可交付媒体 | 保留原任务，报告查询/恢复问题，不显示零费用或重生成 |

## 当前发布边界

2026-10-23 新实现按当前 Key、功能开关、已发布目录与业务倍率提供解析/视频能力详情；旧部署仍可能返回空清单。**只有本次实际响应包含所需能力及完整详情，才能开始新解析/准备/生成；空清单仍保持关闭。** 商品图继续通过统一任务查询的短期预览实际查看。图片能力与官方帮助入口尚未提供时不猜 SKU、价格或 URL。不同宿主的图片查看、视频预览和凭据配置需分别验证，不把离线包校验说成已上架。

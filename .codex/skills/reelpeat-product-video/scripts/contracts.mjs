import { fail, noCredentials } from './local-files.mjs';

export function text(value, field, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail('INVALID_INPUT', '字段' + field + '需要非空字符串且不能超长。');
  return value;
}
export function resource(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    fail('INVALID_RESOURCE', '资源ID格式无效。');
  return value;
}
export function fields(input, allowed) {
  noCredentials(input);
  if (Object.keys(input).some(key => !allowed.includes(key)))
    fail('UNEXPECTED_FIELD', '参数包含未支持字段，请查看--help和客户端合同。');
}
export function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))) fail('INVALID_TIME', '事实时刻必须使用带时区的RFC3339字符串。');
  return Date.parse(value);
}

export function validateResolve(input, context) {
  fields(input, ['product_url', 'target_market']);
  const capability = context.capability_details?.product_parse;
  if (!context.capabilities?.includes('product_parse') || capability?.billing?.status !== 'not_billable' ||
      capability.billing.credits !== 0 || !capability.platforms?.includes('tiktok_shop'))
    fail('CAPABILITY_UNAVAILABLE', '当前身份未开放具有明确免费政策的商品解析。');
  let url;
  try { url = new URL(input.product_url); } catch { fail('INVALID_PRODUCT_URL', '请输入有效商品链接。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !capability.url_hosts?.includes(url.hostname) || typeof capability.url_path_pattern !== 'string' ||
      !new RegExp(capability.url_path_pattern).test(url.pathname))
    fail('UNSUPPORTED_PRODUCT_URL', '商品链接不在当前已开放的平台和路径范围。');
  text(input.target_market, 'target_market', 100);
}

export function validatePrepare(input, context) {
  fields(input, ['creation_id', 'kind', 'prompt', 'asset_refs', 'params', 'visual_review', 'creative_summary']);
  resource(input.creation_id); text(input.prompt, 'prompt');
  if (!['video', 'image'].includes(input.kind)) fail('INVALID_KIND', 'kind须为image或video。');
  const refs = input.asset_refs;
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 9 || new Set(refs).size !== refs.length ||
      refs.some(ref => typeof ref !== 'string' || !ref || /^(https?:|data:|\/|[A-Za-z]:\\)/.test(ref)))
    fail('INVALID_ASSET_REFS', '需要1～9个不重复的服务端素材引用，不能传URL或本地路径。');
  const review = input.visual_review;
  if (!review || !Array.isArray(review.checked_asset_refs) ||
      JSON.stringify(review.checked_asset_refs) !== JSON.stringify(refs) || !review.source)
    fail('VISUAL_REVIEW_REQUIRED', '宿主须实际看图并记录同序checked_asset_refs与核验依据source。');
  const cap = context.capability_details?.[input.kind + '_generation'];
  if (!context.capabilities?.includes(input.kind + '_generation') || !cap ||
      cap.billing?.preparation_credits !== 0 || cap.billing.quote_required !== true)
    fail('CAPABILITY_UNAVAILABLE', '当前没有该阶段完整的能力与准备收费合同。');
  if (input.kind === 'image') {
    // 中文注释：当前服务未公布图片目录，不猜测未来目录结构或套用历史SKU。
    fail('IMAGE_CATALOG_UNAVAILABLE', '当前公开图片目录合同未就绪；可查询历史图片或使用商品原图。');
  }
  const params = input.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail('INVALID_PARAMS', 'params须为对象。');
  const required = ['model', 'resolution', 'ratio', 'duration', 'generate_audio', 'camera_fixed'];
  if (!required.every(key => Object.hasOwn(params, key)) || Object.keys(params).length !== required.length)
    fail('FULL_VIDEO_PARAMS_REQUIRED', '视频规格必须显式包含六个受支持字段。');
  const specification = cap.specifications?.find(item =>
    item.model === params.model && item.resolution === params.resolution &&
    Number.isInteger(params.duration) && item.durations?.includes(params.duration));
  if (!specification || !cap.ratios?.includes(params.ratio) ||
      !cap.generate_audio?.includes(params.generate_audio) || !cap.camera_fixed?.includes(params.camera_fixed))
    fail('UNSUPPORTED_SPECIFICATION', '所选规格不在本次正式能力清单中。');
}

// 中文注释：授权绑定当前账号和已准备输入，不用永久approved标志代替宿主确认。
export function validateAuthorization(authorization, state, context, prep, now) {
  fields(authorization, ['account_id', 'creation_id', 'preparation_id', 'quote_id', 'input_fingerprint',
    'max_credits', 'count', 'source', 'authorized_at']);
  const quote = prep.result;
  if (prep.status !== 'completed' || !quote?.quote_id || !quote.input_fingerprint ||
      quote.preparation_id !== state.preparation_id || quote.quote_id !== state.quote?.quote_id ||
      quote.input_fingerprint !== state.quote?.input_fingerprint)
    fail('QUOTE_MISMATCH', '当前准备与原报价不匹配，请重新核查原任务。');
  if (instant(quote.quote_expires_at) <= now) fail('QUOTE_EXPIRED', '报价已过期；先核查受理事实，再按Skill重新准备与授权。');
  for (const key of ['account_id', 'creation_id', 'preparation_id'])
    if (authorization[key] !== state[key]) fail('AUTHORIZATION_MISMATCH', '授权账号或准备身份不匹配。');
  for (const key of ['quote_id', 'input_fingerprint'])
    if (authorization[key] !== quote[key]) fail('AUTHORIZATION_MISMATCH', '授权报价或输入指纹不匹配。');
  const price = prep.billing?.quoted_credits;
  if (!Number.isInteger(price) || price < 0 || authorization.count !== 1 ||
      !Number.isInteger(authorization.max_credits) || authorization.max_credits < price ||
      (context.max_credits_per_generation != null && price > context.max_credits_per_generation))
    fail('AMOUNT_NOT_AUTHORIZED', '正式金额超过授权或Key上限，或缺少单次明确授权。');
  text(authorization.source, 'source', 2000);
  if (instant(authorization.authorized_at) > now + 60000) fail('INVALID_AUTHORIZATION_TIME', '授权时间不能在未来。');
  return price;
}

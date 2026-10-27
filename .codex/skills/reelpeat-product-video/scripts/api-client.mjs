const BASE = '/api/open/v1';
// 中文注释：仅未指定地址时使用默认网关，显式地址仍须经过相同的安全校验。
export const DEFAULT_API_BASE = 'https://www.realpeat.com/';
const id = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('无效的资源 ID');
  return encodeURIComponent(value);
};

// 只允许目标合同中的八种请求，拒绝额外字段进入对客 API。
export const operations = Object.freeze({
  reelpeat_get_context: { method: 'GET', path: () => `${BASE}/context`, fields: [] },
  reelpeat_get_balance: { method: 'GET', path: () => `${BASE}/account/balance`, fields: [] },
  reelpeat_resolve_product: { method: 'POST', path: () => `${BASE}/products/resolve`, fields: ['product_url', 'target_market'], headers: ['idempotency_key'] },
  reelpeat_prepare_generation: { method: 'POST', pathFields: ['creation_id'], path: ({ creation_id }) => `${BASE}/creations/${id(creation_id)}/preparations`, fields: ['kind', 'prompt', 'asset_refs', 'params'], headers: ['idempotency_key'] },
  reelpeat_generate_image: { method: 'POST', pathFields: ['creation_id'], path: ({ creation_id }) => `${BASE}/creations/${id(creation_id)}/images`, fields: ['preparation_id', 'quote_id', 'max_credits'], headers: ['idempotency_key'] },
  reelpeat_generate_video: { method: 'POST', pathFields: ['creation_id'], path: ({ creation_id }) => `${BASE}/creations/${id(creation_id)}/videos`, fields: ['preparation_id', 'quote_id', 'max_credits'], headers: ['idempotency_key'] },
  reelpeat_get_task: { method: 'GET', pathFields: ['task_id'], path: ({ task_id }) => `${BASE}/tasks/${id(task_id)}`, fields: [] },
  reelpeat_get_creation: { method: 'GET', pathFields: ['creation_id'], path: ({ creation_id }) => `${BASE}/creations/${id(creation_id)}`, fields: [] },
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function retryDelay(value, attempt) {
  const seconds = Number(value);
  const delay = value && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
    : value && !Number.isNaN(Date.parse(value)) ? Date.parse(value) - Date.now()
    : 150 * (attempt + 1);
  // 中文注释：服务端限流窗口可能为一分钟，不能截成一秒后提前重试。
  // 中文注释：仅本地无响应头的退避使用短等待；有效 Retry-After 保留原等待时长。
  return Math.max(0, delay);
}

function retryMetadata(response) {
  // 中文注释：只传递有效的服务端等待提示；写请求不自动重试，由宿主决定何时查询原任务。
  if (response.status !== 429 && response.status !== 503) return {};
  const value = response.headers?.get('retry-after');
  if (!value || !value.trim()) return {};
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return { retry_after_seconds: numeric };
  const instant = Date.parse(value);
  return Number.isFinite(instant)
    ? { retry_after_seconds: Math.max(0, Math.ceil((instant - Date.now()) / 1000)) } : {};
}

export function normalizeApiBase(baseUrl = DEFAULT_API_BASE) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && !(url.hostname === '127.0.0.1' && url.protocol === 'http:')) throw new Error('API 地址必须使用 HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不可包含凭据或参数');
  // 中文注释：明确的工作台页面使用同站API根地址，避免把页面路径拼进接口；其他部署前缀保留。
  if (/^\/vorder\/app\/?$/.test(url.pathname)) url.pathname = '/';
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

export function createAdapter({ baseUrl, fetchImpl = fetch, sleep = pause }) {
  const prefix = normalizeApiBase(baseUrl);

  return async (name, args, bearer, { deadline = Infinity } = {}) => {
    const op = operations[name];
    if (!op) throw new Error('未知工具');
    if (typeof bearer !== 'string' || !/^Bearer [^\s]+$/.test(bearer)) throw new Error('缺少有效连接凭据');
    const input = args ?? {};
    const allowed = new Set([...op.fields, ...(op.pathFields ?? []), ...(op.headers ?? [])]);
    for (const field of Object.keys(input)) if (!allowed.has(field)) throw new Error('请求包含未支持字段');
    if (op.method === 'POST' && (typeof input.idempotency_key !== 'string' || !input.idempotency_key.trim() || input.idempotency_key.length > 256)) throw new Error('缺少有效幂等键');
    const endpoint = new URL(op.path(input).replace(/^\//, ''), prefix);
    const body = Object.fromEntries(op.fields.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
    for (let attempt = 0; ; attempt++) {
      // 中文注释：直接客户端的等待预算约束重试和HTTP，MCP未传预算时保持原行为。
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { http_status: null, error_code: 'CLIENT_WAIT_EXPIRED' };
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: op.method,
          headers: { Authorization: bearer, ...(op.method === 'POST' ? { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotency_key } : {}) },
          ...(op.method === 'POST' ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(Math.max(1, Math.min(10000, Math.floor(remaining)))),
          redirect: 'error',
        });
      } catch {
        // 网络异常后的写请求受理状态未知，绝不生成新请求或新幂等身份。
        return { http_status: null, error_code: 'UPSTREAM_UNAVAILABLE', message: '请求结果未知；请使用原任务或原幂等键核查' };
      }
      if (op.method === 'GET' && (response.status === 429 || response.status === 503) && attempt < 2) {
        const delay = retryDelay(response.headers.get('retry-after'), attempt);
        if (delay + 1 < deadline - Date.now()) {
          await sleep(delay);
          continue;
        }
      }
      let payload;
      try { payload = await response.json(); } catch { return { http_status: response.status, error_code: 'UPSTREAM_INVALID_RESPONSE', message: '服务响应不可读取' }; }
      // 原样传递公开 DTO，HTTP 状态另列；不重算任务状态、账务或错误。
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { http_status: response.status, error_code: 'UPSTREAM_INVALID_RESPONSE', message: '服务响应格式无效' };
      // 中文注释：原始detail/账务保持不变，HTTP退避信息单独附加，避免限流提示在连接器中丢失。
      return { ...payload, http_status: response.status, ...retryMetadata(response) };
    }
  };
}

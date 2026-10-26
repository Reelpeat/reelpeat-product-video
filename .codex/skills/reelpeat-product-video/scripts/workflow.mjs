import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createAdapter } from './api-client.mjs';
import { atomicJSON, readJSON, regularPath, privateDirectory, redact, noCredentials, fail, ClientError } from './local-files.mjs';
import { loadCredentials, verifyIdentity } from './credentials.mjs';
import { validateResolve, validatePrepare, validateAuthorization, resource, fields } from './contracts.mjs';

const names = { resolve: 'reelpeat_resolve_product', prepare: 'reelpeat_prepare_generation',
  'generate-image': 'reelpeat_generate_image', 'generate-video': 'reelpeat_generate_video',
  context: 'reelpeat_get_context', balance: 'reelpeat_get_balance',
  task: 'reelpeat_get_task', creation: 'reelpeat_get_creation' };
const codes = { pending: 2, delivery_failed: 3, error: 1, setup_required: 1 };
export const exitCode = value => codes[value.result_type] || 0;

export function envelope(operation, extra = {}) {
  return { schema_version: 1, operation, result_type: 'accepted', account_id: null,
    creation_id: null, task_id: null, task_status: null, billing: null,
    assets: [], recovery_file: null, next_action: null, ...extra };
}

function apiData(response, secret = '') {
  if (response.http_status == null || response.http_status >= 400 || response.code !== 0 ||
      !response.data || typeof response.data !== 'object') {
    const candidate = response.detail?.error_code || response.error_code ||
      (typeof response.detail === 'string' ? response.detail : null);
    const code = typeof candidate === 'string' && /^[A-Z0-9_]{1,80}$/.test(candidate) &&
      !(secret && candidate.includes(secret))
      ? candidate : 'API_REQUEST_FAILED';
    const error = new ClientError(code, '接口未成功，请保留原请求身份，核对权限、网络和正式状态。');
    error.retry_after_seconds = response.retry_after_seconds;
    error.http_status = response.http_status;
    throw error;
  }
  return response.data;
}

export async function session(options, dependencies = {}) {
  const credentials = await loadCredentials(options);
  const context = await verifyIdentity(credentials, dependencies);
  const call = createAdapter({ baseUrl: credentials.api_base_url, fetchImpl: dependencies.fetchImpl || fetch });
  return { credentials, context, call, now: dependencies.now || Date.now,
    sleep: dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))),
    async query(operation, input = {}, requestOptions) {
      return apiData(await call(names[operation], input, 'Bearer ' + credentials.api_key,
        requestOptions || { deadline: Date.now() + 10000 }), credentials.api_key);
    } };
}

export async function saveRun(state, file, active) {
  await atomicJSON(file, redact(state, [active.credentials.api_key]));
}

async function createRun(operation, input, options, active) {
  const work = path.resolve(options['work-dir'] || process.cwd());
  await regularPath(work, { directory: true });
  const root = path.resolve(work, options['output-dir'] || '.reelpeat-local/runs');
  await privateDirectory(root);
  const runId = randomUUID();
  const directory = path.join(root, runId);
  await privateDirectory(directory);
  const file = path.join(directory, 'state.json');
  const state = { schema_version: 1, run_id: runId, operation,
    account_id: String(active.context.account_id), api_base_url: active.credentials.api_base_url,
    work_dir: work, creation_id: input.creation_id || null, task_id: null, preparation_id: null,
    requests: {}, created_at: new Date(active.now()).toISOString(), assets: [], content_review: 'not_checked' };
  await saveRun(state, file, active);
  return { state, file };
}

export async function loadRun(file, active) {
  const state = await readJSON(file, { privateMode: true });
  noCredentials(state);
  if (state.schema_version !== 1 || state.account_id !== String(active.context.account_id) ||
      state.api_base_url !== active.credentials.api_base_url)
    fail('RUN_IDENTITY_MISMATCH', '恢复记录与当前个人账号或API地址不同，停止沿用素材和授权。');
  if (!names[state.operation] || !state.requests || !state.run_id)
    fail('INVALID_RECOVERY', '恢复记录格式无效。');
  return state;
}

function observe(state, task, now) {
  state.task_id = task.task_id || task.preparation_id || state.task_id;
  state.creation_id = task.creation_id || state.creation_id;
  if (state.operation === 'prepare') state.preparation_id = state.task_id;
  state.task_status = task.status || null;
  state.billing = task.billing || null;
  state.result = redact(task.result || {});
  state.observed_at = new Date(now).toISOString();
  state.next_poll_at = new Date(now + Math.max(0, task.poll_after_seconds ?? 5) * 1000).toISOString();
  if (state.operation === 'prepare' && task.status === 'completed') {
    const result = task.result || {};
    if (result.preparation_id && result.quote_id && result.input_fingerprint && result.quote_expires_at &&
        Number.isInteger(task.billing?.quoted_credits))
      state.quote = { ...result, quoted_credits: task.billing.quoted_credits };
  }
}

function projection(state, file, operation = state.operation) {
  const resultType = state.task_status === 'failed' ? 'error'
    : state.operation === 'prepare' && state.task_status === 'completed' && state.quote ? 'quote_ready'
      : ['pending', 'queued', 'running', 'unknown'].includes(state.task_status) || !state.task_status ||
        (state.operation === 'prepare' && !state.quote) ? 'pending' : 'accepted';
  return envelope(operation, { result_type: resultType, account_id: state.account_id,
    creation_id: state.creation_id, task_id: state.task_id, task_status: state.task_status,
    billing: state.billing, recovery_file: file, assets: state.assets || [],
    data: state.result || {}, quote: state.quote || null, content_review: state.content_review,
    next_action: resultType === 'quote_ready' ? { operation: 'request-user-authorization', recovery_file: file }
      : { operation: state.task_status === 'completed' && resultType !== 'pending' ? 'download' : 'resume', recovery_file: file } });
}

async function poll(state, file, active, seconds) {
  const budget = seconds * 1000;
  const started = performance.now();
  // 中文注释：准备受理可能已completed但尚无报价正文，仍须查询原准备取得可核验Quote。
  while (state.task_id && (!['completed', 'failed'].includes(state.task_status) ||
    (state.operation === 'prepare' && state.task_status === 'completed' && !state.quote))) {
    const remaining = budget - (performance.now() - started);
    const delay = Math.max(0, Date.parse(state.next_poll_at || '') - active.now()) || 0;
    if (remaining <= 0 || delay >= remaining) break;
    if (delay) await active.sleep(delay);
    try {
      const task = await active.query('task', { task_id: state.task_id },
        { deadline: Date.now() + Math.max(1, budget - (performance.now() - started)) });
      observe(state, task, active.now());
    } catch (error) {
      if (![429, 503, null].includes(error.http_status)) throw error;
      state.last_query_error = error.code;
      state.next_poll_at = new Date(active.now() + Math.max(5, error.retry_after_seconds || 5) * 1000).toISOString();
    }
    await saveRun(state, file, active);
  }
  return projection(state, file);
}

async function submit(state, file, operation, input, active, seconds) {
  state.operation = operation;
  state.requests[operation] = input;
  state.attempted_at = new Date(active.now()).toISOString();
  state.submission_outcome = 'unknown';
  // 中文注释：先持久原键和完整输入，任何网络/进程中断后都不能生成新身份。
  await saveRun(state, file, active);
  const response = await active.call(names[operation], input, 'Bearer ' + active.credentials.api_key);
  if (response.http_status == null || response.http_status >= 500) return projection(state, file);
  let task;
  try { task = apiData(response, active.credentials.api_key); }
  catch (error) {
    state.submission_outcome = response.http_status >= 400 && response.http_status < 500 ? 'rejected' : 'unknown';
    state.submission_error = error.code;
    await saveRun(state, file, active);
    if (state.submission_outcome === 'unknown') return projection(state, file);
    error.recovery_file = file;
    throw error;
  }
  if (!(task.task_id || task.preparation_id)) return projection(state, file);
  state.submission_outcome = 'accepted';
  observe(state, task, active.now());
  await saveRun(state, file, active);
  return poll(state, file, active, seconds);
}

export async function startOperation(operation, input, options, active) {
  noCredentials(input);
  if (JSON.stringify(input).includes(active.credentials.api_key))
    fail('CREDENTIAL_IN_INPUT', '业务输入包含凭据，禁止发送或保存。');
  if (JSON.stringify(redact(input)) !== JSON.stringify(input))
    fail('SENSITIVE_INPUT', '业务输入不能包含凭据字段或临时签名URL；请使用已核验素材引用和非秘密说明。');
  if (operation === 'resolve') validateResolve(input, active.context);
  else validatePrepare(input, active.context);
  const { state, file } = await createRun(operation, input, options, active);
  const request = operation === 'prepare'
    ? Object.fromEntries(['creation_id', 'kind', 'prompt', 'asset_refs', 'params'].map(key => [key, input[key]]))
    : { ...input };
  request.idempotency_key = randomUUID();
  state.visual_review = input.visual_review || null;
  state.creative_summary = input.creative_summary || null;
  return submit(state, file, operation, request, active, Number(options['wait-seconds'] ?? 20));
}

export async function resumeOperation(file, options, active) {
  const state = await loadRun(file, active);
  if (state.task_id) {
    // 中文注释：已终结的原任务也实时查账，不将恢复文件当结果缓存。
    if (['completed', 'failed'].includes(state.task_status)) {
      observe(state, await active.query('task', { task_id: state.task_id }), active.now());
      await saveRun(state, file, active);
    }
    return poll(state, file, active, Number(options['wait-seconds'] ?? 20));
  }
  if (state.submission_outcome === 'rejected') fail(state.submission_error || 'REQUEST_REJECTED', '原提交明确被拒，不自动重新购买。');
  const input = state.requests[state.operation];
  if (!input?.idempotency_key) fail('RECOVERY_REQUEST_MISSING', '原请求身份缺失，不能安全重提。');
  if (state.operation.startsWith('generate-')) {
    const authorization = state.consumption_authorization;
    if (!authorization || authorization.account_id !== state.account_id ||
        authorization.quote_id !== input.quote_id || authorization.count !== 1 ||
        !Number.isInteger(input.max_credits) || input.max_credits > authorization.max_credits ||
        !authorization.source || authorization.input_fingerprint !== state.quote?.input_fingerprint)
      fail('AUTHORIZATION_REQUIRED', '恢复收费请求仍须有匹配的原始明确授权。');
  }
  if (state.creation_id) await active.query('creation', { creation_id: state.creation_id });
  // 中文注释：没有可关联句柄时仅重放原键原输入，依赖服务端幂等恢复原受理。
  return submit(state, file, state.operation, input, active, Number(options['wait-seconds'] ?? 20));
}

// 中文注释：历史任务只建立本地查询记录，不重新解析、准备或收费提交。
export async function adoptTask(taskId, options, active) {
  resource(taskId);
  const task = await active.query('task', { task_id: taskId });
  const { state, file } = await createRun('task', { creation_id: task.creation_id }, options, active);
  observe(state, task, active.now());
  await saveRun(state, file, active);
  return poll(state, file, active, Number(options['wait-seconds'] ?? 20));
}

export async function boundedOutput(result, options = {}) {
  if (Buffer.byteLength(JSON.stringify(result.data || {})) <= 16000) return result;
  const directory = path.resolve(options['work-dir'] || process.cwd(), '.reelpeat-local', 'responses');
  await privateDirectory(directory);
  const file = path.join(directory, randomUUID() + '.json');
  await atomicJSON(file, result.data);
  return { ...result, data: { stored: true }, data_file: file };
}

export async function generate(operation, file, authorizationFile, options, active) {
  const state = await loadRun(file, active);
  if (state.requests['generate-image'] || state.requests['generate-video'])
    return resumeOperation(file, options, active);
  if (state.operation !== 'prepare' || !state.preparation_id ||
      state.requests.prepare?.kind !== (operation === 'generate-image' ? 'image' : 'video'))
    fail('PREPARATION_REQUIRED', '需要本客户端保存的匹配准备记录。');
  if (!authorizationFile) fail('AUTHORIZATION_REQUIRED', '请先展示正式报价，取得用户明确授权并提供授权记录。');
  const { idempotency_key: _originalKey, ...preparedInput } = state.requests.prepare;
  validatePrepare({ ...preparedInput, visual_review: state.visual_review }, active.context);
  const authorization = await readJSON(authorizationFile);
  const prep = await active.query('task', { task_id: state.preparation_id });
  const price = validateAuthorization(authorization, state, active.context, prep, active.now());
  const balance = await active.query('balance');
  if (balance.available_credits < price) fail('INSUFFICIENT_BALANCE', '当前余额不足，停止新消费并保留原准备。');
  // 中文注释：消费授权是非秘密证据，不能与HTTP Authorization凭据字段混用。
  state.consumption_authorization = authorization;
  state.task_id = null; state.task_status = null; state.billing = null;
  return submit(state, file, operation, { creation_id: state.creation_id,
    preparation_id: state.preparation_id, quote_id: state.quote.quote_id,
    // 中文注释：同一准备记录并发或崩溃续接仍使用同一购买身份，不能生成第二笔支付。
    idempotency_key: 'reelpeat-' + state.run_id + '-' + operation, max_credits: price }, active,
  Number(options['wait-seconds'] ?? 20));
}

export async function readOperation(operation, input, active) {
  fields(input, operation === 'task' ? ['task_id'] : operation === 'creation' ? ['creation_id'] : []);
  if (operation === 'task') resource(input.task_id);
  if (operation === 'creation') resource(input.creation_id);
  const data = operation === 'context' ? active.context : await active.query(operation, input);
  return envelope(operation, { account_id: String(active.context.account_id), data,
    task_id: data.task_id || null, creation_id: data.creation_id || null,
    task_status: data.status || null, billing: data.billing || null });
}

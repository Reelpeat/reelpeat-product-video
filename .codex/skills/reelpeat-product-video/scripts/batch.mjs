import path from 'node:path';
import { open, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { atomicJSON, readJSON, privateDirectory, protectPrivate, noCredentials, redact, fail } from './local-files.mjs';
import { fields, text, instant, validateResolve, validatePrepare, validateAuthorization } from './contracts.mjs';

// 中文注释：排序对象键后比较完整输入；重新报价可以换Quote，不能悄悄换剧本或参考图。
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const encoded = value => JSON.stringify(canonical(value));
const digest = value => createHash('sha256').update(encoded(value)).digest('hex');
const productionInput = state => Object.fromEntries(['kind', 'prompt', 'asset_refs', 'params']
  .map(key => [key, state.requests.prepare?.[key]]));
const credits = value => Number.isSafeInteger(value) && value >= 0;

async function boundRun(file, active) {
  const state = await readJSON(file, { privateMode: true });
  noCredentials(state);
  if (state.account_id !== String(active.context.account_id) || state.api_base_url !== active.credentials.api_base_url)
    fail('BATCH_IDENTITY_MISMATCH', '批次或行记录与当前账号/API不同。');
  return state;
}

async function approvedRow(row, input, options, active) {
  fields(row, ['row_id', 'resolve_file', 'variant', 'max_credits', 'prepare_file']);
  text(row.row_id, 'row_id', 200); text(row.variant, 'variant', 300);
  if (!credits(row.max_credits)) fail('INVALID_BATCH_LIMIT', '每行必须有明确整数金额上限。');
  text(row.resolve_file, 'resolve_file');
  const resolve = await boundRun(path.resolve(options['work-dir'] || process.cwd(), row.resolve_file), active);
  if (resolve.operation !== 'resolve' || resolve.task_status !== 'completed' || !resolve.creation_id)
    fail('BATCH_RESOLVE_REQUIRED', '批次须先完成每行免费解析，核对确定商品与变体。');
  const { idempotency_key: _resolveKey, ...resolvedInput } = resolve.requests.resolve || {};
  validateResolve(resolvedInput, active.context);
  const result = { row_id: row.row_id, variant: row.variant, max_credits: row.max_credits,
    resolve_file: path.resolve(options['work-dir'] || process.cwd(), row.resolve_file),
    creation_id: resolve.creation_id, product_url: resolve.requests.resolve.product_url,
    target_market: resolve.requests.resolve.target_market,
    original_refs: (resolve.result?.image_refs || []).map(item => item.asset_ref) };
  if (input.mode === 'prepared') {
    text(row.prepare_file, 'prepare_file');
    const state = await boundRun(path.resolve(options['work-dir'] || process.cwd(), row.prepare_file), active);
    if (state.operation !== 'prepare' || state.task_status !== 'completed' || !state.quote ||
        state.creation_id !== result.creation_id || state.requests.prepare?.kind !== 'video' ||
        !credits(state.quote.quoted_credits) || state.quote.quoted_credits > row.max_credits)
      fail('BATCH_PREPARATION_REQUIRED', '整批确认须有同一商品的正式视频报价且不超过行上限。');
    const { idempotency_key: _key, ...prepared } = state.requests.prepare;
    validatePrepare({ ...prepared, visual_review: state.visual_review }, active.context);
    result.input = productionInput(state);
    result.prepare_file = path.resolve(options['work-dir'] || process.cwd(), row.prepare_file);
  } else if (row.prepare_file) fail('INVALID_BATCH_ROW', '规则授权不接收固定prepare_file，请使用prepared模式。');
  return result;
}

// 中文注释：只在宿主核验人类对建议清单的明确确认后创建；文件本身不能证明同意。
export async function initializeBatch(input, options, active) {
  fields(input, ['mode', 'table_source', 'rows', 'max_credits', 'source', 'authorized_at',
    'rules', 'on_failure', 'duplicate_policy']);
  if (!['prepared', 'rules'].includes(input.mode) || !Array.isArray(input.rows) || !input.rows.length ||
      !credits(input.max_credits) || !['stop', 'skip'].includes(input.on_failure) ||
      !['reject', 'keep'].includes(input.duplicate_policy))
    fail('INVALID_BATCH', '批次需要模式、固定行清单、预算、失败和重复行策略。');
  text(input.table_source, 'table_source', 1000); text(input.source, 'source', 1200);
  if (instant(input.authorized_at) > active.now() + 60000) fail('INVALID_AUTHORIZATION_TIME', '授权时刻不能在未来。');
  if (input.mode === 'rules') {
    if (!input.rules || typeof input.rules !== 'object') fail('INVALID_BATCH_RULES', '规则模式须明确规格与创意自主范围。');
    fields(input.rules, ['params', 'creative_scope']); text(input.rules.creative_scope, 'creative_scope', 3000);
    if (!input.rules.params || typeof input.rules.params !== 'object') fail('INVALID_BATCH_RULES', '规则模式缺少固定规格。');
  } else if (input.rules) fail('INVALID_BATCH_RULES', '固定输入模式不接受额外创意授权规则。');
  const rows = [];
  for (const row of input.rows) rows.push(await approvedRow(row, input, options, active));
  if (new Set(rows.map(row => row.row_id)).size !== rows.length ||
      new Set(rows.map(row => row.creation_id)).size !== rows.length)
    fail('DUPLICATE_BATCH_ROW', '每个视频须有独立稳定行标识和创作身份。');
  if (input.duplicate_policy !== 'keep' && new Set(rows.map(row => row.product_url)).size !== rows.length)
    fail('DUPLICATE_BATCH_PRODUCT', '存在重复链接；只有用户明确保留重复制作需求才使用keep。');
  const scope = { ...input, rows, account_id: String(active.context.account_id),
    api_base_url: active.credentials.api_base_url };
  noCredentials(scope);
  if (encoded(redact(scope, [active.credentials.api_key])) !== encoded(scope))
    fail('SENSITIVE_INPUT', '批次不能保存凭据、临时签名链接或带查询参数的表格地址，请使用非秘密来源说明。');
  const directory = path.resolve(options['work-dir'] || process.cwd(), '.reelpeat-local/batches', randomUUID());
  await privateDirectory(directory);
  const file = path.join(directory, 'batch.json');
  await atomicJSON(file, { schema_version: 1, batch_id: path.basename(directory), scope,
    scope_hash: digest(scope), attempts: {} }, { createOnly: true });
  return { batch_file: file, batch_id: path.basename(directory), row_count: rows.length,
    max_credits: scope.max_credits, scope_hash: digest(scope) };
}

export async function loadBatch(file, active) {
  const batch = await readJSON(file, { privateMode: true });
  noCredentials(batch);
  if (batch.schema_version !== 1 || !batch.scope || batch.scope_hash !== digest(batch.scope) ||
      !batch.attempts || !Array.isArray(batch.scope.rows))
    fail('INVALID_BATCH_RECORD', '批次清单无效或授权内容已改变，请保留原记录核对。');
  if (batch.scope.account_id !== String(active.context.account_id) ||
      batch.scope.api_base_url !== active.credentials.api_base_url)
    fail('BATCH_IDENTITY_MISMATCH', '批次与当前账号/API不同。');
  return batch;
}

// 中文注释：只按creation唯一账务计费，未终结时保留整笔报价额度，不把冻结误当可复用余额。
export async function batchStatus(file, active) {
  const batch = await loadBatch(file, active);
  const rows = []; let used = 0;
  for (const row of batch.scope.rows) {
    const attempt = Object.hasOwn(batch.attempts, row.row_id) ? batch.attempts[row.row_id] : null;
    if (!attempt) { rows.push({ row_id: row.row_id, status: 'not_submitted', held_credits: 0 }); continue; }
    const state = await boundRun(attempt.run_file, active);
    let status = 'unknown', final = false, consumed = null;
    if (state.task_id && state.requests['generate-video']) {
      const task = await active.query('task', { task_id: state.task_id });
      const creation = await active.query('creation', { creation_id: row.creation_id });
      if (task.creation_id !== row.creation_id || creation.creation_id !== row.creation_id)
        fail('BATCH_TASK_MISMATCH', '批次任务或账务归属不匹配。');
      status = task.status;
      const bill = creation.billing;
      final = ['completed', 'failed'].includes(status) && bill?.final === true &&
        credits(bill.consumed_credits) && bill.frozen_credits === 0;
      consumed = final ? bill.consumed_credits : null;
    }
    const held = final ? consumed : attempt.quoted_credits;
    if (!credits(held)) fail('BATCH_BILLING_UNKNOWN', '批次金额未知，停止新消费。');
    used += held;
    if (!Number.isSafeInteger(used)) fail('BATCH_BILLING_UNKNOWN', '批次汇总金额超出安全整数范围。');
    rows.push({ row_id: row.row_id, status, final, consumed_credits: consumed, held_credits: held });
  }
  return { batch_file: file, batch_id: batch.batch_id, mode: batch.scope.mode, rows,
    max_credits: batch.scope.max_credits, used_or_reserved_credits: used,
    remaining_credits: Math.max(0, batch.scope.max_credits - used) };
}

// 中文注释：同一批次只允许一个消费执行者；进程异常留下锁时先核查原任务，禁止自动抢锁。
export async function withBatchLock(file, action) {
  await readJSON(file, { privateMode: true });
  const lockFile = file + '.lock'; let handle;
  try { handle = await open(lockFile, 'wx', 0o600); }
  catch { fail('BATCH_BUSY', '批次正在执行或留下未核验锁；先确认原进程与原任务，不要另建批次绕过。'); }
  try {
    await protectPrivate(lockFile);
    await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    return await action();
  }
  finally { await handle.close(); await unlink(lockFile); }
}

// 中文注释：批次授权派生为原有单次Quote授权，保留输入指纹和金额门禁，不新增后端批量接口。
export async function reserveBatch(file, rowId, stateFile, state, prep, active) {
  const batch = await loadBatch(file, active), scope = batch.scope;
  const row = scope.rows.find(item => item.row_id === rowId);
  if (!row || row.creation_id !== state.creation_id || state.requests.prepare?.kind !== 'video')
    fail('BATCH_ROW_MISMATCH', '准备输入不属于本批次商品行。');
  if (scope.mode === 'prepared' && encoded(row.input) !== encoded(productionInput(state)))
    fail('BATCH_INPUT_CHANGED', '本行剧本、参考图或规格已改变，需要新授权。');
  if (scope.mode === 'rules' && (encoded(scope.rules.params) !== encoded(state.requests.prepare.params) ||
      state.requests.prepare.asset_refs.some(ref => !row.original_refs.includes(ref))))
    fail('BATCH_RULES_MISMATCH', '规格或原图引用超出批次规则；创意语义及变体仍须宿主核验。');
  const price = prep.billing?.quoted_credits;
  if (!credits(price) || price > row.max_credits) fail('BATCH_ROW_LIMIT', '正式报价超过本行授权上限。');
  const existing = Object.hasOwn(batch.attempts, rowId) ? batch.attempts[rowId] : null;
  if (existing && existing.run_file !== stateFile) fail('BATCH_ROW_ALREADY_ATTEMPTED', '本行已有购买身份，只能续接原state.json。');
  const status = await batchStatus(file, active);
  if (status.rows.some(item => item.row_id !== rowId && item.final === false) ||
      (scope.on_failure === 'stop' && status.rows.some(item => item.status === 'failed')))
    fail('BATCH_PAUSED', '原行仍未终结或失败策略要求停止，请先核查原任务和费用。');
  if (status.used_or_reserved_credits - (existing?.quoted_credits || 0) + price > scope.max_credits)
    fail('BATCH_BUDGET_EXCEEDED', '本次报价将超过批次总预算，停止新消费。');
  const authorization = { account_id: scope.account_id, creation_id: state.creation_id,
    preparation_id: state.preparation_id, quote_id: prep.result.quote_id,
    input_fingerprint: prep.result.input_fingerprint, max_credits: row.max_credits, count: 1,
    source: `批次${batch.batch_id}，行${rowId}：${scope.source}`, authorized_at: scope.authorized_at };
  validateAuthorization(authorization, state, active.context, prep, active.now());
  batch.attempts = { ...batch.attempts, [rowId]: { run_file: stateFile, quoted_credits: price } };
  await atomicJSON(file, batch);
  return authorization;
}

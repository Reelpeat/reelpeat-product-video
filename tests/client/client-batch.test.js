import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { clientModule, fixture, cli, params, preparationInput } from './client-fixture.mjs';
// 中文注释：通过共享夹具定位待测模块，导出后无需改写测试源码。
const { initializeBatch, batchStatus, loadBatch, withBatchLock } = await clientModule('batch.mjs');
const { session, startOperation, generate, resumeOperation } = await clientModule('workflow.mjs');
const { atomicJSON, readJSON } = await clientModule('local-files.mjs');

// 中文注释：所有批次、商品、授权与费用均为本机合成夹具，不使用真实Key或供应商。
async function scenario(t, fixtureOptions = {}, batchOptions = {}) {
  const f = await fixture(t, { multi: true, ...fixtureOptions }), active = await session(f.options);
  const rows = [], prepared = [];
  for (let index = 0; index < 2; index++) {
    const parsed = await startOperation('resolve', {
      product_url: 'https://shop.tiktok.com/view/product/172944438395053926' + index,
      target_market: 'MY' }, f.options, active);
    const ready = await startOperation('prepare', { ...preparationInput(), creation_id: parsed.creation_id }, f.options, active);
    prepared.push(ready);
    rows.push({ row_id: 'row-' + index, variant: '已核验黑色套装', max_credits: 8,
      resolve_file: parsed.recovery_file, prepare_file: ready.recovery_file });
  }
  const input = { mode: 'prepared', table_source: '合成商品表/固定两行', rows, max_credits: 16,
    source: '合成用户在完整建议后回复：按此批次执行；无真实授权。',
    authorized_at: new Date().toISOString(), on_failure: 'stop', duplicate_policy: 'reject', ...batchOptions };
  return { f, active, rows, prepared, input };
}
const rowOptions = (s, batch, index) => ({ ...s.f.options, 'batch-file': batch.batch_file, 'batch-row': 'row-' + index });
const buy = (s, batch, index) => generate('generate-video', s.prepared[index].recovery_file,
  null, rowOptions(s, batch, index), s.active);

test('一次批次确认：CLI初始化后两行独立生成、账务汇总及重复调用续接', async t => {
  const s = await scenario(t), file = path.join(s.f.root, 'confirmed.json');
  await atomicJSON(file, s.input);
  const created = await cli(['batch-init', '--config', s.f.config, '--work-dir', s.f.root, '--params-file', file]);
  assert.equal(created.code, 0);
  const batch = created.value.data;
  assert.equal((await loadBatch(batch.batch_file, s.active)).scope.rows[0].prepare_file, s.prepared[0].recovery_file);
  assert.equal((await batchStatus(batch.batch_file, s.active)).used_or_reserved_credits, 0);
  assert.equal((await buy(s, batch, 0)).task_status, 'completed');
  assert.equal((await buy(s, batch, 1)).task_status, 'completed');
  await buy(s, batch, 1);
  const status = await batchStatus(batch.batch_file, s.active);
  assert.equal(status.used_or_reserved_credits, 16);
  assert.equal(status.remaining_credits, 0);
  assert.equal(s.f.dispatches(), 2);
  const states = await Promise.all(s.prepared.map(item => readJSON(item.recovery_file)));
  assert.notEqual(states[0].requests['generate-video'].idempotency_key, states[1].requests['generate-video'].idempotency_key);
  assert.ok(states.every(state => state.consumption_authorization.source.includes(s.input.source)));
  assert.equal(states[0].consumption_authorization.count, 1);
  const result = await cli(['batch-status', '--config', s.f.config, '--batch-file', batch.batch_file]);
  assert.equal(result.code, 0);
  assert.equal(result.value.data.rows.length, 2);
});

test('建议草稿不等于授权；整批总预算与逐行限额分别拦截', async t => {
  const s = await scenario(t);
  await assert.rejects(initializeBatch({ ...s.input, source: '' }, s.f.options, s.active), { code: 'INVALID_INPUT' });
  await assert.rejects(generate('generate-video', s.prepared[0].recovery_file, null, s.f.options, s.active), { code: 'AUTHORIZATION_REQUIRED' });
  const batch = await initializeBatch({ ...s.input, max_credits: 8 }, s.f.options, s.active);
  await buy(s, batch, 0);
  await assert.rejects(buy(s, batch, 1), { code: 'BATCH_BUDGET_EXCEEDED' });
  assert.equal(s.f.dispatches(), 1);
  s.f.tasks.get(s.prepared[1].task_id).billing.quoted_credits = 9;
  await assert.rejects(buy(s, batch, 1), { code: 'BATCH_ROW_LIMIT' });
});

test('固定清单拒绝改剧本、改行、换账号及篡改快照；新增商品不在原授权内', async t => {
  const s = await scenario(t), batch = await initializeBatch(s.input, s.f.options, s.active);
  const state = await readJSON(s.prepared[0].recovery_file);
  state.requests.prepare.prompt += '新增未批准的镜头';
  await atomicJSON(s.prepared[0].recovery_file, state);
  await assert.rejects(buy(s, batch, 0), { code: 'BATCH_INPUT_CHANGED' });
  await assert.rejects(generate('generate-video', s.prepared[1].recovery_file, null,
    { ...rowOptions(s, batch, 1), 'batch-row': 'new-row' }, s.active), { code: 'BATCH_ROW_MISMATCH' });
  await assert.rejects(batchStatus(batch.batch_file,
    { ...s.active, context: { ...s.active.context, account_id: 'other-account' } }), { code: 'BATCH_IDENTITY_MISMATCH' });
  const record = await readJSON(batch.batch_file);
  record.scope.rows[0].variant = '用户未批准的白色';
  await atomicJSON(batch.batch_file, record);
  await assert.rejects(batchStatus(batch.batch_file, s.active), { code: 'INVALID_BATCH_RECORD' });
  assert.equal(s.f.dispatches(), 0);
});

test('规则授权允许范围内自主创作，但不能改变规格或改用非原图', async t => {
  const s = await scenario(t);
  const input = { ...s.input, mode: 'rules', rules: { params, creative_scope: '围绕真实商品自主写马来语脚本，原图不补图。' },
    rows: s.rows.map(({ prepare_file: _file, ...row }) => row) };
  const batch = await initializeBatch(input, s.f.options, s.active);
  await buy(s, batch, 0);
  const state = await readJSON(s.prepared[1].recovery_file);
  state.requests.prepare.params.generate_audio = false;
  await atomicJSON(s.prepared[1].recovery_file, state);
  await assert.rejects(buy(s, batch, 1), { code: 'BATCH_RULES_MISMATCH' });
  state.requests.prepare.params.generate_audio = true;
  state.requests.prepare.asset_refs = ['opaque-generated-unapproved'];
  state.visual_review.checked_asset_refs = ['opaque-generated-unapproved'];
  await atomicJSON(s.prepared[1].recovery_file, state);
  await assert.rejects(buy(s, batch, 1), { code: 'BATCH_RULES_MISMATCH' });
  assert.equal(s.f.dispatches(), 1);
});

test('未知受理暂停后续消费；恢复同一任务后继续，原行不能新开付费重做', async t => {
  const s = await scenario(t, { loseOnce: 'video' }), batch = await initializeBatch(s.input, s.f.options, s.active);
  const unknown = await buy(s, batch, 0);
  assert.equal(unknown.result_type, 'pending');
  assert.equal((await batchStatus(batch.batch_file, s.active)).used_or_reserved_credits, 8);
  await assert.rejects(buy(s, batch, 1), { code: 'BATCH_PAUSED' });
  await resumeOperation(s.prepared[0].recovery_file, s.f.options, s.active);
  const original = s.prepared[0];
  s.prepared[0] = await startOperation('prepare', { ...preparationInput(), creation_id: original.creation_id }, s.f.options, s.active);
  await assert.rejects(buy(s, batch, 0), { code: 'BATCH_ROW_ALREADY_ATTEMPTED' });
  s.prepared[0] = original;
  await buy(s, batch, 1);
  assert.equal(s.f.dispatches(), 2);
});

test('同批次并发执行被拒；报价过期不占预算，同输入重询价后可继续', async t => {
  const s = await scenario(t), batch = await initializeBatch(s.input, s.f.options, s.active);
  await withBatchLock(batch.batch_file, async () => {
    await assert.rejects(buy(s, batch, 0), { code: 'BATCH_BUSY' });
  });
  s.f.tasks.get(s.prepared[0].task_id).result.quote_expires_at = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(buy(s, batch, 0), { code: 'QUOTE_EXPIRED' });
  assert.deepEqual((await loadBatch(batch.batch_file, s.active)).attempts, {});
  s.prepared[0] = await startOperation('prepare', { ...preparationInput(), creation_id: s.prepared[0].creation_id }, s.f.options, s.active);
  await buy(s, batch, 0);
  assert.equal(s.f.dispatches(), 1);
});

test('失败策略明确区分暂停与跳过，失败行不自动重做', async t => {
  for (const on_failure of ['stop', 'skip']) {
    const s = await scenario(t, {}, { on_failure }), batch = await initializeBatch(s.input, s.f.options, s.active);
    const first = await buy(s, batch, 0);
    const task = s.f.tasks.get(first.task_id);
    task.status = 'failed';
    if (on_failure === 'stop') await assert.rejects(buy(s, batch, 1), { code: 'BATCH_PAUSED' });
    else await buy(s, batch, 1);
    assert.equal(s.f.dispatches(), on_failure === 'stop' ? 1 : 2);
  }
});

test('任务完成而账务未终结时保留原报价并暂停下一行', async t => {
  const s = await scenario(t), batch = await initializeBatch(s.input, s.f.options, s.active);
  await buy(s, batch, 0);
  // 中文注释：只改变合成只读账务响应，验证completed不能冒充费用已终结。
  const originalQuery = s.active.query;
  s.active.query = async (...args) => {
    const result = await originalQuery(...args);
    return args[0] === 'creation' ? { ...result, billing: { ...result.billing, final: false, frozen_credits: 8 } } : result;
  };
  const status = await batchStatus(batch.batch_file, s.active);
  assert.equal(status.used_or_reserved_credits, 8);
  assert.equal(status.rows[0].final, false);
  await assert.rejects(buy(s, batch, 1), { code: 'BATCH_PAUSED' });
  assert.equal(s.f.dispatches(), 1);
});

test('重复商品须明确保留，重复行或creation无条件拒绝', async t => {
  const s = await scenario(t);
  await assert.rejects(initializeBatch({ ...s.input, rows: [s.rows[0], { ...s.rows[0], row_id: 'other' }] },
    s.f.options, s.active), { code: 'DUPLICATE_BATCH_ROW' });
  const resolve = await readJSON(s.rows[1].resolve_file);
  resolve.requests.resolve.product_url = 'https://shop.tiktok.com/view/product/1729444383950539260';
  await atomicJSON(s.rows[1].resolve_file, resolve);
  await assert.rejects(initializeBatch(s.input, s.f.options, s.active), { code: 'DUPLICATE_BATCH_PRODUCT' });
  await initializeBatch({ ...s.input, duplicate_policy: 'keep' }, s.f.options, s.active);
});

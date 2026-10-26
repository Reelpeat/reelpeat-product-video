import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, chmod, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { session, startOperation, resumeOperation, generate, readOperation, exitCode,
  boundedOutput } from '../../.codex/skills/reelpeat-product-video/scripts/workflow.mjs';
import { validateAuthorization } from '../../.codex/skills/reelpeat-product-video/scripts/contracts.mjs';
import { atomicJSON, readJSON } from '../../.codex/skills/reelpeat-product-video/scripts/local-files.mjs';
import { saveCredentials, loadCredentials, configLocation } from '../../.codex/skills/reelpeat-product-video/scripts/credentials.mjs';
import { downloadOperation, downloadMedia } from '../../.codex/skills/reelpeat-product-video/scripts/media.mjs';
import { createAdapter } from '../../.codex/skills/reelpeat-product-video/scripts/api-client.mjs';
import { fixture, cli, secret, preparationInput, authorization } from './client-fixture.mjs';

async function recordEvidence(name, value) {
  // 中文注释：只在测试显式指定时保留合成断言摘要，不保存凭据、媒体链接或临时私有文件。
  const directory = process.env.REELPEAT_TEST_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'node' + process.versions.node.split('.')[0] + '-' + name + '.json'),
    JSON.stringify({ channel: 'synthetic-loopback', node: process.version, ...value }, null, 2) + '\n');
}

// 中文注释：用真实本机HTTP与文件跨命令运行验证主流程，不调用真实生成服务。
test('隔离主流程：解析/原图下载/正式准备/无授权阻断/单次生成/结算交付', async t => {
  const f = await fixture(t), active = await session(f.options);
  const parsed = await startOperation('resolve', { product_url: 'https://shop.tiktok.com/view/product/1729444383950539263',
    target_market: 'MY' }, f.options, active);
  assert.equal(parsed.task_status, 'completed');
  const original = await downloadOperation(parsed.recovery_file, active);
  assert.equal(original.result_type, 'delivered');
  assert.equal(original.assets[0].asset_ref, 'opaque-original-black');
  const prepared = await startOperation('prepare', preparationInput(), f.options, active);
  assert.equal(prepared.result_type, 'quote_ready');
  await assert.rejects(generate('generate-video', prepared.recovery_file, null, f.options, active),
    error => error.code === 'AUTHORIZATION_REQUIRED');
  assert.equal(f.dispatches(), 0);
  const state = await readJSON(prepared.recovery_file);
  const authFile = path.join(f.root, 'authorization.json');
  await atomicJSON(authFile, authorization(state));
  const generated = await generate('generate-video', prepared.recovery_file, authFile, f.options, active);
  assert.equal(generated.task_status, 'completed');
  assert.equal(generated.billing.consumed_credits, 8);
  const delivered = await downloadOperation(prepared.recovery_file, active);
  assert.equal(delivered.result_type, 'delivered');
  assert.equal(delivered.balance.available_credits, 92);
  assert.equal(delivered.creation_billing.consumed_credits, 8);
  assert.equal(delivered.content_review, 'not_checked');
  assert.equal(f.dispatches(), 1);
  assert.ok((await readFile(delivered.assets[0].local_path)).length > 0);
  const persisted = (await readFile(prepared.recovery_file, 'utf8')) + await readFile(delivered.manifest_file, 'utf8');
  assert.ok(!persisted.includes(secret));
  assert.ok(!persisted.includes('signature='));
  assert.ok(f.requests.filter(item => item.path.startsWith('/media/')).every(item => !item.has_auth));
  await recordEvidence('main-flow', { account_id: state.account_id, run_id: state.run_id,
    creation_id: delivered.creation_id, task_id: delivered.task_id, steps: ['resolve', 'download-original',
      'prepare', 'block-without-authorization', 'generate-video', 'download-result'],
    writes: f.requests.filter(item => item.method === 'POST').map(({ path, key }) => ({ path, idempotency_key: key })),
    generation_dispatches: f.dispatches(), task_billing: delivered.billing,
    creation_billing: delivered.creation_billing, balance: delivered.balance,
    result_type: delivered.result_type, asset_count: delivered.assets.length, content_review: delivered.content_review,
    media_has_api_authorization: false, persisted_secret_detected: false,
    temporary_media_removed_by_fixture_cleanup: true, real_spend_credits: 0 });
});

test('未知受理：重启后查原创作，只以原键原输入恢复，单个合成派发', async t => {
  const f = await fixture(t, { loseOnce: 'video' }), active = await session(f.options);
  const prepared = await startOperation('prepare', preparationInput(), f.options, active);
  const state = await readJSON(prepared.recovery_file), authFile = path.join(f.root, 'authorization.json');
  await atomicJSON(authFile, authorization(state));
  const unknown = await generate('generate-video', prepared.recovery_file, authFile, f.options, active);
  assert.equal(unknown.result_type, 'pending');
  assert.equal(unknown.task_id, null);
  const resumed = await resumeOperation(prepared.recovery_file, f.options, await session(f.options));
  assert.equal(resumed.task_status, 'completed');
  const writes = f.requests.filter(item => item.path.endsWith('/videos'));
  assert.equal(writes.length, 2);
  assert.equal(writes[0].key, writes[1].key);
  assert.deepEqual(writes[0].body, writes[1].body);
  assert.equal(f.dispatches(), 1);
  assert.ok(f.requests.some(item => item.method === 'GET' && item.path.endsWith('/creations/creation-fixture')));
  await recordEvidence('recovery', { task_id: resumed.task_id, task_status: resumed.task_status,
    same_idempotency_key: writes[0].key === writes[1].key, same_input: true,
    submission_attempts: writes.length, generation_dispatches: f.dispatches(),
    creation_queried_before_replay: true, real_spend_credits: 0 });
});

test('准备受理已completed但只有句柄时仍查询原任务，完整报价前不允许消费', async t => {
  const f = await fixture(t, { completedHandle: true }), active = await session(f.options);
  const prepared = await startOperation('prepare', preparationInput(), { ...f.options, 'wait-seconds': '0' }, active);
  assert.equal(prepared.result_type, 'pending');
  assert.equal(prepared.next_action.operation, 'resume');
  assert.equal(prepared.quote, null);
  const resumed = await resumeOperation(prepared.recovery_file, f.options, active);
  assert.equal(resumed.result_type, 'quote_ready');
  assert.equal(resumed.quote.quoted_credits, 8);
  assert.equal(f.requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(f.dispatches(), 0);
});

test('并发提交同一准备记录使用同一购买身份，不出现第二笔生成', async t => {
  const f = await fixture(t), active = await session(f.options);
  const prepared = await startOperation('prepare', preparationInput(), f.options, active);
  const state = await readJSON(prepared.recovery_file), authFile = path.join(f.root, 'authorization.json');
  await atomicJSON(authFile, authorization(state));
  await Promise.all([1, 2].map(() => generate('generate-video', prepared.recovery_file, authFile, f.options, active)));
  const writes = f.requests.filter(item => item.path.endsWith('/videos'));
  assert.equal(new Set(writes.map(item => item.key)).size, 1);
  assert.equal(f.dispatches(), 1);
});

test('下载失败保持业务成功与费用事实，重新下载不会重新生成', async t => {
  const f = await fixture(t, { mediaFails: 1 }), active = await session(f.options);
  const prepared = await startOperation('prepare', preparationInput(), f.options, active);
  const state = await readJSON(prepared.recovery_file), authFile = path.join(f.root, 'authorization.json');
  await atomicJSON(authFile, authorization(state));
  await generate('generate-video', prepared.recovery_file, authFile, f.options, active);
  const failed = await downloadOperation(prepared.recovery_file, active);
  assert.equal(exitCode(failed), 3);
  assert.equal(failed.task_status, 'completed');
  assert.equal(failed.billing.consumed_credits, 8);
  const recovered = await downloadOperation(prepared.recovery_file, await session(f.options));
  assert.equal(recovered.result_type, 'delivered');
  assert.equal(f.dispatches(), 1);
});

test('多图部分交付只补失败项，保留已下载图片且不新增解析或生成', async t => {
  const f = await fixture(t, { extraImage: true, mediaFails: 1 }), active = await session(f.options);
  const parsed = await startOperation('resolve', { product_url: 'https://shop.tiktok.com/view/product/1729444383950539263',
    target_market: 'MY' }, f.options, active);
  const partial = await downloadOperation(parsed.recovery_file, active);
  assert.equal(partial.result_type, 'delivery_failed');
  assert.equal(partial.assets.length, 1); assert.equal(partial.failures.length, 1);
  const recovered = await downloadOperation(parsed.recovery_file, await session(f.options));
  assert.equal(recovered.result_type, 'delivered'); assert.equal(recovered.assets.length, 2);
  assert.ok(recovered.assets.some(asset => asset.local_path === partial.assets[0].local_path));
  assert.equal(f.requests.filter(item => item.path.startsWith('/media/')).length, 3);
  assert.equal(f.requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(f.dispatches(), 0);
});

test('等待窗口不足不提前轮询，跨日期、工作区和新会话按原路径续接', async t => {
  const f = await fixture(t, { running: true, pollSeconds: 60 }), active = await session(f.options);
  const prepared = await startOperation('prepare', preparationInput(), { ...f.options, 'wait-seconds': '0' }, active);
  assert.equal(exitCode(prepared), 2);
  const before = f.requests.filter(item => item.path.includes('/tasks/')).length;
  const resumed = await resumeOperation(prepared.recovery_file, { 'wait-seconds': '0.01' }, active);
  assert.equal(resumed.result_type, 'pending');
  assert.equal(f.requests.filter(item => item.path.includes('/tasks/')).length, before);
  // 中文注释：跨日用旧时间恢复记录验证，不通过真实等待跨日拖长隔离测试。
  const state = await readJSON(prepared.recovery_file);
  state.created_at = '2026-10-21T00:00:00Z';
  await atomicJSON(prepared.recovery_file, state);
  const other = path.join(f.root, '其他 工作目录'); await mkdir(other);
  const result = await cli(['resume', '--config', f.config, '--run-file', prepared.recovery_file,
    '--wait-seconds', '0'], { cwd: other });
  assert.equal(result.code, 2); assert.equal(result.value.task_id, prepared.task_id);
});

test('准备权限边界：空能力、未看图、非法规格、额外付款方和图片目录缺失均零写入', async t => {
  for (const variant of ['empty', 'review', 'spec', 'payer', 'image']) {
    const f = await fixture(t, { empty: variant === 'empty' }), active = await session(f.options);
    const input = preparationInput();
    if (variant === 'review') delete input.visual_review;
    if (variant === 'spec') input.params = { ...input.params, duration: 99 };
    if (variant === 'payer') input.payer_id = 'other';
    if (variant === 'image') input.kind = 'image';
    await assert.rejects(startOperation('prepare', input, f.options, active));
    assert.equal(f.requests.filter(item => item.method === 'POST').length, 0);
  }
});

test('授权边界：错账号/指纹/数量/金额/未来时间/报价过期和余额不足均不生成', async t => {
  const variants = [{ account_id: 'other' }, { input_fingerprint: 'other' }, { count: 2 },
    { max_credits: 7 }, { authorized_at: '2099-01-01T00:00:00Z' }];
  for (const extra of variants) {
    const f = await fixture(t), active = await session(f.options);
    const prepared = await startOperation('prepare', preparationInput(), f.options, active);
    const file = path.join(f.root, 'authorization.json');
    await atomicJSON(file, authorization(await readJSON(prepared.recovery_file), extra));
    await assert.rejects(generate('generate-video', prepared.recovery_file, file, f.options, active));
    assert.equal(f.dispatches(), 0);
  }
  for (const options of [{ expired: true }, { balance: 7 }, { limit: 7 }]) {
    const f = await fixture(t, options), active = await session(f.options);
    const prepared = await startOperation('prepare', preparationInput(), f.options, active);
    const file = path.join(f.root, 'authorization.json');
    await atomicJSON(file, authorization(await readJSON(prepared.recovery_file)));
    await assert.rejects(generate('generate-video', prepared.recovery_file, file, f.options, active));
    assert.equal(f.dispatches(), 0);
  }
});

test('无原授权的收费恢复记录不允许重放，换账号或API地址不沿用状态', async t => {
  const f = await fixture(t, { loseOnce: 'video' }), active = await session(f.options);
  const prepared = await startOperation('prepare', preparationInput(), f.options, active);
  const state = await readJSON(prepared.recovery_file);
  state.operation = 'generate-video'; state.task_id = null;
  state.requests['generate-video'] = { idempotency_key: 'original', quote_id: 'q', max_credits: 8 };
  await atomicJSON(prepared.recovery_file, state);
  await assert.rejects(resumeOperation(prepared.recovery_file, f.options, active), error => error.code === 'AUTHORIZATION_REQUIRED');
  const other = await fixture(t, { account: 'fixture-B' });
  await assert.rejects(resumeOperation(prepared.recovery_file, other.options, await session(other.options)),
    error => error.code === 'RUN_IDENTITY_MISMATCH');
  assert.equal(f.dispatches(), 0); assert.equal(other.dispatches(), 0);
});

test('CLI：中文/BOM/多行JSON与stdin，严格单个JSON输出且未知选项不回显secret', async t => {
  const f = await fixture(t), input = path.join(f.root, '商品 参数.json');
  await writeFile(input, '\uFEFF' + JSON.stringify(preparationInput()), 'utf8');
  const fromFile = await cli(['prepare', '--config', f.config, '--work-dir', f.root,
    '--params-file', input, '--wait-seconds', '1']);
  assert.equal(fromFile.value.result_type, 'quote_ready');
  const request = f.requests.find(item => item.path.endsWith('/preparations'));
  assert.equal(request.body.prompt, preparationInput().prompt);
  const fromStdin = await cli(['prepare', '--config', f.config, '--work-dir', f.root,
    '--params-file', '-', '--wait-seconds', '1'], { input: JSON.stringify(preparationInput()) });
  assert.equal(fromStdin.code, 0); assert.equal(fromStdin.stderr, '');
  const invalid = await cli(['--key', secret]);
  assert.equal(invalid.code, 1);
  assert.ok(!invalid.stdout.includes(secret)); assert.ok(!invalid.stderr.includes(secret));
});

test('配置文件原子保护、即时换Key，显式来源和服务绑定，不扫描或回退其他凭据', async t => {
  const f = await fixture(t), active = await session(f.options);
  const prepared = await startOperation('prepare', preparationInput(), f.options, active);
  const newKey = 'synthetic-key-replacement';
  await saveCredentials({ ...f.options, 'api-base': f.base }, newKey);
  assert.ok((await loadCredentials(f.options)).api_key === newKey);
  assert.equal((await readOperation('context', {}, await session(f.options))).account_id, active.context.account_id);
  assert.equal((await resumeOperation(prepared.recovery_file, f.options, await session(f.options))).task_id, prepared.task_id);
  assert.equal(f.requests.filter(item => item.method === 'POST').length, 1);
  await assert.rejects(loadCredentials({ ...f.options, 'api-base': 'https://other.invalid/' }),
    error => error.code === 'API_BINDING_MISMATCH');
  assert.throws(() => configLocation({ config: f.config, 'auth-source': 'user' }));
  await chmod(f.config, 0o644);
  if (process.platform !== 'win32')
    await assert.rejects(loadCredentials(f.options), error => error.code === 'PRIVATE_PERMISSIONS_REQUIRED');
  await chmod(f.config, 0o600);
  const link = path.join(path.dirname(f.config), 'linked.json');
  await symlink(f.config, link);
  await assert.rejects(loadCredentials({ config: link }), error => error.code === 'UNSAFE_PATH');
});

test('GET重试遵守预算和Retry-After，不阻塞超过窗口或提前重试', async () => {
  let calls = 0;
  const call = createAdapter({ baseUrl: 'https://example.invalid/', fetchImpl: async () => {
    calls++; return { status: 429, headers: new Headers({ 'retry-after': '60' }), json: async () => ({ detail: 'RATE_LIMITED' }) };
  } });
  const result = await call('reelpeat_get_task', { task_id: 'fixture' }, 'Bearer synthetic',
    { deadline: Date.now() + 50 });
  assert.equal(result.retry_after_seconds, 60); assert.equal(calls, 1);
});

test('媒体拒绝HTML、空文件、内容类型伪装和重定向，下载请求不携带鉴权', async t => {
  const f = await fixture(t);
  for (const [mime, bytes] of [['text/html', '<html>'], ['image/png', ''], ['image/png', '<html>']]) {
    await assert.rejects(downloadMedia('https://media.invalid/a?signature=fixture', path.join(f.root, 'media'), 0, {
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error');
        return new Response(bytes, { headers: { 'content-type': mime } });
      },
    }));
  }
});

test('失败接口与doctor不输出凭据或原始异常，已有环境Key不覆盖显式文件', async t => {
  const f = await fixture(t, { authFailure: true });
  const result = await cli(['doctor', '--config', f.config], { env: { REELPEAT_API_KEY: 'stale-fixture' } });
  assert.equal(result.code, 1);
  assert.ok(!result.stdout.includes(secret));
  assert.ok(!result.stdout.includes('stale-fixture'));
  assert.equal(result.value.error.code, 'AUTH_CHECK_FAILED');
});

test('完整CLI阶段与历史task-id交付，命令参数没有Key且所有结果为JSON', async t => {
  const f = await fixture(t), file = path.join(f.root, 'input.json');
  await atomicJSON(file, preparationInput());
  const baseArgs = ['--config', f.config, '--work-dir', f.root, '--wait-seconds', '1'];
  const prepared = await cli(['prepare', ...baseArgs, '--params-file', file]);
  assert.equal(prepared.value.result_type, 'quote_ready');
  const state = await readJSON(prepared.value.recovery_file), authFile = path.join(f.root, 'auth.json');
  await atomicJSON(authFile, authorization(state));
  const submitted = await cli(['generate-video', ...baseArgs, '--run-file', prepared.value.recovery_file,
    '--authorization-file', authFile]);
  assert.equal(submitted.value.task_status, 'completed');
  const downloaded = await cli(['download', ...baseArgs, '--task-id', submitted.value.task_id]);
  assert.equal(downloaded.value.result_type, 'delivered');
  assert.equal(downloaded.value.billing.consumed_credits, 8);
  assert.equal(f.dispatches(), 1);
  const before = f.requests.filter(item => item.path.startsWith('/media/')).length;
  await cli(['download', ...baseArgs, '--run-file', downloaded.value.recovery_file]);
  assert.equal(f.requests.filter(item => item.path.startsWith('/media/')).length, before);
  for (const result of [prepared, submitted, downloaded]) {
    assert.ok(!result.stdout.includes(secret));
    assert.ok(!result.stdout.includes('signature='));
  }
});

test('stdin的UTF-8中文字符跨chunk仍无损传递', async t => {
  const f = await fixture(t);
  const input = Buffer.from(JSON.stringify({ product_url: 'https://shop.tiktok.com/view/product/1729444383950539263',
    target_market: '马来西亚' }));
  const offset = input.indexOf(Buffer.from('马')) + 1;
  const result = await cli(['resolve', '--config', f.config, '--work-dir', f.root,
    '--params-file', '-', '--wait-seconds', '1'], { input: [input.subarray(0, offset), input.subarray(offset)] });
  assert.equal(result.code, 0);
  assert.equal(f.requests.find(item => item.method === 'POST').body.target_market, '马来西亚');
});

test('大结果经脱敏后限长落盘，不截掉任务身份与下一步', async t => {
  const f = await fixture(t);
  const result = await boundedOutput({ operation: 'creation', result_type: 'accepted', creation_id: 'fixture',
    next_action: { operation: 'resume' }, data: { description: '中'.repeat(10000) } }, f.options);
  assert.equal(result.creation_id, 'fixture');
  assert.equal(result.next_action.operation, 'resume');
  assert.ok(JSON.stringify(result).length < 1000);
  assert.equal((await readJSON(result.data_file)).description.length, 10000);
});

test('报价到期瞬间与显式时区偏移使用同一UTC事实，不依赖本机时区', () => {
  const now = Date.parse('2026-10-23T00:00:00Z');
  const state = { account_id: 'A', creation_id: 'c', preparation_id: 'p',
    quote: { quote_id: 'q', input_fingerprint: 'f' } };
  const auth = { account_id: 'A', creation_id: 'c', preparation_id: 'p', quote_id: 'q',
    input_fingerprint: 'f', max_credits: 8, count: 1, source: '合成授权',
    authorized_at: '2026-10-23T08:00:00+08:00' };
  const prep = { status: 'completed', result: { preparation_id: 'p', quote_id: 'q',
    input_fingerprint: 'f', quote_expires_at: '2026-10-23T08:00:00+08:00' },
    billing: { quoted_credits: 8 } };
  assert.throws(() => validateAuthorization(auth, state, {}, prep, now),
    error => error.code === 'QUOTE_EXPIRED');
  assert.equal(validateAuthorization(auth, state, {}, prep, now - 1), 8);
  assert.throws(() => validateAuthorization({ ...auth, authorized_at: '2026-10-23T08:00:00' },
    state, {}, prep, now - 1), error => error.code === 'INVALID_TIME');
});

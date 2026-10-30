import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, chmod, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { clientModule, fixture, cli, secret, preparationInput, authorization } from './client-fixture.mjs';
// 中文注释：通过共享夹具定位待测模块，导出后无需改写测试源码。
const { session, startOperation, resumeOperation, generate, readOperation, exitCode,
  boundedOutput, loadRun } = await clientModule('workflow.mjs');
const { validateAuthorization } = await clientModule('contracts.mjs');
const { atomicJSON, readJSON, redact } = await clientModule('local-files.mjs');
const { saveCredentials, loadCredentials, configLocation, normalizeKey, normalizeBase, verifyIdentity } = await clientModule('credentials.mjs');
const { downloadOperation, downloadMedia } = await clientModule('media.mjs');
const { createAdapter } = await clientModule('api-client.mjs');

test('独立商品生图正式报价授权后交付图片，同一请求恢复不重复消费并可用于后续视频', async t => {
  // 中文注释：图片与视频分别准备、报价和授权，生成图引用直接复用，不伪造第二次商品解析。
  const f = await fixture(t, { image: true }), active = await session(f.options);
  const input = { ...preparationInput(), kind: 'image', params: { sku_id: 'fixture-image' } };
  const prepared = await startOperation('prepare', input, f.options, active);
  assert.equal(prepared.result_type, 'quote_ready');
  await assert.rejects(generate('generate-image', prepared.recovery_file, null, f.options, active),
    error => error.code === 'AUTHORIZATION_REQUIRED');
  assert.equal(f.dispatches(), 0);
  const authFile = path.join(f.root, 'image-authorization.json');
  await atomicJSON(authFile, authorization(await readJSON(prepared.recovery_file)));
  const generated = await generate('generate-image', prepared.recovery_file, authFile, f.options, active);
  assert.equal(generated.task_status, 'completed');
  assert.equal(generated.billing.consumed_credits, 8);
  await generate('generate-image', prepared.recovery_file, authFile, f.options, active);
  assert.equal(f.dispatches(), 1);
  const image = await downloadOperation(prepared.recovery_file, active);
  assert.equal(image.result_type, 'delivered');
  assert.equal(image.assets[0].type, 'image');
  assert.ok((await readFile(image.assets[0].local_path)).length > 0);
  assert.equal(f.requests.filter(r => r.method === 'POST' && r.path.endsWith('/videos')).length, 0);
  const ref = image.assets[0].asset_ref;
  const video = await startOperation('prepare', { ...preparationInput(), asset_refs: [ref],
    visual_review: { checked_asset_refs: [ref], source: '隔离模拟已核验生成图' } }, f.options, active);
  assert.equal(video.result_type, 'quote_ready');
  const videoAuth = path.join(f.root, 'video-authorization.json');
  await atomicJSON(videoAuth, authorization(await readJSON(video.recovery_file)));
  assert.equal((await generate('generate-video', video.recovery_file, videoAuth, f.options, active)).task_status, 'completed');
  assert.equal(f.dispatches(), 2);
});

test('图片规格只接受当前目录SKU，未知、额外规格或缺失目录均在提交前阻断', async t => {
  // 中文注释：客户端拒绝篡改模型和费用字段，旧服务缺图片能力时不发送准备请求。
  const f = await fixture(t, { image: true }), active = await session(f.options);
  for (const params of [{}, { sku_id: 'unknown' }, { sku_id: 'fixture-image', quality: 'high' }, []]) {
    await assert.rejects(startOperation('prepare', { ...preparationInput(), kind: 'image', params }, f.options, active));
  }
  active.context.capability_details.image_generation.specifications = [];
  await assert.rejects(startOperation('prepare', { ...preparationInput(), kind: 'image',
    params: { sku_id: 'fixture-image' } }, f.options, active), error => error.code === 'IMAGE_CATALOG_UNAVAILABLE');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});

test('商品解析不按平台或旧能力白名单预拦截，完整保留Lazada和其他商城链接', async t => {
  const f = await fixture(t), active = await session(f.options);
  const urls = [
    'https://www.lazada.com.my/products/pdp-i4760826391-s26811211292.html',
    'https://www.amazon.com/dp/B09B8V1LZ3?th=1',
    'https://store.example.com/products/item?variant=black&utm_source=share',
    'http://shop.example.com/item/sku-123',
  ];
  for (const product_url of urls) {
    // 中文注释：夹具仍返回旧TikTok范围，客户端也必须交给服务端尝试，不能提前断言不支持。
    const result = await startOperation('resolve', { product_url, target_market: 'MY' },
      f.options, active);
    assert.equal(result.task_status, 'completed');
  }
  assert.deepEqual(f.requests.filter(item => item.method === 'POST' &&
    item.path === '/api/open/v1/products/resolve').map(item => item.body.product_url), urls);
});

test('商品变体参数可恢复，商品签名、真实Key及临时媒体URL仍不可进入业务记录', async t => {
  const f = await fixture(t), active = await session(f.options);
  for (const query of ['token=hidden', 'accessToken=hidden', 'X-Amz-Signature=hidden', '%61pi_key=hidden']) {
    await assert.rejects(startOperation('resolve', {
      product_url: 'https://store.example.com/item?' + query, target_market: 'MY',
    }, f.options, active), error => error.code === 'SENSITIVE_INPUT');
  }
  const url = 'https://store.example.com/item?variant=black&sku=123';
  const parsed = await startOperation('resolve', { product_url: url, target_market: 'MY' }, f.options, active);
  const state = await readJSON(parsed.recovery_file);
  assert.equal(state.requests.resolve.product_url, url);
  assert.equal(redact({ product_url: url }).product_url, url);
  assert.ok(!JSON.stringify(redact({ preview_url: 'https://cdn.example.com/item?sig=hidden',
    product_url: url + '&other=' + secret }, [secret])).includes(secret));
});

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
  assert.equal((await loadCredentials({ ...f.options, 'api-base': 'https://other.invalid/' })).api_base_url, 'https://other.invalid/');
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

// 中文注释：个人Key与环境错误不能被通用报错误诊为团队Key；响应原文禁止透传。
test('身份检查区分无效Key、失效、空间请求头和权限，不泄露服务原文', async () => {
  const credentials = { api_key: secret, api_base_url: 'https://fixture.invalid/' };
  for (const [status, detail, expected] of [
    [401, 'INVALID_API_KEY', 'INVALID_API_KEY'],
    [401, 'API_KEY_INACTIVE', 'API_KEY_INACTIVE'],
    [403, 'PERSONAL_WORKSPACE_REQUIRED', 'PERSONAL_WORKSPACE_REQUIRED'],
    [403, { error_code: 'INSUFFICIENT_SCOPE' }, 'INSUFFICIENT_SCOPE'],
    [401, secret, 'AUTH_CHECK_FAILED'],
    [403, { error_code: secret }, 'AUTH_CHECK_FAILED'],
  ]) {
    await assert.rejects(verifyIdentity(credentials, { fetchImpl: async () => ({
      status, json: async () => ({ detail }),
    }) }), error => {
      assert.equal(error.code, expected);
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes('请重新创建'));
      return true;
    });
  }
});

test('新旧完整Key均能核验个人身份，掩码与接口合同错误各自明确提示', async () => {
  for (const key of ['reelpeat_' + 'a'.repeat(27), 'reelpeat_' + 'a'.repeat(64)]) {
    const value = normalizeKey('Bearer ' + key);
    const context = await verifyIdentity({ api_key: value, api_base_url: 'https://fixture.invalid/' }, {
      fetchImpl: async (url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer ' + key);
        assert.equal(options.headers['X-Workspace-Id'], undefined);
        return { status: 200, json: async () => ({ code: 0, data: { account_id: 'fixture-A', workspace: 'personal' } }) };
      },
    });
    assert.equal(context.workspace, 'personal');
  }
  // 中文注释：新默认前缀与历史前缀的脱敏值都不能保存为凭据。
  for (const mask of ['rp_…abcd', 'rp_abc...def', 'reelpeat_…abcd', 'reelpeat_abc...def'])
    assert.throws(() => normalizeKey(mask), { code: 'API_KEY_MASKED' });
  for (const [workspace, expected] of [[undefined, 'CONTEXT_INVALID'], ['unknown', 'CONTEXT_INVALID'], ['team', 'PERSONAL_ACCOUNT_REQUIRED']])
    await assert.rejects(verifyIdentity({ api_key: secret, api_base_url: 'https://fixture.invalid/' }, {
      fetchImpl: async () => ({ status: 200, json: async () => ({ code: 0, data: { account_id: 'fixture-A', workspace } }) }),
    }), { code: expected });
});

// 中文注释：用户提供工作台链接时，保存和重读必须始终指向同站真实API入口。
test('工作台地址配置后请求根API，已有同站配置和账号绑定继续有效', async t => {
  const f = await fixture(t), workbench = f.base + 'vorder/app';
  const result = await saveCredentials({ ...f.options, 'api-base': workbench }, secret);
  assert.equal(result.account_id, 'fixture-A');
  const saved = await readJSON(f.config, { privateMode: true });
  assert.equal(saved.api_base_url, f.base);
  const loaded = await loadCredentials({ ...f.options, 'api-base': workbench + '/' });
  assert.equal(loaded.api_base_url, f.base);
  assert.equal((await session(f.options)).context.workspace, 'personal');
  assert.deepEqual(f.requests.map(item => item.path), ['/api/open/v1/context', '/api/open/v1/context']);
  // 中文注释：兼容历史文件中保存的工作台路径，不需要更换Key或绕过跨站绑定。
  await atomicJSON(f.config, { ...saved, api_base_url: workbench });
  assert.equal((await loadCredentials({ ...f.options, 'api-base': f.base })).api_base_url, f.base);
  assert.equal((await loadCredentials({ ...f.options, 'api-base': 'https://other.invalid/' })).api_base_url, 'https://other.invalid/');
});

// 中文注释：用受控fetch核验默认及用户覆盖规则，不把合成Key发送到真实公网。
test('新配置默认网关、用户显式网关优先，已有地址不被默认值覆盖', async t => {
  const f = await fixture(t), destination = path.join(f.root, 'default.json'), calls = [];
  const dependencies = { fetchImpl: async url => {
    calls.push(url.href);
    return { status: 200, json: async () => ({ code: 0, data: f.context() }) };
  } };
  assert.equal(normalizeBase(), 'https://www.reelpeat.com/');
  await saveCredentials({ config: destination }, secret, dependencies);
  assert.equal((await readJSON(destination)).api_base_url, 'https://www.reelpeat.com/');
  assert.equal(calls[0], 'https://www.reelpeat.com/api/open/v1/context');
  await saveCredentials({ config: destination, 'api-base': 'https://custom.invalid/' }, secret, dependencies);
  assert.equal((await readJSON(destination)).api_base_url, 'https://custom.invalid/');
  assert.equal(calls[1], 'https://custom.invalid/api/open/v1/context');
  await saveCredentials({ config: destination }, secret, dependencies);
  assert.equal(calls[2], 'https://custom.invalid/api/open/v1/context');
  assert.equal((await readJSON(destination)).api_base_url, 'https://custom.invalid/');
  assert.equal((await loadCredentials(f.options)).api_base_url, f.base);
  const before = await readFile(f.config, 'utf8');
  const active = await session({ ...f.options, 'api-base': 'https://override.invalid/' }, dependencies);
  assert.equal(active.credentials.api_base_url, 'https://override.invalid/');
  assert.equal(calls.at(-1), 'https://override.invalid/api/open/v1/context');
  assert.equal(await readFile(f.config, 'utf8'), before);
  for (const value of ['', 'http://unsafe.invalid', 'https://user:password@unsafe.invalid/'])
    assert.throws(() => normalizeBase(value), { code: 'INVALID_API_BASE' });
  await assert.rejects(session({ ...f.options, 'api-base': 'https://override.invalid/' }, {
    fetchImpl: async () => ({ status: 200, json: async () => ({ code: 0, data: { ...f.context(), account_id: 'other' } }) }),
  }), { code: 'ACCOUNT_CHANGED' });
  const run = path.join(f.root, 'old-run.json');
  await atomicJSON(run, { schema_version: 1, account_id: 'fixture-A', api_base_url: f.base });
  await assert.rejects(loadRun(run, active), { code: 'RUN_IDENTITY_MISMATCH' });
});

test('显式env模式也使用默认或用户提供的网关，不修改凭据文件', async () => {
  const previous = process.env.REELPEAT_API_KEY;
  process.env.REELPEAT_API_KEY = secret;
  try {
    assert.equal((await loadCredentials({ 'auth-source': 'env' })).api_base_url, 'https://www.reelpeat.com/');
    assert.equal((await loadCredentials({ 'auth-source': 'env', 'api-base': 'https://custom.invalid/' })).api_base_url, 'https://custom.invalid/');
  } finally {
    if (previous === undefined) delete process.env.REELPEAT_API_KEY;
    else process.env.REELPEAT_API_KEY = previous;
  }
});

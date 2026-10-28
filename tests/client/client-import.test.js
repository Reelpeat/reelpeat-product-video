// 中文注释：失败解析后的资料与原图导入只连接本机替身，不抓取真实网站或消费。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { session, startOperation, resumeOperation, generate } from '../../.codex/skills/reelpeat-product-video/scripts/workflow.mjs';
import { prepareProductImport } from '../../.codex/skills/reelpeat-product-video/scripts/product-import.mjs';
import { readJSON, atomicJSON } from '../../.codex/skills/reelpeat-product-video/scripts/local-files.mjs';
import { downloadOperation } from '../../.codex/skills/reelpeat-product-video/scripts/media.mjs';
import { fixture, cli, preparationInput, authorization } from './client-fixture.mjs';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const input = () => ({ source_task_id: 'failed-original', source_kind: 'user_supplied',
  title: '用户确认的黑色商品', selected_variant: '黑色', images: [{ data_base64: image.toString('base64') }] });

test('失败解析→本地原图导入→下载→报价授权→单次生成', async t => {
  const f = await fixture(t, { parseFails: true }), active = await session(f.options);
  const failed = await startOperation('resolve', { product_url: 'https://www.lazada.com.my/products/pdp-i4760826391-s26811211292.html', target_market: 'MY' }, f.options, active);
  assert.equal(failed.task_status, 'failed');
  assert.equal(failed.error.code, 'PRODUCT_PARSE_FAILED');
  assert.equal(failed.next_action.operation, 'collect-product-information');
  const filename = path.join(f.root, '商品原图.png');
  await writeFile(filename, image);
  const supplied = { ...input(), source_task_id: failed.task_id, images: [{ file: filename }] };
  const imported = await startOperation('import-product', supplied, f.options, active);
  assert.equal(imported.task_status, 'completed');
  assert.equal(imported.creation_id, failed.creation_id);
  const sent = f.requests.find(r => r.path.endsWith('/products/import'));
  assert.equal(sent.body.source_task_id, failed.task_id);
  assert.deepEqual(Buffer.from(sent.body.images[0].data_base64, 'base64'), image);
  assert.equal(sent.body.images[0].file, undefined);
  assert.equal((await readJSON(failed.recovery_file)).task_status, 'failed');
  const downloaded = await downloadOperation(imported.recovery_file, active);
  assert.equal(downloaded.result_type, 'delivered');
  const prepared = await startOperation('prepare', preparationInput(), f.options, active);
  await assert.rejects(generate('generate-video', prepared.recovery_file, null, f.options, active), e => e.code === 'AUTHORIZATION_REQUIRED');
  const authFile = path.join(f.root, 'authorization.json');
  await atomicJSON(authFile, authorization(await readJSON(prepared.recovery_file)));
  const generated = await generate('generate-video', prepared.recovery_file, authFile, f.options, active);
  assert.equal(generated.task_status, 'completed');
  assert.equal(f.dispatches(), 1);
  assert.equal(f.requests.filter(r => r.path.endsWith('/products/resolve')).length, 1);
});

test('导入响应丢失后跨命令恢复沿用原键及编码，不重新读已变更原图', async t => {
  const f = await fixture(t, { loseOnce: 'import' }), active = await session(f.options);
  const filename = path.join(f.root, 'original.png');
  await writeFile(filename, image);
  const pending = await startOperation('import-product', { ...input(), images: [{ file: filename }] }, f.options, active);
  assert.equal(pending.result_type, 'pending');
  await writeFile(filename, 'changed');
  const resumed = await resumeOperation(pending.recovery_file, f.options, active);
  assert.equal(resumed.task_status, 'completed');
  const requests = f.requests.filter(r => r.path.endsWith('/products/import'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].key, requests[1].key);
  assert.deepEqual(requests[0].body, requests[1].body);
  const again = await resumeOperation(pending.recovery_file, f.options, active);
  assert.equal(again.task_status, 'completed');
  assert.equal(f.requests.filter(r => r.path.endsWith('/products/import')).length, 2);
});

test('浏览器来源保留非秘密变体参数；签名与凭据仍拒绝', async t => {
  const f = await fixture(t), active = await session(f.options);
  const supplied = { ...input(), source_kind: 'browser_observed',
    source_urls: ['https://brand.example.com/item?variant=black'], images: [{ url: 'https://cdn.example.com/item.png?sku=black' }] };
  const result = await startOperation('import-product', supplied, f.options, active);
  const state = await readJSON(result.recovery_file);
  assert.deepEqual(state.requests['import-product'].source_urls, supplied.source_urls);
  for (const query of ['token=secret', 'X-Amz-Signature=secret'])
    await assert.rejects(startOperation('import-product', { ...supplied, images: [{ url: 'https://cdn.example.com/image?' + query }] }, f.options, active), e => e.code === 'SENSITIVE_INPUT');
});

test('旧服务能力、缺浏览器来源、非法文件与图片总量在提交前拒绝', async t => {
  const f = await fixture(t), active = await session(f.options);
  const old = structuredClone(active.context);
  delete old.capability_details.product_parse.fallback_import;
  await assert.rejects(prepareProductImport(input(), f.options, old), e => e.code === 'CAPABILITY_UNAVAILABLE');
  await assert.rejects(prepareProductImport({ ...input(), source_kind: 'browser_observed' }, f.options, active.context), e => e.code === 'SOURCE_EVIDENCE_REQUIRED');
  const file = path.join(f.root, 'original.png'), alias = path.join(f.root, 'alias.png');
  await writeFile(file, image); await symlink(file, alias);
  await assert.rejects(prepareProductImport({ ...input(), images: [{ file: alias }] }, f.options, active.context), e => e.code === 'UNSAFE_PATH');
  await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(prepareProductImport({ ...input(), images: [{ file }] }, f.options, active.context), e => e.code === 'IMAGE_TOO_LARGE');
  assert.equal(f.requests.filter(r => r.path.endsWith('/products/import')).length, 0);
});

test('CLI支持import-product及超过旧2MiB上限的原图恢复', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'large.png');
  // 中文注释：本例只测客户端字节传递，真实图片格式验证由服务端行为用例覆盖。
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
  await writeFile(file, bytes);
  const params = path.join(f.root, 'import.json');
  await writeFile(params, JSON.stringify({ ...input(), images: [{ file }] }));
  const result = await cli(['import-product', '--params-file', params, '--config', f.config,
    '--work-dir', f.root, '--wait-seconds', '1']);
  assert.equal(result.code, 0);
  assert.equal(result.value.task_status, 'completed');
  const stored = JSON.parse(await readFile(result.value.recovery_file, 'utf8'));
  assert.deepEqual(Buffer.from(stored.requests['import-product'].images[0].data_base64, 'base64'), bytes);
  const resumed = await cli(['resume', '--run-file', result.value.recovery_file, '--config', f.config, '--work-dir', f.root]);
  assert.equal(resumed.code, 0);
});

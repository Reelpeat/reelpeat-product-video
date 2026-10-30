import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { atomicJSON } from '../../.codex/skills/reelpeat-product-video/scripts/local-files.mjs';

export const entry = fileURLToPath(new URL('../../.codex/skills/reelpeat-product-video/scripts/reelpeat.mjs', import.meta.url));
export const secret = 'synthetic-client-fixture-A';
export const params = { model: 'mini', resolution: '480p', ratio: '9:16',
  duration: 15, generate_audio: true, camera_fixed: false };
export const preparationInput = () => ({ creation_id: 'creation-fixture', kind: 'video',
  prompt: '黑色商品，马来语短句。\n保持原款，符号 $ 和引号 " 不改变。',
  asset_refs: ['opaque-original-black'], params,
  visual_review: { checked_asset_refs: ['opaque-original-black'], source: '隔离夹具，模拟宿主已看图' },
  creative_summary: '原图展示，隔离测试不调用模型。' });
export const billing = (paid = false) => ({ status: paid ? 'settled' : 'pending',
  quoted_credits: 8, consumed_credits: paid ? 8 : 0, frozen_credits: 0,
  released_credits: 0, expired_credits: 0, final: paid });

// 中文注释：仅本机随机端口的合成服务，没有真实数据库、用户或供应商。
export async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reelpeat 客户端 test '));
  const requests = [], tasks = new Map(), accepted = new Map();
  let server, dispatches = 0, lost = false, mediaFails = options.mediaFails || 0;
  const context = () => ({ account_id: options.account || 'fixture-A', workspace: 'personal',
    scopes: ['account:read', 'products:read', 'tasks:read', 'videos:generate'],
    max_credits_per_generation: options.limit ?? 100,
    capabilities: options.empty ? [] : ['product_import', 'product_parse', 'video_generation'],
    capability_details: options.empty ? {} : {
      product_import: { source_kinds: ['user_supplied', 'browser_observed'], image_inputs: ['url', 'data_base64'],
        max_images: 9, max_total_image_bytes: 8 * 1024 * 1024, target_market_required: true,
        billing: { status: 'not_billable', credits: 0 } },
      product_parse: { platforms: ['tiktok_shop'], url_hosts: ['shop.tiktok.com'],
        url_path_pattern: '/(?:view/)?product/\\d{10,25}(?:/|$)',
        fallback_import: { source_kinds: ['user_supplied', 'browser_observed'], image_inputs: ['url', 'data_base64'],
          max_images: 9, max_total_image_bytes: 8 * 1024 * 1024, billing: { status: 'not_billable', credits: 0 } },
        billing: { status: 'not_billable', credits: 0 } },
      video_generation: { specifications: [{ model: 'mini', resolution: '480p', durations: [15], sku_id: 'fixture-mini' }],
        ratios: ['9:16'], generate_audio: [true, false], camera_fixed: [true, false],
        billing: { preparation_credits: 0, quote_required: true, currency: 'rcoin' } },
    } });
  // 中文注释：批量隔离场景每行独立creation；原单条夹具保持原身份。
  const taskResult = (kind, id, creationId = 'creation-fixture') => ({
    task_id: id, creation_id: creationId, kind, status: options.running ? 'running' : 'completed',
    poll_after_seconds: options.pollSeconds ?? 0, billing: kind === 'video' ? billing(true) : billing(),
    result: kind === 'preparation' ? { preparation_id: id, kind: 'video', quote_id: 'quote-fixture',
      input_fingerprint: 'f'.repeat(64), quote_expires_at: new Date(Date.now() + (options.expired ? -1000 : 3600000)).toISOString() }
      : kind === 'product_parse' ? { title: '合成黑色套装', image_refs: [
        { index: 0, asset_ref: 'opaque-original-black', preview_url: base() + 'media/image?signature=synthetic' },
        ...(options.extraImage ? [{ index: 1, asset_ref: 'opaque-original-side',
          preview_url: base() + 'media/image?signature=synthetic' }] : [])] }
        : { video_url: base() + 'media/video?signature=synthetic' },
  });
  const base = () => 'http://127.0.0.1:' + server.address().port + '/';
  server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const record = { method: request.method, path: request.url.split('?')[0], body,
      key: request.headers['idempotency-key'], has_auth: Boolean(request.headers.authorization) };
    requests.push(record);
    if (record.path.startsWith('/media/')) {
      if (mediaFails-- > 0) { response.writeHead(403).end(); return; }
      const image = record.path.endsWith('image');
      const bytes = image ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
        : Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom00000000')]);
      response.writeHead(200, { 'Content-Type': image ? 'image/png' : 'video/mp4', 'Content-Length': bytes.length });
      response.end(bytes); return;
    }
    const send = data => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ code: 0, data })); };
    if (options.authFailure) { response.writeHead(401).end(JSON.stringify({ detail: secret })); return; }
    if (record.path.endsWith('/context')) { send(context()); return; }
    if (record.path.endsWith('/account/balance')) {
      send({ available_credits: options.balance ?? (dispatches ? 92 : 100), frozen_credits: 0, account_status: 'ready', as_of: new Date().toISOString() }); return;
    }
    if (request.method === 'POST') {
      if (!accepted.has(record.key)) {
        const kind = record.path.endsWith('/resolve') || record.path.endsWith('/import') ? 'product_parse'
          : record.path.endsWith('/preparations') ? 'preparation' : 'video';
        const id = kind + '-' + (tasks.size + 1);
        const creationId = options.multi ? (kind === 'product_parse' ? 'creation-' + id
          : record.path.split('/')[5]) : 'creation-fixture';
        const task = taskResult(kind, id, creationId);
        // 中文注释：原抓取失败后导入仍能完成，用于验证兜底不会重复解析或收费。
        if (options.parseFails && record.path.endsWith('/resolve'))
          Object.assign(task, { status: 'failed', error_code: 'PRODUCT_PARSE_FAILED', result: {} });
        tasks.set(id, task); accepted.set(record.key, id);
        if (kind === 'video') dispatches++;
      }
      const id = accepted.get(record.key), task = tasks.get(id);
      if (options.loseOnce && !lost && (task.kind === options.loseOnce ||
          (options.loseOnce === 'import' && record.path.endsWith('/import')))) {
        lost = true; response.destroy(); return;
      }
      response.statusCode = 202;
      send({ ...(task.kind === 'preparation' ? { preparation_id: id } : { task_id: id }),
        creation_id: task.creation_id, status: options.completedHandle ? 'completed' : 'queued',
        poll_after_seconds: options.pollSeconds ?? 0 });
      return;
    }
    if (record.path.includes('/tasks/')) {
      const task = tasks.get(record.path.split('/').at(-1));
      if (options.queryDelay) await new Promise(resolve => setTimeout(resolve, options.queryDelay));
      send(task); return;
    }
    const creationId = options.multi ? record.path.split('/').at(-1) : 'creation-fixture';
    const ownTasks = [...tasks.values()].filter(task => task.creation_id === creationId);
    send({ creation_id: creationId, status: 'completed', tasks: ownTasks,
      billing: ownTasks.some(task => task.kind === 'video') ? billing(true)
        : { ...billing(), quoted_credits: null, consumed_credits: 0 } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = path.join(root, 'private', 'credentials.json');
  await atomicJSON(config, { schema_version: 1, api_key: secret, api_base_url: base(),
    account_id: options.account || 'fixture-A' });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, base: base(), requests, tasks, context,
    options: { config, 'work-dir': root, 'wait-seconds': '1' },
    dispatches: () => dispatches };
}

export async function cli(args, { input, cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, env: { ...process.env, ...env }, stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try { resolve({ code, value: JSON.parse(stdout), stdout, stderr }); } catch { reject(new Error('CLI没有输出单个JSON对象')); }
    });
    // 中文注释：分块输入用于回归UTF-8字符跨操作系统管道边界的场景。
    const writeInput = async () => {
      if (Array.isArray(input)) for (const chunk of input) {
        child.stdin.write(chunk);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      child.stdin.end(Array.isArray(input) ? '' : input || '');
    };
    writeInput().catch(reject);
  });
}

export function authorization(state, extra = {}) {
  return { account_id: state.account_id, creation_id: state.creation_id,
    preparation_id: state.preparation_id, quote_id: state.quote.quote_id,
    input_fingerprint: state.quote.input_fingerprint, max_credits: 8, count: 1,
    source: '本隔离夹具模拟明确同意1条/8R；不代表真实用户授权', authorized_at: new Date().toISOString(), ...extra };
}

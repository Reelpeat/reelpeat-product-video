import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, privateDirectory, regularPath, redact, fail } from './local-files.mjs';
import { loadRun, saveRun, envelope } from './workflow.mjs';

const types = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
  'image/gif': '.gif', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };

function mediaSignature(buffer, mime) {
  if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return buffer[0] === 255 && buffer[1] === 216;
  if (mime === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'image/gif') return /^GIF8[79]a/.test(buffer.toString('ascii', 0, 6));
  if (mime === 'video/webm') return buffer.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  return buffer.toString('ascii', 4, 8) === 'ftyp';
}

// 中文注释：媒体请求从不附带API凭据，拒绝重定向和伪装成图片的HTML。
export async function downloadMedia(urlValue, directory, index, { fetchImpl = fetch } = {}) {
  let url;
  try { url = new URL(urlValue); } catch { fail('INVALID_MEDIA_URL', '产物链接无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    fail('INVALID_MEDIA_URL', '产物链接的协议或凭据格式无效。');
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) fail('MEDIA_UNAVAILABLE', '原产物暂不可下载，请查询原任务刷新链接。');
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const ext = types[mime];
  if (!ext) fail('UNSUPPORTED_MEDIA_TYPE', '响应不是受支持的图片或视频，不保存为产物。');
  await privateDirectory(directory);
  const temporary = path.join(directory, '.' + randomUUID() + '.part');
  const final = path.join(directory, 'asset-' + index + '-' + randomUUID() + ext);
  let handle, size = 0, head = Buffer.alloc(0);
  try {
    handle = await open(temporary, 'wx', 0o600);
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      if (head.length < 32) head = Buffer.concat([head, bytes]).subarray(0, 32);
      size += bytes.length;
      if (size > 256 * 1024 * 1024) fail('MEDIA_TOO_LARGE', '单个媒体超过256MiB，请通过原任务另行交付。');
      await handle.writeFile(bytes);
    }
    if (!size || !mediaSignature(head, mime)) fail('INVALID_MEDIA_CONTENT', '产物为空或内容与媒体类型不符。');
    const expected = response.headers.get('content-length');
    if (expected && Number(expected) !== size) fail('MEDIA_INCOMPLETE', '媒体下载字节数不完整。');
    await handle.close(); handle = null;
    await rename(temporary, final);
    return { local_path: final, media_type: mime, size_bytes: size, download_status: 'completed' };
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function sources(task) {
  const result = task.result || {};
  if (task.kind === 'product_parse') return (result.image_refs || []).map(item =>
    ({ index: item.index, asset_ref: item.asset_ref, url: item.preview_url, type: 'image' }));
  if (task.kind === 'image') return [{ index: 0, asset_ref: result.asset_ref, url: result.preview_url, type: 'image' }];
  return [{ index: 0, url: result.video_url, type: 'video' }];
}

export async function downloadOperation(file, active, dependencies = {}) {
  const state = await loadRun(file, active);
  if (!state.task_id) fail('TASK_ID_REQUIRED', '先续接原受理，取得任务ID后再下载。');
  const task = await active.query('task', { task_id: state.task_id });
  if (task.status !== 'completed') return envelope('download', { result_type: task.status === 'failed' ? 'error' : 'pending',
    task_id: state.task_id, task_status: task.status, billing: task.billing, recovery_file: file,
    next_action: { operation: 'resume', recovery_file: file } });
  const assets = [], failures = [];
  for (const [index, item] of sources(task).entries()) {
    const identity = { index: item.index ?? index, type: item.type, ...(item.asset_ref ? { asset_ref: item.asset_ref } : {}) };
    try {
      // 中文注释：部分下载续接保留已成功的原文件，不重复下载成功项。
      const existing = state.assets?.find(asset => asset.index === identity.index &&
        asset.asset_ref === identity.asset_ref && asset.type === identity.type);
      const mediaRoot = path.join(path.dirname(file), 'media') + path.sep;
      if (existing?.local_path?.startsWith(mediaRoot)) {
        const stat = await regularPath(existing.local_path, { missing: true });
        if (stat?.size === existing.size_bytes) { assets.push(existing); continue; }
      }
      const media = await downloadMedia(item.url, path.join(path.dirname(file), 'media'), index, dependencies);
      assets.push({ ...identity, ...media });
    } catch {
      failures.push({ ...identity, download_status: 'failed', error_code: 'MEDIA_DOWNLOAD_FAILED',
        message: '未交付该媒体，请重取原任务链接后仅重试下载。' });
    }
  }
  if (!assets.length && !failures.length) failures.push({ error_code: 'MEDIA_NOT_READY', download_status: 'failed' });
  // 中文注释：账务实时查询并单独记录，不能用创建时的0覆盖正式结算。
  const creation = state.creation_id ? await active.query('creation', { creation_id: state.creation_id }) : { billing: null };
  let balance = null;
  if (active.context.scopes?.includes('account:read')) balance = await active.query('balance');
  state.task_status = task.status; state.billing = task.billing;
  state.assets = assets; state.download_failures = failures; state.content_review = 'not_checked';
  const manifest = { schema_version: 1, account_id: state.account_id, creation_id: state.creation_id,
    task_id: state.task_id, task_status: task.status, assets, failures,
    task_billing: task.billing, creation_billing: creation.billing, balance, content_review: 'not_checked' };
  const manifestFile = path.join(path.dirname(file), 'manifest.json');
  await atomicJSON(manifestFile, redact(manifest, [active.credentials.api_key]));
  await saveRun(state, file, active);
  return envelope('download', { result_type: failures.length ? 'delivery_failed' : 'delivered',
    account_id: state.account_id, creation_id: state.creation_id, task_id: state.task_id,
    task_status: task.status, billing: task.billing, creation_billing: creation.billing, balance,
    recovery_file: file, manifest_file: manifestFile, assets, failures, content_review: 'not_checked',
    next_action: failures.length ? { operation: 'download', recovery_file: file } : { operation: 'review-media' } });
}

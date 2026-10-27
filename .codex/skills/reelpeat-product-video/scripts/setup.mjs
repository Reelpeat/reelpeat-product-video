import { createServer } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { atomicJSON, readJSON, fail, ClientError } from './local-files.mjs';
import { configLocation, normalizeBase, configuredBase, normalizeKey, verifyIdentity, saveCredentials } from './credentials.mjs';
import { DEFAULT_API_BASE } from './api-client.mjs';

// 中文注释：仅维护公开获客入口；来源参数不含账号或凭据，登录后只回到本站个人Key管理。
const ACCOUNT_URL = DEFAULT_API_BASE + 'vorder/login?utm_source=skill&utm_medium=skill&utm_campaign=reelpeat_launch_202610&utm_content=first_setup&skill_id=reelpeat-product-video&skill_version=1.1.1&acq_id=b8317cf3a84243f090d727a650dce7ca&redirect=%2Fvorder%2Fapp%3Faccount_action%3Dapi-keys';

export function accountEntry(apiBase) {
  // 中文注释：显式使用其他API环境时不展示本环境账户入口，避免配置错账号体系。
  try { return new URL(normalizeBase(apiBase)).origin === new URL(ACCOUNT_URL).origin ? ACCOUNT_URL : null; }
  catch { return null; }
}

const html = (nonce, apiBase) => '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>配置 Reelpeat</title>' +
  '<body><h1>配置 Reelpeat</h1><p>在本机保存个人 Key，验证并确认保存后立即生效；也可选择Agent代配或终端配置。</p>' +
  (accountEntry(apiBase) ? '<p>还没有个人 Key？<a href="' + escapeHTML(accountEntry(apiBase)) +
    '" target="_blank" rel="noopener noreferrer">注册／登录 Reelpeat，创建个人 Key</a>。已有账号直接登录，无需重复注册。</p>' : '') +
  '<form method="post"><input type="hidden" name="csrf" value="' + nonce + '">' +
  '<label>个人 API Key <input name="key" type="password" required autocomplete="off" maxlength="4096"></label>' +
  '<button type="submit">验证账号</button></form></body></html>';
const escapeHTML = value => String(value).replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const confirmation = (nonce, revision, context, file) => '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
  '<title>确认 Reelpeat 账号</title><body><h1>请核对账号与保存位置</h1><p>个人账号：' +
  escapeHTML(context.account_id) + '</p><p>保存位置：' + escapeHTML(file) +
  '</p><p>这会更新所选位置的配置，不产生生成费用。</p><form method="post">' +
  '<input type="hidden" name="csrf" value="' + nonce + '"><input type="hidden" name="action" value="save">' +
  '<input type="hidden" name="confirmation_id" value="' + revision + '">' +
  '<button type="submit">确认保存</button></form></body></html>';

async function formBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString('utf8');
    if (Buffer.byteLength(body) > 12000) fail('FORM_TOO_LARGE', '配置内容过大。');
  }
  return new URLSearchParams(body);
}

function equalNonce(value, expected) {
  const a = Buffer.from(value || ''), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// 中文注释：配置页不带外部资源，不记录输入，不将Key放进URL或输出。
export async function startSetupServer(state, setupFile, { fetchImpl = fetch, ttlMs = 300000 } = {}) {
  // 中文注释：整次网页验证和保存固定同一网关，避免期间配置变化造成校验、保存落到不同站点。
  const apiBase = await configuredBase(state.options);
  const nonce = randomBytes(32).toString('hex');
  let busy = false, finished = false, pendingKey = '', revision = '';
  const server = createServer(async (request, response) => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    response.setHeader('Cache-Control', 'no-store');
    // 中文注释：保留同源表单的Origin，跨站不发送Referer；所有拒绝分支也明确使用UTF-8。
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'");
    if (request.headers.host !== new URL(origin).host || request.url !== '/setup/' + state.session_id) {
      response.writeHead(403).end('拒绝未授权的本机配置访问'); return;
    }
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html(nonce, apiBase)); return;
    }
    if (request.method !== 'POST' || request.headers.origin !== origin ||
      !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
      response.writeHead(403).end('请从本机配置页面提交'); return;
    }
    try {
      const form = await formBody(request);
      if (!equalNonce(form.get('csrf'), nonce) || busy || finished) {
        response.writeHead(403).end('配置会话无效或已完成'); return;
      }
      busy = true;
      if (form.get('action') !== 'save') {
        pendingKey = normalizeKey(form.get('key'));
        const context = await verifyIdentity({ api_key: pendingKey,
          api_base_url: apiBase }, { fetchImpl });
        revision = randomBytes(24).toString('hex');
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(confirmation(nonce, revision, context, configLocation(state.options).file));
        return;
      }
      if (!pendingKey || !equalNonce(form.get('confirmation_id'), revision))
        fail('KEY_NOT_VERIFIED', '请先验证Key并核对当前账号。');
      const saved = await saveCredentials({ ...state.options, 'api-base': apiBase }, pendingKey, { fetchImpl });
      await atomicJSON(setupFile, { ...state, status: 'completed', ...saved });
      finished = true; pendingKey = '';
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><meta charset="utf-8"><p>已验证并保存，且已从相同位置重读核验。</p><p>保存位置：' +
        escapeHTML(saved.config_file) + '</p><p>可关闭页面，返回Agent按此位置执行doctor检查。</p>');
      server.close();
    } catch (error) {
      pendingKey = '';
      // 中文注释：只显示客户端受控错误，不回显原始请求、Key、系统异常或堆栈。
      const detail = error instanceof ClientError ? error.code + '：' + error.message : '配置处理失败。';
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end(detail + '\n验证或保存未成功，请核对Key、服务地址、文件权限，再检查所选配置位置。');
    } finally { busy = false; }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/setup/' + state.session_id;
  await atomicJSON(setupFile, { ...state, status: 'ready', setup_url: url });
  const timer = setTimeout(async () => {
    pendingKey = '';
    server.closeAllConnections();
    server.close();
    if (!finished) await atomicJSON(setupFile, { ...state, status: 'expired' }).catch(() => {});
  }, ttlMs);
  timer.unref();
  server.once('close', () => clearTimeout(timer));
  return { server, setup_url: url };
}

export async function launchSetup(options) {
  const location = configLocation(options);
  if (location.source === 'env') fail('ENV_SAVE_UNSUPPORTED', 'env模式请通过宿主secret注入，不启动本机保存。');
  options = { ...options, 'api-base': await configuredBase(options, location) };
  const session = randomUUID();
  const setupFile = path.join(path.dirname(location.file), 'setup-' + session + '.json');
  const state = { schema_version: 1, session_id: session, status: 'starting',
    expires_at: new Date(Date.now() + 300000).toISOString(),
    options: Object.fromEntries(Object.entries(options).filter(([key]) =>
      ['auth-source', 'scope', 'config', 'work-dir', 'api-base'].includes(key))) };
  await atomicJSON(setupFile, state, { createOnly: true });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./reelpeat.mjs', import.meta.url)),
    'setup-server', '--setup-file', setupFile], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  // 中文注释：只等服务启动，不占用Agent调用窗口等待用户输入。
  for (let attempt = 0; attempt < 40; attempt++) {
    const current = await readJSON(setupFile, { privateMode: true });
    if (current.status === 'ready') return { result_type: 'setup_required',
      setup_url: current.setup_url, setup_file: setupFile, credential_source: location.source,
      account_url: accountEntry(options['api-base']),
      config_file: location.file, expires_at: current.expires_at,
      next_action: { operation: 'auth-status', setup_file: setupFile } };
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  fail('SETUP_START_FAILED', '本机配置页未能启动，请使用宿主受控secret或自行保存指定凭据文件。');
}

export async function setupStatus(setupFile) {
  const state = await readJSON(setupFile, { privateMode: true });
  // 中文注释：状态文件也只返回白名单，不能把任意JSON内容当状态回显。
  return { result_type: state.status === 'completed' ? 'accepted' : 'setup_required',
    setup_status: state.status, account_id: state.account_id || null,
    config_file: state.config_file || null, expires_at: state.expires_at,
    next_action: state.status === 'completed' ? { operation: 'doctor', config: state.config_file } : null };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { accountEntry, startSetupServer } from '../../.codex/skills/reelpeat-product-video/scripts/setup.mjs';
import { saveCredentials } from '../../.codex/skills/reelpeat-product-video/scripts/credentials.mjs';
import { readJSON } from '../../.codex/skills/reelpeat-product-video/scripts/local-files.mjs';
import { fixture, cli, secret } from './client-fixture.mjs';

test('首次接入保留推广参数及固定Key回跳，不为其他环境或无效Key引导注册', async t => {
  const f = await fixture(t);
  const help = await cli(['--help']);
  const url = new URL(help.value.data.account_url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.pathname, '/vorder/login');
  assert.match(url.searchParams.get('acq_id'), /^[a-f0-9]{32}$/);
  for (const [key, value] of Object.entries({ utm_source: 'skill', utm_medium: 'skill',
    utm_campaign: 'reelpeat_launch_202610', utm_content: 'first_setup',
    skill_id: 'reelpeat-product-video', skill_version: '1.1.1',
    redirect: '/vorder/app?account_action=api-keys' })) assert.equal(url.searchParams.get(key), value);
  const missing = await cli(['doctor', '--config', path.join(f.root, 'missing.json')]);
  assert.equal(missing.value.error.code, 'SETUP_REQUIRED');
  assert.equal(missing.value.account_url, url.href);
  assert.ok(!missing.stdout.includes('temporary-url-omitted'));
  assert.equal(accountEntry('https://another-environment.invalid/'), null);
  assert.equal(accountEntry('invalid-api'), null);
  const mismatch = await cli(['doctor', '--config', path.join(f.root, 'missing.json'), '--api-base', f.base]);
  assert.equal(mismatch.value.account_url, null);
  const failed = await fixture(t, { authFailure: true });
  const rejected = await cli(['doctor', '--config', failed.config]);
  assert.equal(rejected.value.error.code, 'AUTH_CHECK_FAILED');
  assert.equal(rejected.value.account_url, undefined);
});

test('本机配置页与宿主使用相同入口，不请求外部资源或放宽CSP', async t => {
  const f = await fixture(t);
  const entry = accountEntry();
  const state = { schema_version: 1, session_id: 'onboarding-page',
    options: { config: f.config, 'api-base': new URL(entry).origin + '/' } };
  const { server, setup_url } = await startSetupServer(state, path.join(f.root, 'onboarding.json'));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(setup_url), body = await response.text();
  const link = body.match(/<a href="([^"]+)" target="_blank" rel="noopener noreferrer">/)[1].replaceAll('&amp;', '&');
  assert.equal(link, entry);
  assert.match(body, /已有账号直接登录，无需重复注册/);
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; form-action 'self'; frame-ancestors 'none'");
  assert.doesNotMatch(body, /<script|<iframe|<img/);
  assert.equal(f.requests.length, 0);
});

// 中文注释：配置UI只通过隔离HTTP验证安全和保存行为，不使用用户真实Key。
test('本机配置页校验Host/Origin/CSRF，仅保存成功一次且无secret输出', async t => {
  const f = await fixture(t);
  const destination = path.join(f.root, 'new private', 'credentials.json');
  const setupFile = path.join(f.root, 'setup private', 'session.json');
  const state = { schema_version: 1, session_id: 'fixture-session', status: 'starting',
    options: { config: destination, 'api-base': f.base }, expires_at: new Date(Date.now() + 300000).toISOString() };
  const { server, setup_url: url } = await startSetupServer(state, setupFile);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = new URL(url).origin;
  const page = await fetch(url);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const body = await page.text(), csrf = body.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  // 中文注释：原生fetch可能忽略自定义Host，直接HTTP才能真实验证该边界。
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { Host: 'evil.invalid' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end();
  });
  assert.equal(badHostStatus, 403);
  const send = (token, requestOrigin) => fetch(url, { method: 'POST',
    headers: { Origin: requestOrigin }, body: new URLSearchParams({ key: secret, csrf: token }) });
  assert.equal((await send(csrf, 'https://evil.invalid')).status, 403);
  assert.equal((await send('wrong', origin)).status, 403);
  await assert.rejects(readFile(destination));
  const good = await send(csrf, origin);
  const confirmedPage = await good.text();
  assert.equal(good.status, 200); assert.ok(!confirmedPage.includes(secret));
  assert.ok(confirmedPage.includes('fixture-A'));
  await assert.rejects(readFile(destination));
  const confirmationId = confirmedPage.match(/name="confirmation_id" value="([a-f0-9]+)"/)[1];
  const savedResponse = await fetch(url, { method: 'POST', headers: { Origin: origin },
    body: new URLSearchParams({ csrf, action: 'save', confirmation_id: confirmationId }) });
  assert.equal(savedResponse.status, 200);
  const saved = await readJSON(destination, { privateMode: true });
  assert.ok(saved.api_key === secret);
  assert.equal(saved.account_id, 'fixture-A');
  assert.equal((await readJSON(setupFile)).status, 'completed');
  assert.ok(!(await readFile(setupFile, 'utf8')).includes(secret));
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);
});

test('CLI配置启动及时交还地址，用户保存后同会话配置检查立即成功', async t => {
  const f = await fixture(t);
  const destination = path.join(f.root, 'new credentials', 'credentials.json');
  const launched = await cli(['auth', 'setup', '--config', destination, '--api-base', f.base]);
  assert.equal(launched.value.result_type, 'setup_required');
  assert.ok(!launched.stdout.includes(secret));
  const url = launched.value.setup_url;
  const page = await fetch(url), html = await page.text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const response = await fetch(url, { method: 'POST', headers: { Origin: new URL(url).origin },
    body: new URLSearchParams({ csrf, key: secret }) });
  assert.equal(response.status, 200);
  const confirmationId = (await response.text()).match(/name="confirmation_id" value="([a-f0-9]+)"/)[1];
  const saved = await fetch(url, { method: 'POST', headers: { Origin: new URL(url).origin },
    body: new URLSearchParams({ csrf, action: 'save', confirmation_id: confirmationId }) });
  assert.equal(saved.status, 200);
  const status = await cli(['auth', 'status', '--setup-file', launched.value.setup_file]);
  assert.equal(status.value.setup_status, 'completed');
  const checked = await cli(['doctor', '--config', destination]);
  assert.equal(checked.code, 0); assert.equal(checked.value.account_id, 'fixture-A');
});

test('失败配置保留旧文件；会话自然超时关闭，不留常驻进程', async t => {
  const f = await fixture(t, { authFailure: true });
  const before = await readFile(f.config, 'utf8');
  const setupFile = path.join(f.root, 'short setup', 'state.json');
  const state = { schema_version: 1, session_id: 'short', options: { config: f.config, 'api-base': f.base },
    expires_at: new Date(Date.now() + 1000).toISOString() };
  const { server, setup_url: url } = await startSetupServer(state, setupFile, { ttlMs: 150 });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const page = await fetch(url), body = await page.text();
  const csrf = body.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const response = await fetch(url, { method: 'POST', headers: { Origin: new URL(url).origin },
    body: new URLSearchParams({ csrf, key: 'synthetic-new-key' }) });
  assert.equal(response.status, 400);
  assert.equal(await readFile(f.config, 'utf8'), before);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal((await readJSON(setupFile)).status, 'expired');
  assert.equal(server.listening, false);
});

test('显式项目模式添加忽略规则，已跟踪的凭据目标拒绝覆盖', async t => {
  const f = await fixture(t), execute = promisify(execFile);
  await execute('git', ['init', '-q', f.root]);
  const options = { 'auth-source': 'project', 'work-dir': f.root, 'api-base': f.base };
  const saved = await saveCredentials(options, secret);
  assert.equal(saved.credential_source, 'project');
  assert.ok((await readFile(path.join(f.root, '.gitignore'), 'utf8')).includes('/.reelpeat-local/'));
  await execute('git', ['add', '-f', '.reelpeat-local/credentials.json'], { cwd: f.root });
  const before = await readFile(saved.config_file, 'utf8');
  await assert.rejects(saveCredentials(options, 'synthetic-other'),
    error => error.code === 'TRACKED_CREDENTIAL_FORBIDDEN');
  assert.equal(await readFile(saved.config_file, 'utf8'), before);
});

test('打包源目录不能存凭据，环境模式不接受静默文件来源', async t => {
  const f = await fixture(t);
  const { configLocation } = await import('../../.codex/skills/reelpeat-product-video/scripts/credentials.mjs');
  const { entry } = await import('./client-fixture.mjs');
  assert.throws(() => configLocation({ config: path.join(path.dirname(path.dirname(entry)), 'credentials.json') }),
    error => error.code === 'SKILL_CREDENTIAL_FORBIDDEN');
  assert.throws(() => configLocation({ config: f.config, 'auth-source': 'env' }),
    error => error.code === 'AMBIGUOUS_CONFIG');
});

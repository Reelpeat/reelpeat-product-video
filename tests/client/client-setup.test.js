import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, stat, chmod } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { accountEntry, startSetupServer } from '../../.codex/skills/reelpeat-product-video/scripts/setup.mjs';
import { saveCredentials } from '../../.codex/skills/reelpeat-product-video/scripts/credentials.mjs';
import { readJSON } from '../../.codex/skills/reelpeat-product-video/scripts/local-files.mjs';
import { fixture, cli, secret, entry } from './client-fixture.mjs';
import { main } from '../../.codex/skills/reelpeat-product-video/scripts/reelpeat.mjs';

test('只拦截低于最低版本的运行时，不限制更高版本或指定主版本', async t => {
  const f = await fixture(t), original = Object.getOwnPropertyDescriptor(process.versions, 'node');
  try {
    // 中文注释：仅模拟版本元数据以核对门禁；真实最低版另跑隔离主流程。
    for (const version of ['18.3.0', '18.20.0', '20.0.0', '25.0.0', '100.0.0']) {
      Object.defineProperty(process.versions, 'node', { ...original, value: version });
      const result = await main(['doctor', '--config', path.join(f.root, 'unconfigured.json')]);
      assert.equal(result.error.code, 'SETUP_REQUIRED');
    }
    for (const version of ['16.20.0', '18.0.0', '18.2.9']) {
      Object.defineProperty(process.versions, 'node', { ...original, value: version });
      await assert.rejects(main(['doctor', '--config', f.config]), { code: 'NODE_VERSION_UNSUPPORTED' });
    }
  } finally { Object.defineProperty(process.versions, 'node', original); }
});

test('首次接入保留推广参数及固定Key回跳，不为其他环境或无效Key引导注册', async t => {
  const f = await fixture(t);
  const help = await cli(['--help']);
  const url = new URL(help.value.data.account_url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.origin, 'https://www.realpeat.com');
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
  assert.equal((await cli(['--help', '--api-base', f.base])).value.data.account_url, null);
  assert.equal(accountEntry('invalid-api'), null);
  const mismatch = await cli(['doctor', '--config', path.join(f.root, 'missing.json'), '--api-base', f.base]);
  assert.equal(mismatch.value.account_url, null);
  const failed = await fixture(t, { authFailure: true });
  const rejected = await cli(['doctor', '--config', failed.config]);
  assert.equal(rejected.value.error.code, 'AUTH_CHECK_FAILED');
  assert.equal(rejected.value.result_type, 'error');
  assert.equal(rejected.value.next_action, null);
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
test('本机配置页所有拒绝分支显式声明UTF-8，中文错误不依赖浏览器猜编码', async t => {
  const f = await fixture(t);
  const { server, setup_url: url } = await startSetupServer({ session_id: 'utf8-rejection',
    options: { config: f.config, 'api-base': f.base } }, path.join(f.root, 'utf8-session.json'));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = new URL(url).origin;
  const cases = [
    { headers: { Host: 'evil.invalid' }, text: '拒绝未授权的本机配置访问' },
    { url: origin + '/wrong-path', text: '拒绝未授权的本机配置访问' },
    { method: 'PUT', text: '请从本机配置页面提交' },
    { method: 'POST', headers: { Origin: 'https://evil.invalid' }, text: '请从本机配置页面提交' },
    { method: 'POST', headers: { Origin: 'null' }, text: '请从本机配置页面提交' },
    { method: 'POST', headers: { Origin: origin }, text: '请从本机配置页面提交' },
    { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'csrf=wrong', text: '配置会话无效或已完成' },
  ];
  for (const item of cases) {
    const result = await new Promise((resolve, reject) => {
      const request = httpRequest(item.url || url, { method: item.method || 'GET', headers: item.headers }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode,
          type: response.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject); request.end(item.body);
    });
    assert.equal(result.status, 403);
    assert.equal(result.type, 'text/plain; charset=utf-8', item.text);
    assert.equal(result.body, item.text);
  }
  assert.equal(f.requests.length, 0);
});

test('本机配置页校验Host/Origin/CSRF，仅保存成功一次且无secret输出', async t => {
  const f = await fixture(t);
  // 中文注释：中文目录覆盖macOS保存回执的实际显示与重读路径。
  const destination = path.join(f.root, '中文 私有目录', '个人凭据.json');
  const setupFile = path.join(f.root, 'setup private', 'session.json');
  const state = { schema_version: 1, session_id: 'fixture-session', status: 'starting',
    options: { config: destination, 'api-base': f.base }, expires_at: new Date(Date.now() + 300000).toISOString() };
  const { server, setup_url: url } = await startSetupServer(state, setupFile);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = new URL(url).origin;
  const page = await fetch(url);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  // 中文注释：no-referrer会让浏览器原生表单把Origin发成null，导致自己的保存请求被拒绝。
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
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
  assert.equal(good.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(confirmedPage, /个人账号/);
  assert.equal(good.status, 200); assert.ok(!confirmedPage.includes(secret));
  assert.ok(confirmedPage.includes('fixture-A'));
  await assert.rejects(readFile(destination));
  const confirmationId = confirmedPage.match(/name="confirmation_id" value="([a-f0-9]+)"/)[1];
  const savedResponse = await fetch(url, { method: 'POST', headers: { Origin: origin },
    body: new URLSearchParams({ csrf, action: 'save', confirmation_id: confirmationId }) });
  assert.equal(savedResponse.status, 200);
  assert.equal(savedResponse.headers.get('content-type'), 'text/html; charset=utf-8');
  const savedPage = await savedResponse.text();
  assert.match(savedPage, /已验证并保存/);
  assert.ok(savedPage.includes(destination));
  assert.ok(!savedPage.includes(secret));
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
  assert.deepEqual(status.value.next_action, { operation: 'doctor', config: destination });
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
  assert.match(await response.text(), /AUTH_CHECK_FAILED/);
  assert.equal(await readFile(f.config, 'utf8'), before);
  // 中文注释：过期状态异步落盘，等待实际条件而非固定睡眠，避免CI磁盘调度造成偶发失败。
  const deadline = performance.now() + 2000;
  let status;
  do {
    status = (await readJSON(setupFile)).status;
    if (status === 'expired') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (performance.now() < deadline);
  assert.equal(status, 'expired');
  assert.equal(server.listening, false);
});

test('Agent通过stdin代配后返回原路径，跨cwd显式doctor成功且不回显Key', async t => {
  const f = await fixture(t), destination = path.join(f.root, 'agent private', 'credentials.json');
  const saved = await cli(['auth', 'set', '--api-base', f.base, '--config', destination, '--stdin'],
    { input: secret + '\n' });
  assert.equal(saved.code, 0);
  assert.equal(saved.value.setup_status, 'completed');
  assert.equal(saved.value.account_id, 'fixture-A');
  assert.deepEqual(saved.value.next_action, { operation: 'doctor', config: destination });
  assert.ok(!saved.stdout.includes(secret));
  assert.ok(!saved.stderr.includes(secret));
  assert.equal((await readJSON(destination)).api_key, secret);
  const checked = await cli(['doctor', '--config', saved.value.next_action.config], { cwd: path.dirname(f.root) });
  assert.equal(checked.code, 0);
  assert.equal(checked.value.environment.config_file, destination);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
});

test('非终端未声明stdin不等待；非法、过长或鉴权失败保留原配置', async t => {
  const f = await fixture(t), before = await readFile(f.config, 'utf8');
  const args = ['auth', 'set', '--api-base', f.base, '--config', f.config];
  assert.equal((await cli(args)).value.error.code, 'KEY_INPUT_REQUIRED');
  const envMode = await cli(['auth', 'set', '--api-base', f.base, '--auth-source', 'env', '--stdin'], { input: secret });
  assert.equal(envMode.value.error.code, 'ENV_SAVE_UNSUPPORTED');
  for (const [input, code] of [['two keys', 'INVALID_CREDENTIAL'], ['x'.repeat(17000), 'INVALID_CREDENTIAL']]) {
    const result = await cli([...args, '--stdin'], { input });
    assert.equal(result.code, 1); assert.equal(result.value.error.code, code);
    assert.equal(await readFile(f.config, 'utf8'), before);
  }
  const rejected = await fixture(t, { authFailure: true });
  const failed = await cli(['auth', 'set', '--api-base', rejected.base, '--config', f.config, '--stdin'], { input: secret });
  assert.equal(failed.value.error.code, 'AUTH_CHECK_FAILED');
  assert.equal(await readFile(f.config, 'utf8'), before);
  assert.ok(!failed.stdout.includes(secret));
});

test('配置文件权限错误与缺配置分别返回error和setup_required', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await chmod(f.config, 0o644);
  const denied = await cli(['doctor', '--config', f.config]);
  assert.equal(denied.value.result_type, 'error');
  assert.equal(denied.value.error.code, 'PRIVATE_PERMISSIONS_REQUIRED');
  assert.equal(denied.value.next_action, null);
  const missing = await cli(['doctor', '--config', path.join(f.root, 'absent.json')]);
  assert.equal(missing.value.result_type, 'setup_required');
  assert.equal(missing.value.next_action.config, path.join(f.root, 'absent.json'));
  const envMissing = await cli(['doctor', '--auth-source', 'env', '--api-base', f.base], { env: { REELPEAT_API_KEY: '' } });
  assert.equal(envMissing.value.result_type, 'setup_required');
  assert.equal(envMissing.value.next_action.operation, 'doctor');
});

// 中文注释：POSIX伪终端验证真实TTY回显与取消；Python仅为测试夹具，客户端没有该依赖。
async function terminalCLI(args, cancel = false, input = secret + '\n') {
  const script = String.raw`
import os,pty,select,subprocess,sys,json,time,errno
data=json.load(sys.stdin)
master,slave=pty.openpty()
child=subprocess.Popen(data['args'],stdin=slave,stdout=slave,stderr=slave,close_fds=True)
os.close(slave)
output=b''; sent=False
try:
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        readable,_,_=select.select([master],[],[],0.1)
        if readable:
            try: chunk=os.read(master,65536)
            except OSError as e:
                if e.errno==errno.EIO: break
                raise
            if not chunk: break
            output+=chunk
            if not sent and b'API Key' in output:
                os.write(master,b'\x03' if data['cancel'] else data['input'].encode())
                sent=True
        elif child.poll() is not None: break
    # 中文注释：PTY可先于进程退出关闭，EOF后仍等待退出，避免将正常收尾误报超时。
    try: child.wait(timeout=max(0.1,deadline-time.monotonic()))
    except subprocess.TimeoutExpired: raise RuntimeError('Terminal timeout')
    print(json.dumps({'code':child.returncode,'sent':sent,'output':output.decode('utf-8','replace')}))
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master)
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.REELPEAT_TEST_PYTHON || 'python3', ['-c', script], { stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code) reject(new Error('伪终端夹具失败：' + stderr));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
    child.stdin.end(JSON.stringify({ args: [process.execPath, entry, ...args], input, cancel }));
  });
}

test('用户终端隐藏输入后保存，Ctrl+C取消不改配置', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), destination = path.join(f.root, 'terminal private', 'credentials.json');
  const args = ['auth', 'set', '--api-base', f.base, '--config', destination];
  const saved = await terminalCLI(args);
  assert.equal(saved.code, 0); assert.equal(saved.sent, true);
  assert.ok(!saved.output.includes(secret));
  assert.equal((await readJSON(destination)).api_key, secret);
  const before = await readFile(destination, 'utf8');
  const cancelled = await terminalCLI(args, true);
  assert.equal(cancelled.code, 1);
  assert.match(cancelled.output, /AUTH_INPUT_CANCELLED/);
  assert.equal(await readFile(destination, 'utf8'), before);
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

// 中文注释：真实PTY比较macOS终端与Agent stdin初始化，覆盖粘贴控制序列和新旧Key格式。
test('终端与Agent初始化保存相同完整Key，短Key、旧Key及粘贴换行不截断', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  for (const key of ['reelpeat_' + 'A_-b09'.repeat(4) + 'abc', 'reelpeat_' + 'ab09'.repeat(16)]) {
    const args = ['auth', 'set', '--api-base', f.base + 'vorder/app', '--config', f.config];
    for (const input of [key + '\r', key + '\r\n', '\x1b[200~' + key + '\x1b[201~\r',
      '\x1b[200~' + key + '\n\x1b[201~\r', 'Bearer ' + key + '\n']) {
      const terminal = await terminalCLI(args, false, input);
      assert.equal(terminal.code, 0);
      assert.ok(!terminal.output.includes(key));
      const terminalConfig = await readJSON(f.config, { privateMode: true });
      assert.equal(terminalConfig.api_key, key);
      assert.equal(terminalConfig.api_base_url, f.base);
      const agent = await cli([...args, '--stdin'], { input: key + '\n' });
      assert.equal(agent.code, 0);
      assert.deepEqual(await readJSON(f.config, { privateMode: true }), terminalConfig);
      const doctor = await cli(['doctor', '--config', f.config], { cwd: path.dirname(f.root) });
      assert.equal(doctor.code, 0);
      assert.equal(doctor.value.account_id, 'fixture-A');
    }
  }
  assert.ok(f.requests.every(request => ['/api/open/v1/context', '/api/open/v1/account/balance'].includes(request.path)));
  assert.ok(f.requests.every(request => request.method === 'GET'));
});

test('终端初始化被网关拒绝时不覆盖Agent已保存的有效配置', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), rejected = await fixture(t, { authFailure: true });
  const before = await readFile(f.config, 'utf8');
  const terminal = await terminalCLI(['auth', 'set', '--api-base', rejected.base, '--config', f.config]);
  assert.equal(terminal.code, 1);
  assert.match(terminal.output, /AUTH_CHECK_FAILED/);
  assert.ok(!terminal.output.includes(secret));
  assert.equal(await readFile(f.config, 'utf8'), before);
});

// 中文注释：默认网关的网页初始化全程使用受控fetch，验证与保存均不访问真实公网。
test('临时网页省略网关时按默认站点验证并保存', async t => {
  const f = await fixture(t), destination = path.join(f.root, 'default-web.json'), calls = [];
  const state = { schema_version: 1, session_id: 'default-gateway', options: { config: destination } };
  const { server, setup_url } = await startSetupServer(state, path.join(f.root, 'default-setup.json'), {
    fetchImpl: async url => {
      calls.push(url.href);
      return { status: 200, json: async () => ({ code: 0, data: f.context() }) };
    },
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const html = await (await fetch(setup_url)).text();
  assert.ok(html.includes('https://www.realpeat.com/vorder/login?'));
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const post = form => fetch(setup_url, { method: 'POST', headers: { Origin: new URL(setup_url).origin }, body: new URLSearchParams(form) });
  const checked = await post({ csrf, key: secret });
  assert.equal(checked.status, 200);
  const confirmation = (await checked.text()).match(/name="confirmation_id" value="([a-f0-9]+)"/)[1];
  assert.equal((await post({ csrf, action: 'save', confirmation_id: confirmation })).status, 200);
  assert.deepEqual(calls, Array(2).fill('https://www.realpeat.com/api/open/v1/context'));
  assert.equal((await readJSON(destination)).api_base_url, 'https://www.realpeat.com/');
});

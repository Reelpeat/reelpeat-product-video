import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAdapter, normalizeApiBase } from './api-client.mjs';
import { atomicJSON, readJSON, regularPath, fail } from './local-files.mjs';

const execute = promisify(execFile);
const skillRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const userDirectory = () => path.join(os.homedir(), '.reelpeat');

export function normalizeBase(base) {
  try {
    // 中文注释：保存、重读与发请求使用相同的规范地址，不能把同站工作台识别为另一环境。
    return normalizeApiBase(base);
  } catch { fail('INVALID_API_BASE', '网关须为有效HTTPS地址；本机开发只允许127.0.0.1。'); }
}

export function normalizeKey(key) {
  if (typeof key !== 'string') fail('INVALID_CREDENTIAL', '请输入个人API Key。');
  const value = key.trim().replace(/^Bearer /, '');
  // 中文注释：列表掩码不是凭据，直接提示复制完整值，避免被误判为团队Key。
  if (value.startsWith('reelpeat_') && /…|\.{3}/.test(value))
    fail('API_KEY_MASKED', '输入的是脱敏显示值，请使用新建时复制的完整Key；脱敏值不能用于配置。');
  if (!value || value.length > 4096 || /\s/.test(value))
    fail('INVALID_CREDENTIAL', 'Key格式无效，请重新在配置界面输入。');
  return value;
}

// 中文注释：位置与凭据来源显式选择，不扫描其他Agent配置或静默换Key。
export function configLocation(options = {}) {
  const source = options['auth-source'] || (options.config ? 'file' : options.scope || 'user');
  const workDir = path.resolve(options['work-dir'] || process.cwd());
  if (!['user', 'project', 'file', 'env'].includes(source)) fail('INVALID_AUTH_SOURCE', '凭据来源须为user/project/file/env。');
  if (options.config && source !== 'file') fail('AMBIGUOUS_CONFIG', '指定文件不能和其他凭据来源同时使用。');
  if (source === 'file' && !options.config) fail('CONFIG_PATH_REQUIRED', 'file模式需要明确配置文件路径。');
  const file = source === 'file' ? path.resolve(workDir, options.config)
    : source === 'project' ? path.join(workDir, '.reelpeat-local', 'credentials.json')
      : path.join(userDirectory(), 'credentials.json');
  if (file === skillRoot || file.startsWith(skillRoot + path.sep))
    fail('SKILL_CREDENTIAL_FORBIDDEN', '凭据不能保存在Skill安装目录。');
  return { source, file, workDir };
}

export async function configuredBase(options, location = configLocation(options)) {
  // 中文注释：重新配置Key也保留原网关；只有用户显式传地址才覆盖，读取失败不得静默改站。
  let base = options['api-base'];
  if (base === undefined && await regularPath(location.file, { missing: true }))
    base = (await readJSON(location.file, { privateMode: true })).api_base_url;
  return normalizeBase(base);
}

export async function loadCredentials(options = {}) {
  const location = configLocation(options);
  let value;
  if (location.source === 'env') {
    value = { api_key: process.env.REELPEAT_API_KEY, api_base_url: options['api-base'] };
    if (!value.api_key)
      fail('SETUP_REQUIRED', '显式env模式需要宿主注入REELPEAT_API_KEY。');
  } else {
    try { value = await readJSON(location.file, { privateMode: true }); }
    catch (error) {
      if (error.code === 'FILE_UNAVAILABLE') fail('SETUP_REQUIRED', '所选凭据文件不可访问，请配置或授权该明确位置。');
      throw error;
    }
    if (value.schema_version !== 1) fail('INVALID_CREDENTIAL_FILE', '凭据文件版本无效。');
  }
  // 中文注释：用户显式网关优先，其次保留已有配置，缺省才用默认；账号和任务绑定仍由后续校验。
  const credentials = { ...location, api_key: normalizeKey(value.api_key),
    api_base_url: normalizeBase(options['api-base'] ?? value.api_base_url), account_id: value.account_id || null };
  return credentials;
}

export async function verifyIdentity(credentials, { fetchImpl = fetch } = {}) {
  const call = createAdapter({ baseUrl: credentials.api_base_url, fetchImpl });
  const response = await call('reelpeat_get_context', {}, 'Bearer ' + credentials.api_key,
    { deadline: Date.now() + 10000 });
  if (response.http_status == null || [429, 503].includes(response.http_status)) {
    const error = new Error('服务连接或限流尚未恢复，请保留原Key，稍后重试检查。');
    error.code = 'SERVICE_RETRY_LATER';
    // 中文注释：服务暂不可用不误导用户换Key或重新配置。
    fail(error.code, error.message);
  }
  if (response.http_status !== 200 || response.code !== 0 || !response.data?.account_id) {
    // 中文注释：只映射已知鉴权错误，既保留根因，也不回显网关原文中的凭据。
    const reasons = new Map([
      ['INVALID_API_KEY', '当前服务无法识别此Key，请核对完整值及创建Key时的网站与API地址是否一致；这不代表团队Key。'],
      ['API_KEY_INACTIVE', 'Key已过期、已删除或所属账号不可用，请到原网站核对状态。'],
      ['PERSONAL_WORKSPACE_REQUIRED', '请求携带了空间上下文，请移除X-Workspace-Id；这不代表Key属于团队。'],
      ['INSUFFICIENT_SCOPE', '当前Key缺少接口所需权限，请在原网站核对授权。'],
    ]);
    const reason = typeof response.detail === 'string' ? response.detail : response.detail?.error_code || response.error_code;
    if ([401, 403].includes(response.http_status) && reasons.has(reason)) fail(reason, reasons.get(reason));
    fail('AUTH_CHECK_FAILED', '身份检查未通过，尚不能判定Key类型；请核对服务地址和响应状态，不要据此重建Key。');
  }
  const context = response.data;
  if (context.workspace === 'team') fail('PERSONAL_ACCOUNT_REQUIRED', '服务明确返回团队空间，本客户端仅支持个人空间。');
  // 中文注释：缺失或未知空间属于接口合同异常，不能声称用户创建了团队Key。
  if (context.workspace !== 'personal') fail('CONTEXT_INVALID', '服务未返回有效的个人空间身份，请核对API地址与服务版本。');
  if (credentials.account_id && credentials.account_id !== String(context.account_id))
    fail('ACCOUNT_CHANGED', '所选Key账号与已绑定账号不同，请重新配置，不能沿用旧授权。');
  return context;
}

async function ignoreProjectCredential(location) {
  try {
    await execute('git', ['rev-parse', '--show-toplevel'], { cwd: location.workDir });
    try {
      // 中文注释：按工作区相对路径查询，避免macOS /var与/private/var别名造成仓库外路径。
      await execute('git', ['ls-files', '--error-unmatch', '--', '.reelpeat-local/credentials.json'], { cwd: location.workDir });
      fail('TRACKED_CREDENTIAL_FORBIDDEN', '目标已被Git跟踪，请先选择未跟踪的私有位置。');
    } catch (error) {
      if (error.code === 'TRACKED_CREDENTIAL_FORBIDDEN') throw error;
      if (error.code !== 1) fail('GIT_CHECK_FAILED', '无法确认凭据是否被版本控制跟踪。');
    }
    const ignoreFile = path.join(location.workDir, '.gitignore');
    const stat = await regularPath(ignoreFile, { missing: true });
    const text = stat ? await readFile(ignoreFile, 'utf8') : '';
    if (!text.split(/\r?\n/).includes('/.reelpeat-local/'))
      await writeFile(ignoreFile, text + (text && !text.endsWith('\n') ? '\n' : '') + '/.reelpeat-local/\n');
  } catch (error) {
    if (error.code === 'TRACKED_CREDENTIAL_FORBIDDEN' || error.code === 'UNSAFE_PATH' || error.code === 'GIT_CHECK_FAILED') throw error;
    // 中文注释：非Git工作区没有可忽略的仓库，不把该情况伪装成已受Git保护。
    if (error.code !== 128) fail('PROJECT_CONFIG_FAILED', '无法检查或设置项目凭据保护。');
  }
}

export async function saveCredentials(options, key, { fetchImpl = fetch } = {}) {
  const location = configLocation(options);
  if (location.source === 'env') fail('ENV_SAVE_UNSUPPORTED', '环境注入模式不保存Key。');
  const credentials = { api_key: normalizeKey(key), api_base_url: await configuredBase(options, location) };
  const context = await verifyIdentity(credentials, { fetchImpl });
  if (location.source === 'project') await ignoreProjectCredential(location);
  await atomicJSON(location.file, { schema_version: 1, ...credentials,
    account_id: String(context.account_id) });
  // 中文注释：保存后从同一绝对路径重读核验，后续doctor也显式沿用此路径。
  await loadCredentials({ config: location.file });
  return { credential_source: location.source, config_file: location.file,
    account_id: String(context.account_id), scopes: context.scopes || [],
    max_credits_per_generation: context.max_credits_per_generation ?? null,
    next_action: { operation: 'doctor', config: location.file } };
}

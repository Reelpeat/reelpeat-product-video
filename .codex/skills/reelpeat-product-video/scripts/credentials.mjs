import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAdapter } from './api-client.mjs';
import { atomicJSON, readJSON, regularPath, fail } from './local-files.mjs';

const execute = promisify(execFile);
const skillRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const userDirectory = () => path.join(os.homedir(), '.reelpeat');

export function normalizeBase(base) {
  try {
    const url = new URL(base);
    createAdapter({ baseUrl: url.href });
    return url.href.endsWith('/') ? url.href : url.href + '/';
  } catch { fail('INVALID_API_BASE', '请显式指定已核验的HTTPS API地址；本机开发只允许127.0.0.1。'); }
}

export function normalizeKey(key) {
  if (typeof key !== 'string') fail('INVALID_CREDENTIAL', '请输入个人API Key。');
  const value = key.trim().replace(/^Bearer /, '');
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

export async function loadCredentials(options = {}) {
  const location = configLocation(options);
  let value;
  if (location.source === 'env') {
    value = { api_key: process.env.REELPEAT_API_KEY, api_base_url: options['api-base'] };
    if (!value.api_key || !value.api_base_url)
      fail('SETUP_REQUIRED', '显式env模式需要宿主注入REELPEAT_API_KEY并指定已核验API地址。');
  } else {
    try { value = await readJSON(location.file, { privateMode: true }); }
    catch (error) {
      if (error.code === 'FILE_UNAVAILABLE') fail('SETUP_REQUIRED', '所选凭据文件不可访问，请配置或授权该明确位置。');
      throw error;
    }
    if (value.schema_version !== 1) fail('INVALID_CREDENTIAL_FILE', '凭据文件版本无效。');
  }
  const credentials = { ...location, api_key: normalizeKey(value.api_key),
    api_base_url: normalizeBase(value.api_base_url), account_id: value.account_id || null };
  if (options['api-base'] && normalizeBase(options['api-base']) !== credentials.api_base_url)
    fail('API_BINDING_MISMATCH', '不能用其他API地址覆盖该Key绑定的服务。');
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
  if (response.http_status !== 200 || response.code !== 0 || !response.data?.account_id)
    fail('AUTH_CHECK_FAILED', '身份检查未通过，请核对Key、服务地址和权限。');
  const context = response.data;
  if (context.workspace !== 'personal') fail('PERSONAL_ACCOUNT_REQUIRED', '只支持当前个人空间。');
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
  const credentials = { api_key: normalizeKey(key), api_base_url: normalizeBase(options['api-base']) };
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

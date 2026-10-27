import { constants } from 'node:fs';
import { open, lstat, mkdir, rename, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export class ClientError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const fail = (code, message) => { throw new ClientError(code, message); };
const execute = promisify(execFile);

async function windowsACL(target, directory, write = false) {
  // 中文注释：替换而非追加ACL，避免旧的Everyone显式授权继续暴露凭据；读取时也核验。
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $target = $env:REELPEAT_PRIVATE_TARGET
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $target
    if ($env:REELPEAT_PRIVATE_WRITE -eq '1') {
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
      $inherit = if ($env:REELPEAT_PRIVATE_DIRECTORY -eq '1') { 'ContainerInherit, ObjectInherit' } else { 'None' }
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow')
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $target -AclObject $acl
      $acl = Get-Acl -LiteralPath $target
    }
    if (!$acl.AreAccessRulesProtected) { throw 'Inherited access' }
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if (!($rules | Where-Object { $_.IdentityReference -eq $sid -and $_.AccessControlType -eq 'Allow' })) { throw 'Missing private access' }
    foreach ($rule in $rules) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference -ne $sid) { throw 'Shared access' }
    }
  `;
  try {
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, REELPEAT_PRIVATE_TARGET: target,
        REELPEAT_PRIVATE_WRITE: write ? '1' : '0', REELPEAT_PRIVATE_DIRECTORY: directory ? '1' : '0' } });
  } catch { fail('PRIVATE_ACL_FAILED', '无法设置或核验私有ACL，请使用宿主受控凭据入口。'); }
}

// 中文注释：Windows必须实际限制ACL，不能把chmod当成等价保护。
export async function protectPrivate(target, directory = false) {
  if (process.platform !== 'win32') return chmod(target, directory ? 0o700 : 0o600);
  return windowsACL(target, directory, true);
}

export async function regularPath(target, { privateMode = false, missing = false, directory = false } = {}) {
  let stat;
  try { stat = await lstat(target); }
  catch (error) {
    if (error.code === 'ENOENT' && missing) return null;
    fail('FILE_UNAVAILABLE', '文件或目录不可访问，请核对所选位置和授权。');
  }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    fail('UNSAFE_PATH', '拒绝符号链接或不匹配的文件类型。');
  if (privateMode && process.platform !== 'win32' && (stat.mode & 0o077))
    fail('PRIVATE_PERMISSIONS_REQUIRED', '凭据目录须为0700、文件须为0600；请修正权限后重试。');
  if (privateMode && process.platform === 'win32') await windowsACL(target, directory);
  return stat;
}

export async function privateDirectory(target) {
  const existing = await regularPath(target, { directory: true, missing: true });
  if (!existing) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    await regularPath(target, { directory: true });
    await protectPrivate(target, true);
  } else await regularPath(target, { directory: true, privateMode: true });
  return target;
}

// 中文注释：原子替换前先保护临时文件，失败不改旧文件且不遗留凭据副本。
export async function atomicJSON(target, value, { createOnly = false } = {}) {
  await privateDirectory(path.dirname(target));
  const old = await regularPath(target, { missing: true });
  if (createOnly && old) fail('FILE_ALREADY_EXISTS', '目标已存在，请续接原记录。');
  const temporary = path.join(path.dirname(target), '.' + randomUUID() + '.tmp');
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await protectPrivate(temporary);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await regularPath(target, { missing: true });
    await rename(temporary, target);
  } catch (error) {
    if (error instanceof ClientError) throw error;
    fail('FILE_SAVE_FAILED', '保存失败，原记录保持不变，请核对目录权限。');
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export async function readJSON(target, { privateMode = false } = {}) {
  await regularPath(path.dirname(target), { directory: true, privateMode });
  await regularPath(target, { privateMode });
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error();
    const value = JSON.parse((await handle.readFile('utf8')).replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { fail('INVALID_JSON_FILE', '无法读取有效的UTF-8 JSON对象，请检查文件与权限。'); }
  finally { await handle?.close(); }
}

function safeProductURL(value) {
  // 中文注释：商品的SKU/分享参数属于输入身份；凭据与临时签名仍不能进入业务记录。
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      ![...url.searchParams.keys()].some(key => /(?:^|[_-])(?:key|api[_-]?key|(?:access|refresh|id|auth|security)[_-]?token|token|authorization|auth|signature|sign|sig|secret|password|cookie|credential)(?:$|[_-])/i.test(key));
  } catch { return false; }
}

// 中文注释：仅商品输入可保留非秘密查询参数，临时媒体链接和凭据仍脱敏。
export function redact(value, secrets = []) {
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(api_key|authorization|cookie|token|secret|password|preview_url|video_url|download_url)$/i.test(key))
    .map(([key, item]) => {
      if (key === 'product_url' && typeof item === 'string' && safeProductURL(item)) {
        for (const secret of secrets.filter(Boolean)) item = item.split(secret).join('[redacted]');
        return [key, item];
      }
      return [key, redact(item, secrets)];
    }));
  if (typeof value !== 'string') return value;
  let result = value;
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[redacted]');
  return result.replace(/https?:\/\/[^\s"'<>]*[?][^\s"'<>]*/g, '[temporary-url-omitted]');
}

export function noCredentials(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(api_key|authorization|cookie|token|secret|password)$/i.test(key))
      fail('CREDENTIAL_IN_INPUT', '业务参数与恢复记录不能包含凭据。');
    if (item && typeof item === 'object') noCredentials(item);
  }
}

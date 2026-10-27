#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configLocation, saveCredentials, normalizeBase } from './credentials.mjs';
import { ClientError, readJSON, redact, fail } from './local-files.mjs';
import { accountEntry, launchSetup, setupStatus, startSetupServer } from './setup.mjs';
import { session, envelope, exitCode, startOperation, resumeOperation, generate, readOperation,
  adoptTask, boundedOutput } from './workflow.mjs';
import { downloadOperation } from './media.mjs';
import { initializeBatch, batchStatus } from './batch.mjs';
import { readKeyInput } from './auth-input.mjs';

const help = {
  description: 'Reelpeat 官方Node客户端；不需要MCP或npm安装。支持Agent代配、临时网页及终端隐藏输入Key。',
  // 中文注释：帮助中的固定公开链接供宿主引导首次接入，不经过临时媒体URL脱敏流程。
  account_url: accountEntry(),
  usage: 'node <skill-root>/scripts/reelpeat.mjs <operation> [options]',
  operations: ['doctor', 'auth set', 'auth setup', 'auth status', 'context', 'balance', 'resolve', 'prepare',
    'generate-image', 'generate-video', 'task', 'creation', 'resume', 'download', 'batch-init', 'batch-status'],
  input: ['--params-file <UTF-8 JSON文件> 或 --params-file - 从stdin读取',
    '--run-file <原state.json>；生成另需 --authorization-file <本次明确授权JSON>',
    '批次：batch-init --params-file <已明确确认的批次JSON>；batch-status --batch-file <batch.json>',
    '批次生成：generate-video --run-file <原准备> --batch-file <batch.json> --batch-row <稳定行ID>'],
  credentials: ['默认用户目录；--auth-source project --work-dir <工作区> 显式项目模式',
    '--config <明确凭据文件>；--auth-source env --api-base <已核验API> 显式宿主secret模式',
    'auth set --api-base <API地址>：终端隐藏输入；Agent可用--stdin传入原始Key后结束输入',
    'auth setup --api-base <API地址>：临时网页；不接受--key，不输出凭据，不修改Agent全局配置'],
  runtime: ['最低Node.js 18.3.0；不限制版本上限，不要求切换到指定主版本',
    '--work-dir <工作区> --output-dir <运行输出目录>',
    '--wait-seconds <0～60，默认20>；窗口耗尽后按next_action续接'],
  exit_codes: { 0: '命令职责完成；仍须检查result_type和业务状态', 1: '配置/参数/接口/业务错误',
    2: '等待窗口耗尽，可恢复；禁止重做', 3: '任务成功但媒体交付不完整，只重试下载' },
};

function optionsFrom(argv) {
  try {
    const options = Object.fromEntries(['params-file', 'run-file', 'authorization-file', 'task-id',
      'creation-id', 'work-dir', 'output-dir', 'wait-seconds', 'auth-source', 'scope',
      'config', 'api-base', 'setup-file', 'batch-file', 'batch-row'].map(key => [key, { type: 'string' }]));
    const parsed = parseArgs({ args: argv, allowPositionals: true, strict: true,
      options: { ...options, help: { type: 'boolean' }, stdin: { type: 'boolean' } } });
    if (parsed.values['wait-seconds'] != null) {
      const seconds = Number(parsed.values['wait-seconds']);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error();
    }
    if (parsed.values.scope && parsed.values['auth-source']) throw new Error();
    return parsed;
  } catch { fail('INVALID_ARGUMENTS', '命令或选项无效，请执行--help；不要把Key放进命令参数。'); }
}

async function inputJSON(options) {
  const file = options['params-file'];
  if (!file) fail('PARAMS_FILE_REQUIRED', '该操作需要--params-file，或--params-file -读取stdin。');
  if (file !== '-') return readJSON(path.resolve(options['work-dir'] || process.cwd(), file));
  try {
    let content = '';
    // 中文注释：由流解码器保留跨chunk的UTF-8字节，避免中文被替换字符破坏。
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      content += chunk;
      if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error();
    }
    const value = JSON.parse(content.replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { fail('INVALID_INPUT_JSON', 'stdin需要有限大小的UTF-8 JSON对象。'); }
}

function runFile(options) {
  if (!options['run-file']) fail('RECOVERY_FILE_REQUIRED', '请指定--run-file恢复原请求，不要创建新任务。');
  return path.resolve(options['work-dir'] || process.cwd(), options['run-file']);
}

async function doctor(options) {
  const location = configLocation(options);
  const environment = { node_version: process.version, node_executable: process.execPath,
    skill_root: fileURLToPath(new URL('../', import.meta.url)), work_dir: location.workDir,
    credential_source: location.source, config_file: location.source === 'env' ? null : location.file };
  try {
    const active = await session(options);
    const balance = active.context.scopes?.includes('account:read') ? await active.query('balance') : null;
    return redact(envelope('doctor', { account_id: String(active.context.account_id), environment,
      data: { context: active.context, balance } }), [active.credentials.api_key]);
  } catch (error) {
    if (!(error instanceof ClientError)) throw error;
    const retryLater = error.code === 'SERVICE_RETRY_LATER';
    const missing = error.code === 'SETUP_REQUIRED';
    // 中文注释：只有缺配置才进入接入引导；权限、无效Key等保留真实错误，避免反复配置。
    const sourceOptions = location.source === 'env' ? { auth_source: 'env', api_base: options['api-base'] }
      : { config: location.file };
    const nextOperation = missing && location.source !== 'env' ? 'auth-set' : 'doctor';
    return envelope('doctor', { result_type: missing ? 'setup_required' : 'error', environment,
      // 中文注释：仅缺配置时引导账户入口；无效Key、网络故障或换号不能冒充新用户注册。
      ...(error.code === 'SETUP_REQUIRED' ? { account_url: accountEntry(options['api-base']) } : {}),
      error: { code: error.code, message: error.message },
      next_action: missing || retryLater ? { operation: nextOperation, ...sourceOptions } : null });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { positionals, values: options } = optionsFrom(argv);
  if (options.help || !positionals.length) return envelope('help', { data: help });
  if (positionals.length > (positionals[0] === 'auth' ? 2 : 1))
    fail('UNEXPECTED_POSITIONAL', '仅支持固定操作；业务参数请使用JSON文件或stdin。');
  const operation = positionals[0];
  // 中文注释：只检查实际API所需的最低版本，不将测试样本当安装白名单。
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 18 || (major === 18 && minor < 3))
    fail('NODE_VERSION_UNSUPPORTED', '最低需要Node.js 18.3.0；更高版本可直接使用，无需切换指定版本。');
  if (operation === 'doctor') return boundedOutput(await doctor(options), options);
  if (operation === 'setup-server') {
    const file = path.resolve(options['setup-file'] || '');
    const state = await readJSON(file, { privateMode: true });
    if (state.schema_version !== 1 || !state.session_id || state.status !== 'starting' ||
        Date.parse(state.expires_at) <= Date.now()) fail('INVALID_SETUP_SESSION', '配置会话无效或已过期。');
    await startSetupServer(state, file);
    return null;
  }
  if (operation === 'auth') {
    if (positionals[1] === 'set') {
      // 中文注释：先校验目标地址与存储模式，再请求输入，失败不回显Key。
      const location = configLocation(options);
      if (location.source === 'env') fail('ENV_SAVE_UNSUPPORTED', 'env模式由宿主注入，不使用auth set保存。');
      normalizeBase(options['api-base']);
      const saved = await saveCredentials(options, await readKeyInput(options));
      return envelope('auth-set', { ...saved, setup_status: 'completed' });
    }
    if (positionals[1] === 'setup') return envelope('auth-setup', await launchSetup(options));
    if (positionals[1] === 'status' && options['setup-file'])
      return envelope('auth-status', await setupStatus(path.resolve(options['setup-file'])));
    if (positionals[1] === 'status') return doctor(options);
    fail('INVALID_AUTH_COMMAND', '使用auth set、auth setup或auth status。');
  }
  if (!help.operations.includes(operation)) fail('UNKNOWN_OPERATION', '未知操作，请执行--help。');
  const active = await session(options);
  let result;
  if (operation === 'batch-init') result = envelope(operation,
    { data: await initializeBatch(await inputJSON(options), options, active) });
  else if (operation === 'batch-status') {
    if (!options['batch-file']) fail('BATCH_FILE_REQUIRED', '请指定原batch.json。');
    result = envelope(operation, { data: await batchStatus(path.resolve(options['work-dir'] || process.cwd(), options['batch-file']), active) });
  }
  else if (['context', 'balance', 'task', 'creation'].includes(operation)) {
    const input = operation === 'task' ? { task_id: options['task-id'] }
      : operation === 'creation' ? { creation_id: options['creation-id'] } : {};
    result = await readOperation(operation, input, active);
  } else if (['resolve', 'prepare'].includes(operation))
    result = await startOperation(operation, await inputJSON(options), options, active);
  else if (operation === 'resume' || operation === 'download') {
    if (options['task-id'] && options['run-file']) fail('AMBIGUOUS_RECOVERY', '原任务ID和恢复文件只选一种。');
    if (options['task-id']) {
      const adopted = await adoptTask(options['task-id'], options, active);
      result = operation === 'download' ? await downloadOperation(adopted.recovery_file, active) : adopted;
    } else result = operation === 'download' ? await downloadOperation(runFile(options), active)
      : await resumeOperation(runFile(options), options, active);
  }
  else {
    const authorization = options['authorization-file']
      ? path.resolve(options['work-dir'] || process.cwd(), options['authorization-file']) : null;
    result = await generate(operation, runFile(options), authorization, options, active);
  }
  return boundedOutput(redact(result, [active.credentials.api_key]), options);
}

// 中文注释：macOS的/var别名及符号链接启动须与模块真实路径一致，独立解压也能执行入口。
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 中文注释：只输出白名单错误，系统异常原文和堆栈可能携带路径、请求或凭据。
  main().then(result => {
    if (result) { process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = exitCode(result); }
  }).catch(error => {
    const known = error instanceof ClientError;
    const result = envelope('error', { result_type: error.code === 'SETUP_REQUIRED' ? 'setup_required' : 'error',
      recovery_file: error.recovery_file || null,
      error: { code: known ? error.code : 'CLIENT_ERROR',
        message: known ? error.message : '客户端操作失败，请保留原恢复记录并检查本机配置。' } });
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = 1;
  });
}

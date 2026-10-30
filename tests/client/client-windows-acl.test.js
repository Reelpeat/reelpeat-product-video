import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clientModule } from './client-fixture.mjs';

const { atomicJSON, readJSON, regularPath } = await clientModule('local-files.mjs');

test('Windows 混合 PowerShell 模块路径下仍保护并核验私有文件', { skip: process.platform !== 'win32' }, async t => {
  // 中文注释：模拟宿主提供的非系统模块路径，真实执行 ACL 设置与私有读取。
  const original = process.env.PSModulePath;
  const root = await mkdtemp(path.join(os.tmpdir(), 'reelpeat-acl-test-'));
  t.after(async () => {
    if (original === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = original;
    await rm(root, { recursive: true, force: true });
  });
  process.env.PSModulePath = path.join(root, 'foreign-modules');
  const directory = path.join(root, 'private');
  const file = path.join(directory, 'fixture.json');
  await atomicJSON(file, { marker: 'synthetic' });
  await regularPath(directory, { directory: true, privateMode: true });
  assert.deepEqual(await readJSON(file, { privateMode: true }), { marker: 'synthetic' });
  // 中文注释：未保护的继承目录仍须拒绝，不能为了兼容加载而跳过 ACL 检查。
  await assert.rejects(regularPath(root, { directory: true, privateMode: true }), { code: 'PRIVATE_ACL_FAILED' });
});

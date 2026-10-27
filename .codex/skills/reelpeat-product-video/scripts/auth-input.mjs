import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fail, ClientError } from './local-files.mjs';

// 中文注释：终端输入由readline处理编辑与粘贴，但吞掉回显，不将Key放进参数或stdout。
async function terminalKey(input, output) {
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input, output: silent, terminal: true, historySize: 0 });
  try {
    const answer = new Promise((resolve, reject) => {
      let received = false;
      reader.once('line', value => { received = true; resolve(value); });
      reader.once('SIGINT', () => reject(new ClientError('AUTH_INPUT_CANCELLED', '已取消Key配置，原配置不变。')));
      reader.once('close', () => {
        if (!received) reject(new ClientError('AUTH_INPUT_CANCELLED', '输入已结束，未保存Key。'));
      });
    });
    output.write('请输入个人 API Key（输入不回显，回车确认，Ctrl+C取消）：');
    return await answer;
  } finally { reader.close(); silent.end(); output.write('\n'); }
}

export async function readKeyInput(options, input = process.stdin, output = process.stderr) {
  if (input.isTTY) return terminalKey(input, output);
  if (!options.stdin) fail('KEY_INPUT_REQUIRED', '请在用户终端执行auth set，或由宿主通过--stdin传入Key。');
  let value = '';
  input.setEncoding('utf8');
  for await (const chunk of input) {
    value += chunk;
    if (Buffer.byteLength(value) > 16384) fail('INVALID_CREDENTIAL', 'Key输入过长，请只输入个人API Key。');
  }
  return value;
}

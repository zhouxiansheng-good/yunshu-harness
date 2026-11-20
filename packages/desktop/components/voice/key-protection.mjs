import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

// The command is fixed. Secret input only crosses anonymous stdin/stdout pipes;
// never argv, environment, shell interpolation, a script file or diagnostics.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String($request.value)
  $entropy = [Text.Encoding]::UTF8.GetBytes('yunshu-voice/bailian/v1')
  if ($request.operation -eq 'protect') {
    $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } elseif ($request.operation -eq 'unprotect') {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else { throw 'invalid operation' }
  [Console]::Out.Write([Convert]::ToBase64String($result))
  exit 0
} catch { exit 1 }
`;
const failure = () => Object.assign(new Error('系统密钥保护不可用'), { code: 'key-protection-failed' });
export class WindowsKeyProtection {
  constructor({ platform = process.platform, spawnProcess = spawn, timeoutMs = 15000 } = {}) {
    this.supported = platform === 'win32'; this.spawnProcess = spawnProcess; this.timeoutMs = timeoutMs;
  }
  async transform(operation, value, signal) {
    signal?.throwIfAborted();
    if (!this.supported || !Buffer.isBuffer(value) || !value.length || value.length > 24576) throw failure();
    const windows = process.env.SystemRoot || 'C:\\Windows';
    return new Promise((resolve, reject) => {
      let child, timer, finished = false, chunks = [], size = 0;
      const finish = (error, result) => {
        if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        chunks = []; if (error) { child?.kill(); reject(error); } else resolve(result);
      };
      const abort = () => finish(Object.assign(new Error('密钥操作已取消'), { code: 'key-operation-cancelled' }));
      try {
        child = this.spawnProcess(win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { SystemRoot: windows, WINDIR: windows, TEMP: process.env.TEMP ?? windows, TMP: process.env.TMP ?? windows } });
        child.on('error', () => finish(failure())); child.stdin.on('error', () => finish(failure()));
        child.stdout.on('data', chunk => { size += chunk.length; if (size > 32768) finish(failure()); else chunks.push(chunk); });
        child.on('close', code => {
          if (finished) return;
          const encoded = Buffer.concat(chunks).toString('ascii').trim(), bytes = Buffer.from(encoded, 'base64');
          if (code !== 0 || !bytes.length || bytes.toString('base64') !== encoded) finish(failure());
          else finish(null, bytes);
        });
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(failure()), this.timeoutMs);
        if (signal?.aborted) { abort(); return; }
        child.stdin.end(JSON.stringify({ operation, value: value.toString('base64') }));
      } catch { finish(failure()); }
    });
  }
  async protect(value, signal) { return (await this.transform('protect', Buffer.from(value, 'utf8'), signal)).toString('base64'); }
  async unprotect(value, signal) {
    if (typeof value !== 'string' || value.length > 32768 || Buffer.from(value, 'base64').toString('base64') !== value) throw failure();
    return (await this.transform('unprotect', Buffer.from(value, 'base64'), signal)).toString('utf8');
  }
}

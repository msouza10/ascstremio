// Impede a suspensão do computador SÓ enquanto há seed pendente ou download em
// andamento (regra 13.1 do ASC). Usa um inibidor do sistema que morre sozinho se
// este processo cair, para nunca deixar o PC preso acordado:
//   Linux    systemd-inhibit (logind)
//   macOS    caffeinate -i -w <pid>
//   Windows  SetThreadExecutionState via PowerShell (vale enquanto o script roda)
// Em contêiner não há o que inibir: a suspensão é do hospedeiro (veja o README).

const fs = require('fs');
const { spawn } = require('child_process');

const INHIBIT = '/usr/bin/systemd-inhibit';
const CAFFEINATE = '/usr/bin/caffeinate';
const WATCH = 'while kill -0 "$0" 2>/dev/null; do sleep 5; done';
const WINDOWS_SCRIPT = (pid) => [
  `$sig='[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'`,
  `$k=Add-Type -MemberDefinition $sig -Name K -Namespace W -PassThru`,
  `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [void]$k::SetThreadExecutionState(0x80000001); Start-Sleep -Seconds 30 }`,
].join('; ');

function defaultCommand(reason, pid, platform = process.platform, exists = fs.existsSync) {
  if (process.env.BRAZUKA_CONTAINER === '1') return null;
  if (platform === 'linux' && exists(INHIBIT)) {
    return [INHIBIT, ['--what=sleep', '--who=brazuka-asc', `--why=${reason}`, '--mode=block', 'sh', '-c', WATCH, String(pid)]];
  }
  if (platform === 'darwin' && exists(CAFFEINATE)) return [CAFFEINATE, ['-i', '-w', String(pid)]];
  if (platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_SCRIPT(pid)]];
  }
  return null;
}

class KeepAwake {
  constructor({ mode = 'auto', spawnImpl = spawn, available, pid = process.pid, platform = process.platform, exists = fs.existsSync } = {}) {
    this.exists = exists;
    this.mode = mode;
    this.spawn = spawnImpl;
    this.pid = pid;
    this.platform = platform;
    this.available = mode !== 'off' && (available ? available() : defaultCommand('teste', pid, platform, exists) !== null);
    this.child = null;
  }

  get active() { return Boolean(this.child); }

  update(want, reason = 'Semeando para cumprir a regra 13.1 do ASC') {
    if (!this.available) return false;
    if (want && !this.child) this.start(reason);
    else if (!want && this.child) this.stop();
    return this.active;
  }

  start(reason) {
    const command = defaultCommand(reason, this.pid, this.platform, this.exists);
    if (!command) { this.available = false; return; }
    const child = this.spawn(command[0], command[1], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => { this.child = null; this.available = false; });
    child.on('exit', () => { if (this.child === child) this.child = null; });
    this.child = child;
    console.log('[energia] suspensão bloqueada enquanto houver seed pendente');
  }

  stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try { child.kill('SIGTERM'); } catch { /* já encerrou */ }
    console.log('[energia] suspensão liberada: nada pendente');
  }
}

module.exports = { KeepAwake, defaultCommand };

import { spawn } from 'node:child_process';

export type ShResult = { code: number; stdout: string; stderr: string };

type ShOpts = { cwd?: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv };

// Sin shell: los argumentos llegan tal cual al proceso.
export function sh(cmd: string, args: string[], opts: ShOpts = {}): Promise<ShResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : undefined;
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      // 124 es la convención de timeout(1) para "lo mataron por tiempo".
      resolve({ code: code ?? (signal ? 124 : 1), stdout, stderr });
    });
    // Si el proceso termina antes de leer stdin, escribirle da EPIPE: sin este handler tumba al orquestador entero.
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input ?? '');
  });
}

export async function exec(cmd: string, args: string[], opts: ShOpts = {}): Promise<string> {
  const res = await sh(cmd, args, opts);
  if (res.code !== 0) throw new Error(`${cmd} ${args.join(' ')} → exit ${res.code}\n${tail(res.stderr || res.stdout, 2000)}`);
  return res.stdout;
}

// Solo para comandos de config/flujo.json, que escribimos nosotros. Lo que propone un agente va por sh().
export function bash(script: string, opts: ShOpts = {}): Promise<ShResult> {
  return sh('bash', ['-c', script], opts);
}

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export function tail(text: string, max = 6000): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

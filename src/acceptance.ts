import { repoDir } from './config.ts';
import type { Acceptance } from './schemas.ts';
import { sh, tail } from './sh.ts';

export type AcceptanceResult = Acceptance & { exit: number; output: string };

// Los comandos los escribe el agente del plan: se corren sin shell y solo si empiezan con un prefijo permitido.
const SHELL_CHARS = /[;&|`$<>\\\n\r]/;

export function splitCommand(cmd: string): string[] | undefined {
  const argv: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let started = false;
  for (const ch of cmd.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) argv.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) argv.push(cur);
  return argv;
}

export function commandProblem(cmd: string, allow: string[]): string | undefined {
  if (SHELL_CHARS.test(cmd)) return `\`${cmd}\` usa caracteres de shell`;
  const argv = splitCommand(cmd);
  if (!argv?.length) return `\`${cmd}\` tiene comillas sin cerrar o está vacío`;
  const ok = allow.some((prefix) => prefix.split(' ').every((word, i) => argv[i] === word));
  return ok ? undefined : `\`${cmd}\` no empieza con un comando permitido`;
}

const TEST_RUNNERS = [['npx', 'jest'], ['npx', 'vitest'], ['npm', 'test'], ['npm', 'run', 'test'], ['pnpm', 'test'], ['node', '--test']];

const ANSI = /\x1b\[[0-9;]*m/g;

// jest: «Tests:       3 passed, 3 total» · vitest: «      Tests  3 passed (3)» · node --test: «ℹ pass 3» o «# pass 3».
function passedCount(text: string): number | undefined {
  const summary = text.match(/^\s*Tests:?\s+(.+)$/m);
  if (summary) return Number(summary[1].match(/(\d+) passed/)?.[1] ?? 0);
  const node = text.match(/^(?:#|ℹ)\s*pass\s+(\d+)/m);
  return node ? Number(node[1]) : undefined;
}

// Un exit 0 de un runner de tests no alcanza: con un -t que no coincide, jest saltea todo y sale con 0.
export function silentPass(argv: string[], output: string): string | undefined {
  if (!TEST_RUNNERS.some((prefix) => prefix.every((word, i) => argv[i] === word))) return undefined;
  const text = output.replace(ANSI, '');
  const passed = passedCount(text);
  if (passed === undefined) return 'no se pudo leer cuántos tests corrieron';
  if (passed === 0) return 'no corrió ningún test';
  const filtered = argv.some((a) => a === '-t' || a.startsWith('--testNamePattern'));
  const skipped = text.match(/^\s*Test (?:Suites|Files):?.*?(\d+) skipped/m);
  if (filtered && skipped && Number(skipped[1]) > 0) return `${skipped[1]} archivo(s) no tienen ningún test con ese nombre`;
  return undefined;
}

export async function runAcceptance(items: Acceptance[]): Promise<AcceptanceResult[]> {
  const results: AcceptanceResult[] = [];
  for (const item of items) {
    const [bin, ...args] = splitCommand(item.command) ?? [];
    const res = await sh(bin, args, {
      cwd: repoDir(item.repo),
      timeoutMs: 10 * 60_000,
      env: { ...process.env, CI: 'true' },
    });
    const output = `${res.stdout}\n${res.stderr}`.trim();
    const silent = res.code === 0 ? silentPass([bin, ...args], output) : undefined;
    results.push({
      ...item,
      exit: silent ? 1 : res.code,
      output: tail(silent ? `${output}\n\n[flujo] cuenta como falla: ${silent}` : output, 4000),
    });
  }
  return results;
}

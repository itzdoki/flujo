import { relative } from 'node:path';
import { repoConfig, repoDir } from './config.ts';
import {
  branchCommits,
  changedFiles,
  checkoutBranch,
  checkoutDetached,
  currentBranch,
  fileAt,
  mergeBase,
} from './git.ts';
import { bash, sh, shellQuote, tail } from './sh.ts';

export type CheckKind = 'typecheck' | 'lint' | 'test';

export type CheckResult = { ok: boolean; report: string };

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const ESLINT = /^npx eslint\b/;
const MAX_LINES_PER_RULE = 15;

type EslintMessage = { ruleId: string | null; severity: number; line: number; message: string };
type EslintFile = { filePath: string; messages: EslintMessage[] };

// undefined si la salida no se puede leer: eso nunca cuenta como pasar.
async function eslintJson(repo: string, args: string[], input?: string): Promise<EslintFile[] | undefined> {
  const res = await sh('npx', ['eslint', '--format', 'json', ...args], {
    cwd: repoDir(repo),
    input,
    timeoutMs: 20 * 60_000,
    env: { ...process.env, CI: 'true' },
  });
  try {
    return JSON.parse(res.stdout) as EslintFile[];
  } catch {
    return undefined;
  }
}

function errorsByRule(messages: EslintMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of messages) if (m.severity === 2) counts.set(m.ruleId ?? 'parse', (counts.get(m.ruleId ?? 'parse') ?? 0) + 1);
  return counts;
}

// Solo cuentan los errores que agrega la rama. Lo que ya estaba mal en la base no se toca: reformatearlo ensucia el diff.
async function lintNewErrors(repo: string, files: string[]): Promise<CheckResult> {
  const head = await eslintJson(repo, files);
  if (!head) return { ok: false, report: '### lint: no se pudo leer la salida de eslint' };
  const base = await mergeBase(repo);
  const problems: string[] = [];
  for (const file of head) {
    const errors = file.messages.filter((m) => m.severity === 2);
    if (!errors.length) continue;
    const path = relative(repoDir(repo), file.filePath);
    const before = await fileAt(repo, base, path);
    const baseLint = before === undefined ? [] : await eslintJson(repo, ['--stdin', '--stdin-filename', path], before);
    const baseCounts = errorsByRule(baseLint?.[0]?.messages ?? []);
    for (const [rule, count] of errorsByRule(errors)) {
      const had = baseCounts.get(rule) ?? 0;
      if (count <= had) continue;
      const lines = errors
        .filter((m) => (m.ruleId ?? 'parse') === rule)
        .slice(0, MAX_LINES_PER_RULE)
        .map((m) => `  - ${path}:${m.line} ${m.message}`);
      problems.push(`- ${path}: \`${rule}\` pasó de ${had} a ${count} error(es). Los nuevos están entre estas líneas:\n${lines.join('\n')}`);
    }
  }
  if (!problems.length) return { ok: true, report: '' };
  return {
    ok: false,
    report: `### lint: errores nuevos de la rama\n\nArregla solo estos, en las líneas que tocó la rama. Los que ya estaban en la base quedan como están.\n\n${problems.join('\n')}`,
  };
}

export async function repoChecks(repo: string, kinds: CheckKind[]): Promise<CheckResult> {
  const cfg = repoConfig(repo);
  const files = (await changedFiles(repo)).filter((f) => CODE_FILE.test(f));
  const failures: string[] = [];
  for (const kind of kinds) {
    const template = cfg[kind];
    if (!template) continue;
    if (template.includes('{files}') && !files.length) continue;
    if (kind === 'lint' && ESLINT.test(template)) {
      const res = await lintNewErrors(repo, files);
      if (!res.ok) failures.push(res.report);
      continue;
    }
    const cmd = template.replace('{files}', files.map(shellQuote).join(' '));
    const res = await bash(cmd, { cwd: repoDir(repo), timeoutMs: 20 * 60_000, env: { ...process.env, CI: 'true' } });
    if (res.code !== 0) {
      failures.push(`### ${kind}: \`${cmd}\` (exit ${res.code})\n\n\`\`\`\n${tail(`${res.stdout}\n${res.stderr}`.trim())}\n\`\`\``);
    }
  }
  return { ok: failures.length === 0, report: failures.join('\n\n') };
}

export function checksMarkdown(repo: string): string {
  const cfg = repoConfig(repo);
  const kinds: CheckKind[] = ['typecheck', 'lint', 'test'];
  const rows = kinds
    .filter((k) => cfg[k])
    .map((k) => {
      const cmd = `- ${k}: \`${cfg[k]!.replace('{files}', '<archivos que tocó la rama>')}\``;
      return k === 'lint' && ESLINT.test(cfg[k]!) ? `${cmd} (solo cuentan los errores que agrega la rama)` : cmd;
    });
  return rows.length ? rows.join('\n') : '- (este repo no tiene checks configurados)';
}

// Regla del equipo: cada commit compila solo. Se verifica después de aplastar los fixups.
export async function verifyEachCommit(repo: string): Promise<CheckResult> {
  if (!repoConfig(repo).typecheck) return { ok: true, report: '' };
  const branch = await currentBranch(repo);
  const shas = await branchCommits(repo);
  try {
    // El último commit es la rama completa, que ya pasó todos los checks.
    for (const sha of shas.slice(0, -1)) {
      await checkoutDetached(repo, sha);
      const res = await repoChecks(repo, ['typecheck']);
      if (!res.ok) return { ok: false, report: `El commit ${sha.slice(0, 8)} no compila solo.\n\n${res.report}` };
    }
  } finally {
    await checkoutBranch(repo, branch);
  }
  return { ok: true, report: '' };
}

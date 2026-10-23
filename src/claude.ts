import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT, type StepName } from './config.ts';
import type { Run } from './run.ts';
import { sh, tail } from './sh.ts';

// Prohibido para todos los pasos. Deny gana sobre cualquier allow, incluido el que traiga un repo clonado.
const DENY = [
  'Bash(git push:*)',
  'Bash(git rebase:*)',
  'Bash(git reset:*)',
  'Bash(git checkout:*)',
  'Bash(git switch:*)',
  'Bash(git stash:*)',
  'Bash(git commit --amend:*)',
  'Bash(gh:*)',
  'Bash(cpln:*)',
  'Bash(gcloud:*)',
  'Bash(mariadb:*)',
  'Bash(mysql:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(ssh:*)',
  'Bash(scp:*)',
  'WebFetch',
  'WebSearch',
  'Agent',
];

export const READ_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash(rg:*)',
  'Bash(grep:*)',
  'Bash(ls:*)',
  'Bash(cd:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git grep:*)',
  'Bash(git ls-files:*)',
  'Bash(git status:*)',
];

export const WRITE_TOOLS = [
  ...READ_TOOLS,
  'Edit',
  'Write',
  'Bash(git add:*)',
  'Bash(git rm:*)',
  'Bash(git mv:*)',
  // Descartar cambios de un archivo sin `git checkout --`, que también cambia de rama y por eso está en DENY.
  'Bash(git restore:*)',
  'Bash(git commit:*)',
  'Bash(npx tsc:*)',
  'Bash(npx jest:*)',
  'Bash(npx vitest:*)',
  'Bash(npx eslint:*)',
  'Bash(npm test:*)',
  'Bash(npm run test:*)',
  'Bash(npm run typecheck:*)',
  'Bash(npm run build:*)',
  'Bash(pnpm test:*)',
  'Bash(pnpm run build:*)',
  'Bash(node --test:*)',
];

export class AgentError extends Error {
  // Límite de uso o sobrecarga: la corrida queda en pausa y el próximo poll la retoma.
  readonly limit: boolean;

  constructor(message: string, limit: boolean) {
    super(message);
    this.limit = limit;
  }
}

type ClaudeResult = {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  permission_denials?: { tool_name?: string; tool_input?: { command?: string } }[];
};

type AgentOpts = {
  run: Run;
  step: StepName;
  label: string;
  prompt: string;
  cwd: string;
  tools: string[];
  schema: object;
  addDirs?: string[];
};

const LIMIT_RE = /usage limit|rate limit|limit reached|429|529|overloaded/i;

// Un paso = un proceso nuevo de Claude Code que no recuerda nada del anterior.
export async function agent<T>(opts: AgentOpts): Promise<T> {
  const step = config().steps[opts.step];
  const args = [
    '-p',
    '--model', step.model,
    '--effort', step.effort,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(opts.schema),
    // Sin settings de usuario: no hereda sus permisos ni sus hooks.
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--allowedTools', opts.tools.join(','),
    '--disallowedTools', DENY.join(','),
    '--append-system-prompt', readFileSync(join(ROOT, 'prompts', '_base.md'), 'utf8'),
  ];
  for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);

  opts.run.log(`→ ${opts.label} (${step.model}/${step.effort})`);
  const started = Date.now();
  // Caché de 5 min y no la de 1 h que pone la suscripción: cada turno la renueva y ningún paso queda quieto 5 min,
  // así que la de 1 h solo cuesta más al escribirla (2× contra 1,25×).
  const env = { ...process.env, CLAUDE_CODE_PROMPT_CACHE_TTL: process.env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? '5m' };
  const res = await sh('claude', args, { cwd: opts.cwd, input: opts.prompt, timeoutMs: step.timeoutMin * 60_000, env });

  let parsed: ClaudeResult | undefined;
  try {
    parsed = JSON.parse(res.stdout) as ClaudeResult;
  } catch {
    parsed = undefined;
  }
  opts.run.writeJson(opts.run.nextCallLog(opts.label), {
    label: opts.label,
    model: step.model,
    effort: step.effort,
    cwd: opts.cwd,
    exit: res.code,
    prompt: opts.prompt,
    stderr: tail(res.stderr, 4000),
    result: parsed ?? tail(res.stdout, 4000),
  });
  if (parsed?.total_cost_usd) opts.run.addCost(parsed.total_cost_usd);

  if (res.code === 124) throw new AgentError(`${opts.label}: se pasó de ${step.timeoutMin} min`, false);
  if (!parsed || parsed.is_error || parsed.subtype !== 'success' || parsed.structured_output === undefined) {
    const msg = parsed?.result ?? tail(res.stderr || res.stdout, 1500);
    throw new AgentError(`${opts.label}: ${msg}`, LIMIT_RE.test(msg));
  }

  const secs = Math.round((Date.now() - started) / 1000);
  opts.run.log(`← ${opts.label} ${secs}s, ${parsed.num_turns ?? '?'} turnos, US$${(parsed.total_cost_usd ?? 0).toFixed(2)}`);
  const denied = (parsed.permission_denials ?? []).map((d) => d.tool_input?.command ?? d.tool_name ?? '?');
  if (denied.length) opts.run.log(`  denegado: ${denied.join(' | ')}`);
  return parsed.structured_output as T;
}

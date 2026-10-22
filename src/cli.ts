import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_FILE } from './config.ts';
import { withLock } from './lock.ts';
import { PHASES, poll, runIssue, type Phase } from './pipeline.ts';
import { notify } from './notify.ts';
import { addLesson } from './prompts.ts';
import { Run } from './run.ts';
import { watch } from './watch.ts';

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const USAGE = `uso:
  flujo run <ISSUE> [--until <fase>] [--fresh] [--issue-file <issue.json>]
  flujo poll
  flujo status [ISSUE]
  flujo watch <ISSUE> [--once]
  flujo lesson <paso> "<lección>"

fases: ${PHASES.join(', ')}
pasos: enrich, plan, implement, fix, review, release, qaNotes`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function status(id?: string): void {
  if (id) {
    const state = Run.peek(id);
    if (!state) {
      console.log(`no hay corrida de ${id}`);
      return;
    }
    console.log(JSON.stringify(state, null, 2));
    const log = join(Run.dirFor(id), 'run.log');
    if (existsSync(log)) console.log(`\n${readFileSync(log, 'utf8').trim().split('\n').slice(-25).join('\n')}`);
    return;
  }
  const runs = Run.all();
  if (!runs.length) console.log('no hay corridas todavía');
  for (const s of runs) {
    const detail = s.reason ?? Object.values(s.prs).join(' ');
    console.log(
      [
        s.issue.padEnd(9),
        s.status.padEnd(8),
        s.phase.padEnd(9),
        `US$${s.costUsd.toFixed(2)}`.padStart(9),
        s.updatedAt.slice(0, 16).replace('T', ' '),
        detail.split('\n')[0].slice(0, 90),
      ].join('  '),
    );
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'run': {
      const id = args[0]?.toUpperCase();
      if (!id || id.startsWith('--')) throw new Error(USAGE);
      const until = flag(args, '--until');
      if (until && !PHASES.includes(until as Phase)) throw new Error(`fase desconocida: ${until}\n\n${USAGE}`);
      await withLock(async () => {
        if (args.includes('--fresh')) Run.archive(id);
        await runIssue(id, { until: until as Phase | undefined, issueFile: flag(args, '--issue-file') });
      });
      break;
    }
    case 'poll':
      await withLock(poll);
      break;
    case 'status':
      status(args[0]?.toUpperCase());
      break;
    case 'watch': {
      const id = args[0]?.toUpperCase();
      if (!id || id.startsWith('--')) throw new Error(USAGE);
      await watch(id, { once: args.includes('--once') });
      break;
    }
    case 'lesson': {
      const [step, ...text] = args;
      if (!step || !text.length) throw new Error(USAGE);
      addLesson(step, text.join(' '));
      console.log(`lección agregada a lessons/${step}.md`);
      break;
    }
    default:
      console.log(USAGE);
      if (cmd) process.exitCode = 1;
  }
}

main().catch(async (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exitCode = 1;
  // Los errores de uso se ven en la terminal; lo que se cae corriendo solo, se avisa.
  if (msg !== USAGE && !msg.endsWith(USAGE)) await notify('flujo se cayó', msg.slice(0, 300), 'critical');
});

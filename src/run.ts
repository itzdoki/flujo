import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR } from './config.ts';

export type RunStatus = 'running' | 'blocked' | 'paused' | 'stopped' | 'failed' | 'done';

export type TaskEntry = {
  repo: string;
  title: string;
  status: 'pending' | 'done';
  shas: string[];
  notes?: string;
  deviations?: string[];
};

export type RunState = {
  issue: string;
  status: RunStatus;
  phase: string;
  reason?: string;
  // Corrida con --issue-file: no comenta en Linear, no pushea ni abre PRs.
  local: boolean;
  // Último --until pedido a mano; el timer lo respeta al retomar una pausa.
  until?: string;
  // El freno por tamaño la detuvo; la próxima corrida a mano cuenta como plan revisado.
  sizeHold?: boolean;
  bigPlanOk?: boolean;
  startedAt: string;
  updatedAt: string;
  costUsd: number;
  agentCalls: number;
  branch?: string;
  repos: string[];
  tasks: Record<string, TaskEntry>;
  pushed: string[];
  prs: Record<string, string>;
  qaPosted: boolean;
};

// Todo lo de una corrida vive en ~/.local/share/flujo/runs/<ISSUE>/ para poder retomarla y auditarla.
export class Run {
  readonly dir: string;
  state: RunState;

  private constructor(dir: string, state: RunState) {
    this.dir = dir;
    this.state = state;
  }

  static dirFor(issue: string): string {
    return join(RUNS_DIR, issue);
  }

  static peek(issue: string): RunState | undefined {
    const file = join(Run.dirFor(issue), 'state.json');
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RunState) : undefined;
  }

  static open(issue: string, local = false): Run {
    const dir = Run.dirFor(issue);
    mkdirSync(join(dir, 'calls'), { recursive: true });
    const now = new Date().toISOString();
    const state = Run.peek(issue) ?? {
      issue,
      status: 'running',
      phase: 'start',
      local,
      startedAt: now,
      updatedAt: now,
      costUsd: 0,
      agentCalls: 0,
      repos: [],
      tasks: {},
      pushed: [],
      prs: {},
      qaPosted: false,
    };
    return new Run(dir, state);
  }

  // --fresh no borra: archiva la corrida anterior para no perder sus logs.
  static archive(issue: string): void {
    const dir = Run.dirFor(issue);
    if (existsSync(dir)) renameSync(dir, `${dir}.${new Date().toISOString().replaceAll(':', '-')}`);
  }

  static all(): RunState[] {
    if (!existsSync(RUNS_DIR)) return [];
    return readdirSync(RUNS_DIR)
      .filter((name) => !name.includes('.'))
      .map((name) => Run.peek(name))
      .filter((s): s is RunState => s !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  save(): void {
    this.state.updatedAt = new Date().toISOString();
    writeFileSync(join(this.dir, 'state.json'), JSON.stringify(this.state, null, 2));
  }

  set(patch: Partial<RunState>): void {
    Object.assign(this.state, patch);
    this.save();
  }

  log(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(`[${this.state.issue}] ${msg}`);
    appendFileSync(join(this.dir, 'run.log'), `${line}\n`);
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  read(name: string): string | undefined {
    const file = this.path(name);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  }

  readJson<T>(name: string): T | undefined {
    const text = this.read(name);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  }

  write(name: string, content: string): void {
    writeFileSync(this.path(name), content);
  }

  writeJson(name: string, data: unknown): void {
    this.write(name, JSON.stringify(data, null, 2));
  }

  nextCallLog(label: string): string {
    this.state.agentCalls += 1;
    this.save();
    return join('calls', `${String(this.state.agentCalls).padStart(2, '0')}-${label}.json`);
  }

  addCost(usd: number): void {
    this.state.costUsd += usd;
    this.save();
  }
}

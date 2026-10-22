import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR =
  process.env.FLUJO_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'flujo');
export const REPOS_DIR = join(DATA_DIR, 'repos');
export const RUNS_DIR = join(DATA_DIR, 'runs');
export const ENV_FILE = join(homedir(), '.config', 'flujo', 'env');
// Los repos de cada uno viven fuera del repo de flujo: ver config/repos.example.json.
export const REPOS_FILE = join(homedir(), '.config', 'flujo', 'repos.json');

export type RepoConfig = {
  url: string;
  base: string;
  install: string;
  // {files} se reemplaza por los archivos de código que tocó la rama; sin archivos, el comando no corre.
  typecheck?: string;
  lint?: string;
  test?: string;
  notes?: string;
  // Archivos que el repo genera desde el código: los corre el flujo, no el modelo, y commitea lo que cambie.
  generate?: { cmd: string; commit: string }[];
};

export type StepName = 'enrich' | 'plan' | 'implement' | 'fix' | 'review' | 'release' | 'qaNotes';

export type StepConfig = { model: string; effort: string; timeoutMin: number };

export type Config = {
  linearLabel: string;
  maxFixRounds: number;
  reviewRounds: number;
  // Un plan más grande que esto se detiene antes de implementar hasta que una persona lo revise.
  planLimits: { maxTasks: number; maxFiles: number };
  acceptanceAllow: string[];
  steps: Record<StepName, StepConfig>;
  repos: Record<string, RepoConfig>;
};

let cached: Config | undefined;

export function config(): Config {
  if (!cached) {
    const base = JSON.parse(readFileSync(join(ROOT, 'config', 'flujo.json'), 'utf8')) as Omit<Config, 'repos'>;
    const repos = existsSync(REPOS_FILE) ? (JSON.parse(readFileSync(REPOS_FILE, 'utf8')) as Config['repos']) : {};
    cached = { ...base, repos };
  }
  return cached;
}

export function repoConfig(name: string): RepoConfig {
  const repo = config().repos[name];
  if (!repo) throw new Error(`repo desconocido: ${name} (los repos van en ${REPOS_FILE})`);
  return repo;
}

export function repoDir(name: string): string {
  return join(REPOS_DIR, name);
}

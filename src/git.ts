import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoConfig, repoDir } from './config.ts';
import { bash, exec, sh, tail } from './sh.ts';

const git = (repo: string, ...args: string[]) => exec('git', args, { cwd: repoDir(repo) });

const lines = (text: string) => text.split('\n').filter(Boolean);

export function baseRef(repo: string): string {
  return `origin/${repoConfig(repo).base}`;
}

export async function syncRepo(repo: string): Promise<void> {
  const dir = repoDir(repo);
  if (!existsSync(join(dir, '.git'))) await exec('git', ['clone', '--quiet', repoConfig(repo).url, dir]);
  else await git(repo, 'fetch', '--quiet', '--prune', 'origin');
}

// Los clones son del flujo: descartar restos de un intento cortado no pisa trabajo de nadie.
export async function resetWorkTree(repo: string): Promise<void> {
  await git(repo, 'reset', '--hard', '--quiet');
  await git(repo, 'clean', '-fdq');
}

export async function checkoutBase(repo: string): Promise<void> {
  await resetWorkTree(repo);
  await git(repo, 'checkout', '--quiet', '--detach', baseRef(repo));
}

export async function remoteBranchExists(repo: string, branch: string): Promise<boolean> {
  const res = await sh('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: repoDir(repo) });
  return res.code === 0;
}

export async function prepareBranch(repo: string, branch: string): Promise<void> {
  await resetWorkTree(repo);
  const local = await sh('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoDir(repo) });
  if (local.code === 0) await git(repo, 'checkout', '--quiet', branch);
  else await git(repo, 'checkout', '--quiet', '--no-track', '-b', branch, baseRef(repo));
}

// Reinstala solo si cambió el lockfile desde la última instalación.
export async function installDeps(repo: string): Promise<void> {
  const dir = repoDir(repo);
  const locks = ['pnpm-lock.yaml', 'package-lock.json'].map((f) => join(dir, f)).filter((f) => existsSync(f));
  if (!locks.length) return;
  const hash = createHash('sha256');
  for (const f of locks) hash.update(readFileSync(f));
  const digest = hash.digest('hex');
  const stamp = join(dir, '.git', 'flujo-install');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === digest) return;
  const res = await bash(repoConfig(repo).install, { cwd: dir, timeoutMs: 20 * 60_000 });
  if (res.code !== 0) throw new Error(`install de ${repo} falló:\n${tail(res.stdout + res.stderr, 3000)}`);
  writeFileSync(stamp, digest);
}

export async function head(repo: string): Promise<string> {
  return (await git(repo, 'rev-parse', 'HEAD')).trim();
}

export async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
}

export async function commitsSince(repo: string, sha: string): Promise<string[]> {
  return lines(await git(repo, 'rev-list', '--reverse', `${sha}..HEAD`));
}

export async function branchCommits(repo: string): Promise<string[]> {
  return lines(await git(repo, 'rev-list', '--reverse', `${baseRef(repo)}..HEAD`));
}

export async function commitSubjects(repo: string): Promise<string> {
  return (await git(repo, 'log', '--reverse', '--format=- %h %s', `${baseRef(repo)}..HEAD`)).trim();
}

export async function mergeBase(repo: string): Promise<string> {
  return (await git(repo, 'merge-base', 'HEAD', baseRef(repo))).trim();
}

// undefined si el archivo no existía en ese commit.
export async function fileAt(repo: string, sha: string, path: string): Promise<string | undefined> {
  const res = await sh('git', ['show', `${sha}:${path}`], { cwd: repoDir(repo) });
  return res.code === 0 ? res.stdout : undefined;
}

export async function changedFiles(repo: string): Promise<string[]> {
  return lines(await git(repo, 'diff', '--name-only', '--diff-filter=ACMR', `${baseRef(repo)}...HEAD`));
}

export async function branchDiff(repo: string): Promise<string> {
  return git(repo, 'diff', `${baseRef(repo)}...HEAD`);
}

export async function statusShort(repo: string): Promise<string> {
  return (await git(repo, 'status', '--short')).trim();
}

export async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, 'add', '--all');
  await git(repo, 'commit', '--quiet', '-m', message);
}

export async function checkoutDetached(repo: string, sha: string): Promise<void> {
  await git(repo, 'checkout', '--quiet', '--detach', sha);
}

export async function checkoutBranch(repo: string, branch: string): Promise<void> {
  await git(repo, 'checkout', '--quiet', branch);
}

// Aplasta los `fixup!` en el commit de su tarea para que quede un commit por lógica.
export async function autosquash(repo: string): Promise<void> {
  const cwd = repoDir(repo);
  const base = (await git(repo, 'merge-base', 'HEAD', baseRef(repo))).trim();
  const res = await sh('git', ['rebase', '--quiet', '--interactive', '--autosquash', base], {
    cwd,
    env: { ...process.env, GIT_SEQUENCE_EDITOR: 'true' },
  });
  if (res.code !== 0) {
    await sh('git', ['rebase', '--abort'], { cwd });
    throw new Error(`autosquash en ${repo} falló:\n${tail(res.stdout + res.stderr, 2000)}`);
  }
}

export async function push(repo: string, branch: string): Promise<void> {
  await git(repo, 'push', '--quiet', '--set-upstream', 'origin', branch);
}

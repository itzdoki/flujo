import { repoConfig, repoDir } from './config.ts';
import { exec, sh } from './sh.ts';

// Siempre en draft y sin reviewers: el pase a review lo decide una persona.
export async function openDraftPr(repo: string, branch: string, title: string, body: string): Promise<string> {
  const cwd = repoDir(repo);
  const existing = await sh('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url', '--jq', '.[0].url'], { cwd });
  if (existing.code === 0 && existing.stdout.trim()) return existing.stdout.trim();
  const out = await exec(
    'gh',
    ['pr', 'create', '--draft', '--base', repoConfig(repo).base, '--head', branch, '--title', title, '--body-file', '-'],
    { cwd, input: body },
  );
  return out.trim().split('\n').at(-1) ?? out.trim();
}

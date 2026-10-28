import { readFileSync, rmSync } from 'node:fs';
import { runAcceptance, commandProblem, type AcceptanceResult } from './acceptance.ts';
import { agent, AgentError, READ_TOOLS, WRITE_TOOLS } from './claude.ts';
import { checksMarkdown, repoChecks, verifyEachCommit, type CheckResult } from './checks.ts';
import { config, repoConfig, repoDir, REPOS_DIR } from './config.ts';
import * as git from './git.ts';
import { openDraftPr } from './github.ts';
import { comment, getIssue, issueMarkdown, queuedIssues, type Issue } from './linear.ts';
import { notify } from './notify.ts';
import { prompt } from './prompts.ts';
import { Run, type TaskEntry } from './run.ts';
import {
  enrichSchema,
  FIX,
  IMPLEMENT,
  planSchema,
  QA_NOTES,
  RELEASE,
  reviewSchema,
  type Enrich,
  type Finding,
  type Fix,
  type Implement,
  type Plan,
  type QaNotes,
  type Release,
  type Review,
} from './schemas.ts';
import { bash, tail } from './sh.ts';

export const PHASES = ['enrich', 'plan', 'implement', 'check', 'review', 'qa', 'release', 'qaNotes'] as const;
export type Phase = (typeof PHASES)[number];

const PR_FOOTER = '\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)';

// `resume`: la retoma el timer y vale el --until guardado. Sin `resume`, el --until de esta corrida reemplaza al guardado.
type RunOpts = { until?: Phase; issueFile?: string; resume?: boolean };

type Ctx = { run: Run; issue: Issue; spec: string; branch: string; until?: Phase };

class StopHere extends Error {}

const unique = <T>(items: T[]) => [...new Set(items)];

export async function poll(): Promise<void> {
  for (const queued of await queuedIssues(config().linearLabel)) {
    const state = Run.peek(queued.identifier);
    // `running` sin dueño es una corrida que se cortó (el lock ya es nuestro). `failed` y `stopped` esperan a una persona.
    const pending =
      !state ||
      state.status === 'paused' ||
      state.status === 'running' ||
      (state.status === 'blocked' && queued.updatedAt > state.updatedAt);
    if (!pending) continue;
    await runIssue(queued.identifier, { resume: true });
    return;
  }
  console.log('nada pendiente en la bandeja');
}

export async function runIssue(id: string, opts: RunOpts = {}): Promise<void> {
  const run = Run.open(id, Boolean(opts.issueFile));
  if (run.state.status === 'done') {
    run.log('esta corrida ya terminó; usa --fresh para repetirla');
    return;
  }
  // Si estaba bloqueada por preguntas, se vuelve a investigar con las respuestas nuevas.
  if (run.state.status === 'blocked') for (const f of ['enrich.json', 'spec.md']) rmSync(run.path(f), { force: true });
  if (!opts.resume) run.state.until = opts.until;
  if (!opts.resume && run.state.sizeHold) Object.assign(run.state, { sizeHold: false, bigPlanOk: true });
  run.set({ status: 'running', reason: undefined });
  try {
    await pipeline(run, { ...opts, until: run.state.until as Phase | undefined });
  } catch (err) {
    if (err instanceof StopHere) {
      run.set({ status: 'stopped', reason: err.message });
      run.log(`■ ${err.message}`);
      // El freno por tamaño ya avisó con su propio mensaje.
      if (!run.state.sizeHold) await notify(`${id}: detenida`, err.message);
      return;
    }
    const limit = err instanceof AgentError && err.limit;
    const reason = err instanceof Error ? err.message : String(err);
    run.set({ status: limit ? 'paused' : 'failed', reason });
    run.log(`✗ ${reason}`);
    if (limit) await notify(`${id}: pausada por límite de uso`, `se retoma sola en el próximo ciclo del timer\n${reason.slice(0, 200)}`);
    else await notify(`${id}: falló en ${run.state.phase}`, reason.slice(0, 300), 'critical');
  }
}

async function pipeline(run: Run, opts: RunOpts): Promise<void> {
  const issue = await loadIssue(run, opts.issueFile);
  const from = run.state.phase === 'start' ? '' : `\nretoma en ${run.state.phase}`;
  await notify(`${issue.identifier}: arrancó`, `${issue.title}${from}`, 'low');
  const enrich = await enrichPhase(run, issue);
  if (!enrich) return;
  const ctx: Ctx = {
    run,
    issue,
    // spec.md manda: se puede corregir a mano entre un --until y la corrida siguiente.
    spec: run.read('spec.md') ?? enrich.spec_markdown,
    branch: run.state.branch ?? (issue.branchName || `${issue.identifier.toLowerCase()}-flujo`),
    until: opts.until,
  };
  leave(ctx, 'enrich');

  await estimateBrake(ctx, enrich);
  const plan = await planPhase(ctx, enrich.repos);
  await sizeBrake(ctx, plan);
  const repos = unique(plan.tasks.map((t) => t.repo));
  await branchesPhase(ctx, repos);
  await implementPhase(ctx, plan);
  await checkPhase(ctx, repos);
  const openFindings = await reviewPhase(ctx, plan, repos);
  const results = await qaPhase(ctx, plan);
  await releasePhase(ctx, results, openFindings, repos);
  await qaNotesPhase(ctx, results, repos);

  run.set({ status: 'done', phase: 'done' });
  const prs = Object.values(run.state.prs);
  run.log(`✓ listo${prs.length ? `: ${prs.join(' ')}` : ' (modo local, nada publicado)'}`);
  await notify(`${issue.identifier} listo`, prs.length ? prs.join('\n') : 'modo local: nada publicado');
}

function enter(ctx: Ctx, phase: string): void {
  ctx.run.set({ phase });
  ctx.run.log(`== ${phase}`);
}

function leave(ctx: Ctx, phase: Phase): void {
  if (ctx.until === phase) throw new StopHere(`detenida después de ${phase} (--until)`);
}

async function loadIssue(run: Run, issueFile?: string): Promise<Issue> {
  // Una corrida local retomada sin --issue-file reusa la issue que guardó; nunca va a Linear.
  const saved = run.state.local && !issueFile ? run.readJson<Issue>('issue.json') : undefined;
  const issue =
    saved ?? (issueFile ? (JSON.parse(readFileSync(issueFile, 'utf8')) as Issue) : await getIssue(run.state.issue));
  run.writeJson('issue.json', issue);
  if (!run.state.local && !issue.assignee?.isMe) throw new Error('la issue no está asignada a ti; el flujo solo toma las tuyas');
  return issue;
}

// ── enrich ──────────────────────────────────────────────────────────────

async function enrichPhase(run: Run, issue: Issue): Promise<Enrich | undefined> {
  run.set({ phase: 'enrich' });
  run.log('== enrich');
  let enrich = run.readJson<Enrich>('enrich.json');
  if (!enrich) {
    const all = Object.keys(config().repos);
    for (const repo of all) {
      await git.syncRepo(repo);
      await git.checkoutBase(repo);
    }
    enrich = await agent<Enrich>({
      run,
      step: 'enrich',
      label: 'enrich',
      cwd: REPOS_DIR,
      tools: READ_TOOLS,
      schema: enrichSchema(all),
      prompt: prompt('enrich', { issue: issueMarkdown(issue), reposDir: REPOS_DIR, repos: repoList(all) }),
    });
    if (enrich.assumptions.length) {
      enrich.spec_markdown = `${enrich.spec_markdown.trim()}\n\n## Supuestos\n\n${enrich.assumptions.map((a) => `- ${a}`).join('\n')}\n`;
    }
    run.writeJson('enrich.json', enrich);
    run.write('spec.md', enrich.spec_markdown);
  }
  if (enrich.blocking_questions.length) {
    await block(run, issue, enrich.blocking_questions);
    return undefined;
  }
  return enrich;
}

async function block(run: Run, issue: Issue, questions: string[]): Promise<void> {
  const body = [
    '**flujo** necesita una respuesta antes de seguir:',
    '',
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    '',
    'Cuando respondas en esta issue, el flujo la retoma en el siguiente ciclo.',
  ].join('\n');
  if (run.state.local) run.write('blocked.md', body);
  else await comment(issue.id, body);
  run.set({ status: 'blocked', reason: questions.join(' / ') });
  run.log(`⏸ bloqueada con ${questions.length} pregunta(s)`);
  await notify(`${issue.identifier}: tiene preguntas`, questions.join('\n').slice(0, 300));
}

// ── plan ────────────────────────────────────────────────────────────────

async function planPhase(ctx: Ctx, repos: string[]): Promise<Plan> {
  enter(ctx, 'plan');
  let plan = ctx.run.readJson<Plan>('plan.json');
  if (!plan) {
    for (const repo of repos) {
      await git.syncRepo(repo);
      await git.checkoutBase(repo);
    }
    let retry = '';
    for (let attempt = 1; ; attempt++) {
      plan = await agent<Plan>({
        run: ctx.run,
        step: 'plan',
        label: `plan-${attempt}`,
        cwd: REPOS_DIR,
        tools: READ_TOOLS,
        schema: planSchema(repos),
        prompt: prompt('plan', {
          issue: issueMarkdown(ctx.issue),
          spec: ctx.spec,
          reposDir: REPOS_DIR,
          repos: repoList(repos),
          allow: config().acceptanceAllow.map((c) => `\`${c}\``).join(', '),
          checks: repos.map((r) => `**${r}**\n\n${checksMarkdown(r)}`).join('\n\n'),
          retry,
        }),
      });
      const problems = planProblems(plan, repos);
      if (!problems.length) break;
      if (attempt === 2) throw new Error(`el plan sigue con problemas: ${problems.join('; ')}`);
      ctx.run.log(`  el plan tiene problemas, segundo intento: ${problems.join('; ')}`);
      retry = `## Corrige esto del intento anterior\n\n${problems.map((p) => `- ${p}`).join('\n')}`;
    }
    ctx.run.writeJson('plan.json', plan);
    ctx.run.set({
      tasks: Object.fromEntries(
        plan.tasks.map((t) => [t.id, { repo: t.repo, title: t.title, status: 'pending' as const, shas: [] }]),
      ),
    });
  }
  leave(ctx, 'plan');
  return plan;
}

// Los tests no cuentan para el límite de archivos: si contaran, frenarían justo a las issues bien testeadas.
const TEST_FILE = /(^|\/)__tests__\/|\.(spec|test)\.[cm]?[jt]sx?$/;
const isTestFile = (path: string) => TEST_FILE.test(path);

// El mismo freno, pero con la estimación de enrich: frena antes de pagar el plan, que es el paso más caro.
async function estimateBrake(ctx: Ctx, enrich: Enrich): Promise<void> {
  const { maxTasks, maxFiles } = config().planLimits;
  const est = enrich.estimate;
  if (!est || ctx.run.state.bigPlanOk || ctx.run.read('plan.json') || (est.tasks <= maxTasks && est.files <= maxFiles)) return;
  const id = ctx.issue.identifier;
  const msg = `issue grande según enrich (~${est.tasks} tareas, ~${est.files} archivos sin contar tests): revisar spec.md y correr \`node src/cli.ts run ${id}\` para seguir`;
  ctx.run.set({ sizeHold: true });
  await notify(`${id}: issue grande, frenada antes del plan`, msg);
  throw new StopHere(msg);
}

// Una issue «chica» puede salir grande (7 tareas, 35 archivos): antes de gastar en implementar, que la vea una persona.
async function sizeBrake(ctx: Ctx, plan: Plan): Promise<void> {
  const { maxTasks, maxFiles } = config().planLimits;
  const files = unique(plan.tasks.flatMap((t) => t.files)).filter((f) => !isTestFile(f)).length;
  if (ctx.run.state.bigPlanOk || (plan.tasks.length <= maxTasks && files <= maxFiles)) return;
  const id = ctx.issue.identifier;
  const msg = `plan grande (${plan.tasks.length} tareas, ${files} archivos sin contar tests): revisar spec.md y plan.json y correr \`node src/cli.ts run ${id}\` para seguir`;
  ctx.run.set({ sizeHold: true });
  await notify(`${id}: plan grande, frenado antes de implementar`, msg);
  throw new StopHere(msg);
}

function planProblems(plan: Plan, repos: string[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) problems.push(`id de tarea repetido: ${task.id}`);
    ids.add(task.id);
    if (!repos.includes(task.repo)) problems.push(`${task.id} usa un repo fuera del spec: ${task.repo}`);
  }
  for (const item of plan.acceptance) {
    const problem = commandProblem(item.command, config().acceptanceAllow);
    if (problem) problems.push(`${item.id}: ${problem}`);
  }
  if (!plan.acceptance.length) problems.push('no hay criterios de aceptación ejecutables');
  return problems;
}

// ── ramas e implementación ─────────────────────────────────────────────

async function branchesPhase(ctx: Ctx, repos: string[]): Promise<void> {
  enter(ctx, 'branches');
  ctx.run.set({ repos, branch: ctx.branch });
  for (const repo of repos) {
    await git.syncRepo(repo);
    if (!ctx.run.state.pushed.includes(repo) && (await git.remoteBranchExists(repo, ctx.branch))) {
      throw new Error(`${repo}: la rama ${ctx.branch} ya existe en GitHub; el flujo no trabaja sobre ramas que no creó`);
    }
    await git.prepareBranch(repo, ctx.branch);
    await git.installDeps(repo);
  }
}

async function implementPhase(ctx: Ctx, plan: Plan): Promise<void> {
  enter(ctx, 'implement');
  for (const task of plan.tasks) {
    const entry = ctx.run.state.tasks[task.id];
    if (entry.status === 'done') continue;
    // Con commit y sin typecheck: la cortó un freno o una caída. No se vuelve a implementar, se retoma desde el typecheck.
    if (!entry.shas.length) await implementTask(ctx, plan, task, entry);
    // Antes del typecheck: sin el paquete instalado, el fix gastaría rondas en rodearlo.
    await lockBrake(ctx, task.repo);
    await ensureGreen(ctx, task.repo, `el typecheck falla después de ${task.id}`, () => repoChecks(task.repo, ['typecheck']));
    entry.status = 'done';
    ctx.run.save();
  }
  leave(ctx, 'implement');
}

async function implementTask(ctx: Ctx, plan: Plan, task: Plan['tasks'][number], entry: TaskEntry): Promise<void> {
  await git.resetWorkTree(task.repo);
  const before = await git.head(task.repo);
  const out = await agent<Implement>({
    run: ctx.run,
    step: 'implement',
    label: `implement-${task.id}`,
    cwd: repoDir(task.repo),
    tools: WRITE_TOOLS,
    schema: IMPLEMENT,
    prompt: prompt('implement', {
      taskId: task.id,
      repo: task.repo,
      branch: ctx.branch,
      base: repoConfig(task.repo).base,
      repoNotes: repoNotes(task.repo),
      taskTitle: task.title,
      taskInstructions: task.instructions,
      taskFiles: task.files.map((f) => `\`${f}\``).join(', ') || '(no indicados)',
      commitMessage: task.commit_message,
      spec: ctx.spec,
      planOutline: planOutline(plan),
      ledger: ledger(ctx),
      checks: checksMarkdown(task.repo),
    }),
  });
  const shas = await git.commitsSince(task.repo, before);
  const dirty = await git.statusShort(task.repo);
  if (!shas.length) throw new Error(`${task.id}: el implementador no dejó commit. ${out.notes}`);
  if (dirty) throw new Error(`${task.id}: quedaron cambios sin commitear:\n${dirty}`);
  if (shas.length > 1) ctx.run.log(`  ${task.id} dejó ${shas.length} commits en vez de uno`);
  Object.assign(entry, { shas, notes: out.notes, deviations: out.deviations });
  ctx.run.save();
}

async function checkPhase(ctx: Ctx, repos: string[]): Promise<void> {
  enter(ctx, 'check');
  for (const repo of repos) {
    await lockBrake(ctx, repo);
    await regenerate(ctx, repo);
    await ensureGreen(ctx, repo, 'los checks de la rama fallan', () => repoChecks(repo, ['typecheck', 'lint', 'test']));
  }
  leave(ctx, 'check');
}

// El flujo no instala paquetes: si la rama cambia dependencias, el lock lo actualiza una persona.
async function lockBrake(ctx: Ctx, repo: string): Promise<void> {
  const gap = await git.depsWithoutLock(repo);
  if (!gap) return;
  const update = gap.lock === 'pnpm-lock.yaml' ? 'pnpm install --lockfile-only' : 'npm install --package-lock-only';
  throw new StopHere(
    `${repo}: la rama cambia dependencias (${gap.deps.join(', ')}) y no actualiza \`${gap.lock}\`. ` +
      `En \`${repoDir(repo)}\`, rama \`${ctx.branch}\`: correr \`${update}\`, commitear el lock con ` +
      `\`git commit --fixup=<commit que tocó package.json>\` y correr \`node src/cli.ts run ${ctx.issue.identifier}\` para seguir`,
  );
}

// Lo generado lo corre el flujo y no el modelo: así no hace falta darle permiso de ejecutar scripts del repo.
async function regenerate(ctx: Ctx, repo: string): Promise<void> {
  for (const gen of repoConfig(repo).generate ?? []) {
    const res = await bash(gen.cmd, { cwd: repoDir(repo), timeoutMs: 10 * 60_000 });
    if (res.code !== 0) throw new Error(`${repo}: \`${gen.cmd}\` falló:\n${tail(res.stdout + res.stderr, 1500)}`);
    if (!(await git.statusShort(repo))) continue;
    await git.commitAll(repo, gen.commit);
    ctx.run.log(`  ${repo}: regenerado con \`${gen.cmd}\``);
  }
}

// Quien verifica no arregla: cada falla vuelve a un agente de fix y se verifica de nuevo, con tope de rondas.
async function ensureGreen(ctx: Ctx, repo: string, reason: string, check: () => Promise<CheckResult>): Promise<void> {
  let res = await check();
  for (let round = 1; !res.ok; round++) {
    if (round > config().maxFixRounds) {
      throw new Error(`${repo}: ${reason}, y sigue fallando después de ${round - 1} ronda(s) de fix.\n${tail(res.report, 1500)}`);
    }
    await fixAgent(ctx, repo, reason, res.report);
    res = await check();
  }
}

async function fixAgent(ctx: Ctx, repo: string, reason: string, report: string): Promise<void> {
  const before = await git.head(repo);
  const out = await agent<Fix>({
    run: ctx.run,
    step: 'fix',
    label: `fix-${ctx.run.state.phase}-${repo}`,
    cwd: repoDir(repo),
    tools: WRITE_TOOLS,
    schema: FIX,
    prompt: prompt('fix', {
      repo,
      branch: ctx.branch,
      repoNotes: repoNotes(repo),
      reason,
      report,
      ledger: ledger(ctx, repo),
      spec: ctx.spec,
      checks: checksMarkdown(repo),
    }),
  });
  const dirty = await git.statusShort(repo);
  if (dirty) throw new Error(`${repo}: el fix dejó cambios sin commitear:\n${dirty}`);
  // Un fix que agregó un paquete y no lo pudo instalar no falló: espera el lock.
  await lockBrake(ctx, repo);
  if (!out.fixed) throw new Error(`${repo}: el fix no pudo con «${reason}»: ${out.notes}`);
  const made = await git.commitsSince(repo, before);
  ctx.run.log(`  fix: ${made.length} commit(s). ${out.notes.slice(0, 200)}`);
}

// ── revisión y aceptación ──────────────────────────────────────────────

async function reviewPhase(ctx: Ctx, plan: Plan, repos: string[]): Promise<Finding[]> {
  enter(ctx, 'review');
  const saved = ctx.run.readJson<Finding[]>('open-findings.json');
  if (saved) {
    leave(ctx, 'review');
    return saved;
  }
  let open: Finding[] = [];
  let previous = '';
  for (let round = 1; round <= config().reviewRounds; round++) {
    const diffFiles: string[] = [];
    for (const repo of repos) {
      const name = `diff-${repo}.patch`;
      ctx.run.write(name, await git.branchDiff(repo));
      diffFiles.push(`- ${repo}: \`${ctx.run.path(name)}\``);
    }
    const review = await agent<Review>({
      run: ctx.run,
      // La primera vuelta busca problemas; las siguientes verifican fixes y alcanza un modelo más barato.
      step: round === 1 ? 'review' : 'reviewRecheck',
      label: `review-${round}`,
      cwd: REPOS_DIR,
      addDirs: [ctx.run.dir],
      tools: READ_TOOLS,
      schema: reviewSchema(repos, plan.tasks.map((t) => t.id)),
      prompt: prompt('review', {
        branch: ctx.branch,
        reposDir: REPOS_DIR,
        diffFiles: diffFiles.join('\n'),
        commits: await commitsMarkdown(repos),
        checks: repos.map((r) => `**${r}**\n\n${checksMarkdown(r)}`).join('\n\n'),
        spec: ctx.spec,
        planOutline: planOutline(plan),
        previous,
      }),
    });
    ctx.run.writeJson(`review-${round}.json`, review);
    const blocking = review.findings.filter((f) => f.severity !== 'minor');
    if (!blocking.length) {
      open = [];
      break;
    }
    for (const repo of unique(blocking.map((f) => f.repo))) {
      const report = blocking.filter((f) => f.repo === repo).map(findingLine).join('\n');
      await fixAgent(ctx, repo, 'la revisión de código encontró problemas', report);
      await ensureGreen(ctx, repo, 'los checks fallan después de corregir la revisión', () =>
        repoChecks(repo, ['typecheck', 'lint', 'test']),
      );
    }
    // Si no queda otra vuelta, esto sale en la PR como «corregido sin volver a revisar».
    open = blocking;
    previous = `## Lo que marcaste en la vuelta anterior (ya pasó por un fix)\n\n${blocking.map(findingLine).join('\n')}\n\nVerifica que quedó resuelto y busca problemas nuevos.`;
  }
  ctx.run.writeJson('open-findings.json', open);
  leave(ctx, 'review');
  return open;
}

async function qaPhase(ctx: Ctx, plan: Plan): Promise<AcceptanceResult[]> {
  enter(ctx, 'qa');
  let results = await runAcceptance(plan.acceptance);
  for (let round = 1; results.some((r) => r.exit !== 0); round++) {
    const failing = results.filter((r) => r.exit !== 0);
    if (round > config().maxFixRounds) {
      ctx.run.writeJson('acceptance.json', results);
      throw new Error(`criterios de aceptación que no pasan: ${failing.map((f) => f.id).join(', ')}`);
    }
    for (const repo of unique(failing.map((f) => f.repo))) {
      const report = failing
        .filter((f) => f.repo === repo)
        .map((f) => `### ${f.id}: ${f.criterion}\n\n\`${f.command}\` → exit ${f.exit}\n\n\`\`\`\n${f.output}\n\`\`\``)
        .join('\n\n');
      await fixAgent(ctx, repo, 'criterios de aceptación que no pasan', report);
      await ensureGreen(ctx, repo, 'los checks fallan después de corregir la aceptación', () =>
        repoChecks(repo, ['typecheck', 'lint', 'test']),
      );
    }
    results = await runAcceptance(plan.acceptance);
  }
  ctx.run.writeJson('acceptance.json', results);
  leave(ctx, 'qa');
  return results;
}

// ── publicación ─────────────────────────────────────────────────────────

async function releasePhase(ctx: Ctx, results: AcceptanceResult[], openFindings: Finding[], repos: string[]): Promise<void> {
  enter(ctx, 'release');
  for (const repo of repos) {
    if (ctx.run.state.prs[repo]) continue;
    if (!ctx.run.state.pushed.includes(repo)) {
      // Los fixes de la review pueden haber dejado viejo lo generado en check.
      await regenerate(ctx, repo);
      await git.autosquash(repo);
      const each = await verifyEachCommit(repo);
      if (!each.ok) throw new Error(`${repo}: ${tail(each.report, 1500)}`);
    }
    const deviations = Object.entries(ctx.run.state.tasks)
      .filter(([, t]) => t.repo === repo)
      .flatMap(([id, t]) => (t.deviations ?? []).map((d) => `- ${id}: ${d}`));
    const findings = openFindings.filter((f) => f.repo === repo);
    // El diff ya aplastado: la descripción sale de lo que quedó, no de notas escritas antes de los fixes.
    const diffName = `diff-${repo}-final.patch`;
    ctx.run.write(diffName, await git.branchDiff(repo));
    const rel = await agent<Release>({
      run: ctx.run,
      step: 'release',
      label: `release-${repo}`,
      cwd: repoDir(repo),
      addDirs: [ctx.run.dir],
      tools: READ_TOOLS,
      schema: RELEASE,
      prompt: prompt('release', {
        repo,
        diffFile: ctx.run.path(diffName),
        checksPassed: checksMarkdown(repo),
        issueId: ctx.issue.identifier,
        issueTitle: ctx.issue.title,
        spec: ctx.spec,
        commits: await git.commitSubjects(repo),
        deviations: deviations.join('\n') || '(ninguno)',
        acceptance: acceptanceMarkdown(results.filter((r) => r.repo === repo)),
        openFindings: findings.length
          ? `Se corrigieron en la última vuelta sin volver a revisar:\n${findings.map(findingLine).join('\n')}`
          : '(ninguna)',
      }),
    });
    const title = rel.title.includes(ctx.issue.identifier) ? rel.title : `${rel.title} (${ctx.issue.identifier})`;
    const body = `${rel.body.trim()}${PR_FOOTER}`;
    ctx.run.write(`pr-${repo}.md`, `# ${title}\n\n${body}\n`);
    if (ctx.run.state.local) {
      ctx.run.log(`  modo local: la PR de ${repo} quedó en pr-${repo}.md, sin publicar`);
      continue;
    }
    if (!ctx.run.state.pushed.includes(repo)) {
      await git.push(repo, ctx.branch);
      ctx.run.set({ pushed: [...ctx.run.state.pushed, repo] });
    }
    const url = await openDraftPr(repo, ctx.branch, title, body);
    ctx.run.set({ prs: { ...ctx.run.state.prs, [repo]: url } });
    ctx.run.log(`  PR en draft: ${url}`);
  }
  leave(ctx, 'release');
}

async function qaNotesPhase(ctx: Ctx, results: AcceptanceResult[], repos: string[]): Promise<void> {
  enter(ctx, 'qaNotes');
  if (!ctx.run.state.qaPosted) {
    const prs = repos.map((r) => `- ${r}: ${ctx.run.state.prs[r] ?? '(sin publicar)'}`).join('\n');
    const qa = await agent<QaNotes>({
      run: ctx.run,
      step: 'qaNotes',
      label: 'qa-notes',
      cwd: REPOS_DIR,
      tools: READ_TOOLS,
      schema: QA_NOTES,
      prompt: prompt('qaNotes', {
        issueId: ctx.issue.identifier,
        spec: ctx.spec,
        prs,
        commits: await commitsMarkdown(repos),
        acceptance: acceptanceMarkdown(results),
      }),
    });
    const body = `**flujo** dejó las PRs en draft:\n\n${prs}\n\n${qa.markdown.trim()}`;
    ctx.run.write('qa-notes.md', body);
    if (ctx.run.state.local) ctx.run.log('  modo local: el guion quedó en qa-notes.md, sin publicar');
    else await comment(ctx.issue.id, body);
    ctx.run.set({ qaPosted: true });
  }
  leave(ctx, 'qaNotes');
}

// ── material para los prompts ──────────────────────────────────────────

function repoList(repos: string[]): string {
  return repos
    .map((r) => {
      const cfg = repoConfig(r);
      return `- \`${r}\` (base \`${cfg.base}\`)${cfg.notes ? `: ${cfg.notes}` : ''}`;
    })
    .join('\n');
}

function repoNotes(repo: string): string {
  const { notes, generate } = repoConfig(repo);
  const lines = notes ? [`Notas del repo: ${notes}`] : [];
  // Sin esto, un test que avisa «archivo generado desactualizado» lleva al agente a correr el generador, que tiene denegado.
  if (generate?.length) {
    const cmds = generate.map((g) => `\`${g.cmd}\``).join(', ');
    lines.push(`Lo generado lo regenera el flujo después de implementar (${cmds}): no lo corras ni edites a mano lo que produce. Si un test falla solo porque eso quedó desactualizado, ignóralo.`);
  }
  return lines.join('\n\n');
}

function planOutline(plan: Plan): string {
  return plan.tasks.map((t) => `- ${t.id} (${t.repo}): ${t.title}`).join('\n');
}

// El libro de tareas: qué construyó cada agente y en qué commit, para que el siguiente no pise ni repita.
function ledger(ctx: Ctx, repo?: string): string {
  const rows = Object.entries(ctx.run.state.tasks)
    .filter(([, t]) => !repo || t.repo === repo)
    .map(([id, t]) => {
      if (!t.shas.length) return `- ${id} (${t.repo}) ${t.title}: pendiente`;
      const extra = [t.notes, ...(t.deviations ?? []).map((d) => `desvío: ${d}`)].filter(Boolean).join(' · ');
      return `- ${id} (${t.repo}) ${t.title}: commit ${t.shas.map((s) => s.slice(0, 10)).join(', ')}${extra ? `. ${extra}` : ''}`;
    });
  return rows.join('\n') || '(nada todavía)';
}

async function commitsMarkdown(repos: string[]): Promise<string> {
  const parts: string[] = [];
  for (const repo of repos) parts.push(`**${repo}**\n\n${(await git.commitSubjects(repo)) || '(sin commits)'}`);
  return parts.join('\n\n');
}

function acceptanceMarkdown(results: AcceptanceResult[]): string {
  if (!results.length) return '(ninguno en este repo)';
  return results
    .map((r) => `- ${r.exit === 0 ? '✅' : '❌'} ${r.id} ${r.criterion}: \`${r.command}\` (exit ${r.exit})`)
    .join('\n');
}

function findingLine(f: Finding): string {
  return `- [${f.severity}] ${f.repo}/${f.file}:${f.line} (${f.task_id}): ${f.problem} → ${f.suggestion}`;
}

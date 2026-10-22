import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, type StepName } from './config.ts';

const STEPS: StepName[] = ['enrich', 'plan', 'implement', 'fix', 'review', 'release', 'qaNotes'];

function lessonsFile(step: StepName): string {
  return join(ROOT, 'lessons', `${step}.md`);
}

export function prompt(step: StepName, vars: Record<string, string>): string {
  const template = readFileSync(join(ROOT, 'prompts', `${step}.md`), 'utf8');
  let text = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`prompt ${step}: falta {{${key}}}`);
    return value;
  });
  const file = lessonsFile(step);
  const lessons = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  if (lessons) {
    text += `\n\n## Lecciones de corridas anteriores\n\nSon correcciones que ya hizo una persona sobre este paso. Tienen prioridad sobre tu criterio.\n\n${lessons}\n`;
  }
  return text;
}

// Cada error se corrige una vez: la lección queda en el paso que se equivocó.
export function addLesson(step: string, text: string): void {
  if (!STEPS.includes(step as StepName)) throw new Error(`paso desconocido: ${step} (válidos: ${STEPS.join(', ')})`);
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync(lessonsFile(step as StepName), `- (${date}) ${text.trim()}\n`);
}

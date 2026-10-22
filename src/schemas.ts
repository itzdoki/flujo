export type Enrich = {
  spec_markdown: string;
  repos: string[];
  assumptions: string[];
  blocking_questions: string[];
};

export type PlanTask = {
  id: string;
  repo: string;
  title: string;
  instructions: string;
  files: string[];
  commit_message: string;
};

export type Acceptance = { id: string; criterion: string; repo: string; command: string };

export type Plan = { summary: string; tasks: PlanTask[]; acceptance: Acceptance[]; risks: string[] };

export type Implement = { done: boolean; notes: string; deviations: string[] };

export type Fix = { fixed: boolean; notes: string };

export type Finding = {
  severity: 'blocker' | 'major' | 'minor';
  repo: string;
  file: string;
  line: number;
  task_id: string;
  problem: string;
  suggestion: string;
};

export type Review = { verdict: 'approve' | 'changes'; findings: Finding[] };

export type Release = { title: string; body: string };

export type QaNotes = { markdown: string };

const str = { type: 'string' };
const strList = { type: 'array', items: str };

function obj(properties: Record<string, object>): object {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

function oneOf(values: string[]): object {
  return { type: 'string', enum: values };
}

export function enrichSchema(repos: string[]): object {
  return obj({
    spec_markdown: str,
    repos: { type: 'array', items: oneOf(repos), minItems: 1 },
    assumptions: strList,
    blocking_questions: strList,
  });
}

export function planSchema(repos: string[]): object {
  return obj({
    summary: str,
    tasks: {
      type: 'array',
      minItems: 1,
      items: obj({ id: str, repo: oneOf(repos), title: str, instructions: str, files: strList, commit_message: str }),
    },
    acceptance: {
      type: 'array',
      minItems: 1,
      items: obj({ id: str, criterion: str, repo: oneOf(repos), command: str }),
    },
    risks: strList,
  });
}

export const IMPLEMENT = obj({ done: { type: 'boolean' }, notes: str, deviations: strList });

export const FIX = obj({ fixed: { type: 'boolean' }, notes: str });

export function reviewSchema(repos: string[], taskIds: string[]): object {
  return obj({
    verdict: oneOf(['approve', 'changes']),
    findings: {
      type: 'array',
      items: obj({
        severity: oneOf(['blocker', 'major', 'minor']),
        repo: oneOf(repos),
        file: str,
        line: { type: 'integer' },
        task_id: oneOf(taskIds),
        problem: str,
        suggestion: str,
      }),
    },
  });
}

export const RELEASE = obj({ title: str, body: str });

export const QA_NOTES = obj({ markdown: str });

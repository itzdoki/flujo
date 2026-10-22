const API = 'https://api.linear.app/graphql';

export type Issue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string;
  updatedAt: string;
  state: { name: string; type: string };
  assignee: { id: string; name: string; isMe: boolean } | null;
  labels: { nodes: { name: string }[] };
  project: { name: string } | null;
  parent: { identifier: string; title: string; description: string | null } | null;
  children: { nodes: { identifier: string; title: string; description: string | null; state: { name: string } }[] };
  comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] };
  attachments: { nodes: { title: string; url: string }[] };
};

const ISSUE_FIELDS = `
  id identifier title description url branchName updatedAt
  state { name type }
  assignee { id name isMe }
  labels { nodes { name } }
  project { name }
  parent { identifier title description }
  children { nodes { identifier title description state { name } } }
  comments(first: 100) { nodes { body createdAt user { name } } }
  attachments { nodes { title url } }
`;

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error('falta LINEAR_API_KEY (va en ~/.config/flujo/env, ver README)');
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length) {
    throw new Error(`Linear: ${body.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`}`);
  }
  return body.data as T;
}

export async function getIssue(identifier: string): Promise<Issue> {
  const data = await gql<{ issue: Issue }>(`query ($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, {
    id: identifier,
  });
  return data.issue;
}

// La bandeja de entrada: issues asignadas a quien es dueño de la API key, con la etiqueta del flujo y abiertas.
export async function queuedIssues(label: string): Promise<{ identifier: string; updatedAt: string }[]> {
  const data = await gql<{ issues: { nodes: { identifier: string; updatedAt: string }[] } }>(
    `query ($label: String!) {
      issues(first: 25, orderBy: createdAt, filter: {
        assignee: { isMe: { eq: true } }
        labels: { some: { name: { eqIgnoreCase: $label } } }
        state: { type: { nin: ["completed", "canceled"] } }
      }) { nodes { identifier updatedAt } }
    }`,
    { label },
  );
  return data.issues.nodes;
}

export async function comment(issueId: string, body: string): Promise<void> {
  await gql(`mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, {
    input: { issueId, body },
  });
}

export function issueMarkdown(i: Issue): string {
  const indent = (s: string) => s.trim().replaceAll('\n', '\n  ');
  const lines = [
    `**${i.identifier}: ${i.title}**`,
    `Estado: ${i.state.name}${i.project ? ` · Proyecto: ${i.project.name}` : ''} · ${i.url}`,
    '',
    i.description?.trim() || '(sin descripción)',
  ];
  if (i.parent) {
    lines.push('', `### Issue padre: ${i.parent.identifier} — ${i.parent.title}`, '', i.parent.description?.trim() ?? '');
  }
  if (i.children.nodes.length) {
    lines.push('', '### Sub-issues');
    for (const c of i.children.nodes) {
      lines.push(`- ${c.identifier} [${c.state.name}] ${c.title}${c.description ? `\n  ${indent(c.description)}` : ''}`);
    }
  }
  if (i.comments.nodes.length) {
    lines.push('', '### Comentarios');
    const sorted = [...i.comments.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const c of sorted) lines.push(`- **${c.user?.name ?? 'bot'}** (${c.createdAt.slice(0, 10)}): ${indent(c.body)}`);
  }
  if (i.attachments.nodes.length) {
    lines.push('', '### Enlaces', ...i.attachments.nodes.map((a) => `- ${a.title}: ${a.url}`));
  }
  return lines.join('\n');
}

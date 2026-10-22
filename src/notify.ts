import { sh } from './sh.ts';

export type Urgency = 'low' | 'normal' | 'critical';

// Escritorio siempre; Slack solo si hay webhook configurado. Un aviso que no sale queda en el journal, nunca corta la corrida.
export async function notify(title: string, body: string, urgency: Urgency = 'normal'): Promise<void> {
  const desk = await sh('notify-send', ['--app-name=flujo', `--urgency=${urgency}`, title, body]).catch(
    (err: unknown) => ({ code: 1, stdout: '', stderr: String(err) }),
  );
  if (desk.code !== 0) console.error(`aviso de escritorio no enviado: ${desk.stderr.trim()}`);
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook) return;
  const icon = urgency === 'critical' ? ':red_circle: ' : '';
  try {
    const res = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${icon}*${title}*\n${body}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`aviso de Slack no enviado: ${res.status} ${await res.text()}`);
  } catch (err) {
    console.error(`aviso de Slack no enviado: ${err instanceof Error ? err.message : err}`);
  }
}

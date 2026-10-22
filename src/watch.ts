import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Run, type RunState } from './run.ts';

// Una fila de la tabla: una fase, una llamada al agente o una nota suelta del log.
export type LogEntry =
  | { kind: 'phase'; at: Date; phase: string }
  | { kind: 'step'; at: Date; label: string; model: string; secs?: number; turns?: string; costUsd?: number }
  | { kind: 'note'; at: Date; text: string };

// Formatos que escriben claude.ts («→ label (modelo/esfuerzo)» y «← label Ns, N turnos, US$x») y pipeline.ts («== fase»).
const LINE_RE = /^(\S+) (.*)$/;
const PHASE_RE = /^== (\S+)/;
const START_RE = /^→ (\S+) \(([^)]+)\)/;
const END_RE = /^← (\S+) (\d+)s, (\S+) turnos, US\$([\d.]+)/;

export function parseRunLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const at = new Date(m[1]);
    if (Number.isNaN(at.getTime())) continue;
    const msg = m[2];
    const phase = PHASE_RE.exec(msg);
    const start = START_RE.exec(msg);
    const end = END_RE.exec(msg);
    if (phase) entries.push({ kind: 'phase', at, phase: phase[1] });
    else if (start) entries.push({ kind: 'step', at, label: start[1], model: start[2] });
    else if (end) {
      // Cierra la última llamada abierta con esa etiqueta; si no hay (log cortado), la crea.
      const open = entries.findLast((e) => e.kind === 'step' && e.label === end[1] && e.secs === undefined);
      const done = { secs: Number(end[2]), turns: end[3], costUsd: Number(end[4]) };
      if (open?.kind === 'step') Object.assign(open, done);
      else entries.push({ kind: 'step', at, label: end[1], model: '?', ...done });
    } else entries.push({ kind: 'note', at, text: msg.trim() });
  }
  return entries;
}

const hhmm = (d: Date): string =>
  d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });

const duration = (secs: number): string =>
  secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;

export function renderRun(state: RunState, entries: LogEntry[], now: Date = new Date()): string {
  const out: string[] = [];
  const prs = Object.values(state.prs);
  out.push(
    `${state.issue}  ${state.status}  fase ${state.phase}  US$${state.costUsd.toFixed(2)}  ` +
      `${state.agentCalls} llamadas  desde ${hhmm(new Date(state.startedAt))}`,
  );
  if (state.reason) out.push(`motivo: ${state.reason.split('\n')[0]}`);
  if (prs.length) out.push(`PRs: ${prs.join(' ')}`);
  out.push('');
  out.push(['Hora ', 'Paso'.padEnd(22), 'Modelo'.padEnd(15), 'Duración'.padStart(10), 'Turnos'.padStart(7), 'Costo'.padStart(9)].join('  '));

  for (const [i, e] of entries.entries()) {
    // Fases seguidas sin pasos en el medio (lo que ya estaba hecho al retomar) van en una sola línea.
    if (e.kind === 'phase' && entries[i - 1]?.kind === 'phase') out[out.length - 1] += ` → ${e.phase}`;
    else if (e.kind === 'phase') out.push(`${hhmm(e.at)}  == ${e.phase}`);
    else if (e.kind === 'note') out.push(`${hhmm(e.at)}     ${e.text}`);
    else {
      // Solo la última llamada sin cerrar de una corrida viva está «en curso»; las demás se cortaron.
      const running = e.secs === undefined && state.status === 'running' && e === entries.findLast((x) => x.kind === 'step');
      const secs = e.secs ?? Math.round((now.getTime() - e.at.getTime()) / 1000);
      out.push(
        [
          hhmm(e.at),
          e.label.padEnd(22),
          e.model.padEnd(15),
          (e.secs !== undefined ? duration(secs) : running ? `en curso ${duration(secs)}` : 'cortada').padStart(10),
          (e.turns ?? '').padStart(7),
          (e.costUsd !== undefined ? `US$${e.costUsd.toFixed(2)}` : '').padStart(9),
        ].join('  ').trimEnd(),
      );
    }
  }
  return out.join('\n');
}

function snapshot(id: string): string | undefined {
  const state = Run.peek(id);
  if (!state) return undefined;
  const log = join(Run.dirFor(id), 'run.log');
  return renderRun(state, existsSync(log) ? parseRunLog(readFileSync(log, 'utf8')) : []);
}

// Muestra la corrida como tabla y la refresca hasta que deja de estar en curso (o una sola vez con --once).
export async function watch(id: string, opts: { once?: boolean; intervalMs?: number } = {}): Promise<void> {
  for (;;) {
    const text = snapshot(id);
    if (!text) {
      console.log(`no hay corrida de ${id}`);
      return;
    }
    const live = Run.peek(id)?.status === 'running';
    if (!opts.once && process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
    console.log(text);
    if (opts.once || !live) return;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 5000));
  }
}

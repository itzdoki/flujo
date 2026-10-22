import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

const LOCK = join(DATA_DIR, 'lock');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Una corrida a la vez: cuida los límites de la suscripción y los clones compartidos.
export async function withLock(fn: () => Promise<void>): Promise<boolean> {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8'));
    if (pid && alive(pid)) {
      console.log(`flujo ya está corriendo (pid ${pid})`);
      return false;
    }
    rmSync(LOCK, { force: true });
  }
  writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  try {
    await fn();
  } finally {
    rmSync(LOCK, { force: true });
  }
  return true;
}

// Runs the local dogs engine (server/bin/dogs.mjs serve) for the desktop app, so nobody has to start a server:
// it starts when the app opens and is restarted if it ever stops. Electron's own Node runs it
// (ELECTRON_RUN_AS_NODE), so no separate Node install is needed.
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const PORT = Number(process.env.DOGS_PORT || 8787);
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const START_TIMEOUT_MS = 20_000;
const WATCH_MS = 5_000;

let child: ChildProcess | null = null;
let watcher: NodeJS.Timeout | null = null;
let starting: Promise<void> | null = null;

function dogsHome(): string | null {
  const candidates = [process.env.DOGS_HOME];
  try {
    candidates.push(JSON.parse(readFileSync(join(__dirname, '..', 'dogs-home.json'), 'utf8')).home);
  } catch {
    // not written: dev run, fall through to the source tree
  }
  candidates.push(resolve(__dirname, '..', '..', '..', '..'));
  return candidates.find((d) => d && existsSync(join(d, 'server', 'bin', 'dogs.mjs'))) || null;
}

async function up(): Promise<boolean> {
  try {
    return (await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function start(): Promise<void> {
  if (await up()) return;
  const home = dogsHome();
  if (!home) {
    console.error('[dogs] project folder not found; set DOGS_HOME or start `dogs serve` yourself');
    return;
  }
  child = spawn(process.execPath, [join(home, 'server', 'bin', 'dogs.mjs'), 'serve'], {
    cwd: home,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('exit', () => (child = null));
  const t0 = Date.now();
  while (Date.now() - t0 < START_TIMEOUT_MS && !(await up())) await new Promise((r) => setTimeout(r, 300));
}

/** Start the engine if needed, then keep it running for as long as the app is open. */
export async function ensureDogsServer(): Promise<void> {
  starting ??= start().finally(() => (starting = null));
  await starting;
  watcher ??= setInterval(async () => {
    if (!starting && !(await up())) starting = start().finally(() => (starting = null));
  }, WATCH_MS);
}

/** Stop watching, and stop the engine if this app started it. */
export function stopDogsServer(): void {
  if (watcher) clearInterval(watcher);
  watcher = null;
  child?.kill();
  child = null;
}

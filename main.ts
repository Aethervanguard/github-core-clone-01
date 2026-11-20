// Entry lifecycle: start the forge server on an ephemeral port, register that port
// with the trial env, then wait until the env reports the trial is done.
//
// The env is reached through MAKEFUN_ENV_URL. The program talks to it in three steps:
//   1. listen(0) so the kernel picks a free port (never 8080 — the env owns it),
//   2. POST /register with the bound port, retrying until the env accepts it,
//   3. GET /done until the body reads {"done": true}, then shut down and exit 0.
// A request that fails or times out is retried with exponential backoff; the process
// only exits once the env says the trial is over (or when a contract error ends it).
//
// This file only imports the server from app.ts: no package, no Node built-in, no
// model call. The suite scores the server app.ts builds; the lifecycle just keeps
// the process alive and talking to the env until the trial ends.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Cap on how long a single request to the env may run before it is abandoned. */
const REQUEST_BUDGET_MS = 30_000;
/** Backoff between retries: start here, double each time, never pass the cap. */
const BACKOFF_START_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff after `failures` failed attempts: exponential, capped at BACKOFF_LIMIT_MS. */
function backoffFor(failures: number): number {
  const step = Math.min(failures, 8);
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_START_MS * 2 ** step);
}

async function postJson(path: string, payload: unknown): Promise<Response> {
  return fetch(`${envOrigin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
  });
}

/**
 * Tell the env which port the server bound. A 200 means the register landed and a 409
 * means another entry registered first (not ours to fix) — either way we are done.
 * A 400 or 405 is a contract error and ends the program; anything else is retried,
 * because the env may still be starting.
 */
async function registerPort(port: number): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const response = await postJson('/register', { port });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

/** Ask the env whether the trial is over; return only once it answers {"done": true}. */
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const response = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // No answer yet, or the poll timed out: the trial is not done, so ask again.
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

/** Boot the server, register its port, wait for the env, then shut down. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

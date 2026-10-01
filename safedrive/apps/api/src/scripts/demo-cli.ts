/* eslint-disable no-console -- CLI output */
/**
 * Runs a demo scenario against a running API, exactly like a client would:
 *   API_URL=http://localhost:4000 DEMO_EMAIL=... DEMO_PASSWORD=... npm run demo -- full 5
 * The account is created on first use. Everything it produces is flagged is_demo.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const email = process.env.DEMO_EMAIL;
const password = process.env.DEMO_PASSWORD;
const [scenarioId = 'full', speed = '5'] = process.argv.slice(2);

async function req<T>(path: string, method: string, body: unknown, token?: string): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => null)) as T & { message?: string };
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${data?.message ?? ''}`);
  return data;
}

async function main(): Promise<void> {
  if (!email || !password)
    throw new Error('Set DEMO_EMAIL and DEMO_PASSWORD (a parent account to own the demo family)');
  let session: { accessToken: string };
  try {
    session = await req('/auth/login', 'POST', { email, password });
  } catch {
    session = await req('/auth/register', 'POST', {
      email,
      password,
      displayName: 'Demo parent',
      locale: 'he',
    });
  }
  const tok = session.accessToken;
  const fam = await req<{ familyId: string; driverId: string }>('/demo/families', 'POST', {}, tok);
  const run = await req<{ id: string; tripId: string }>(
    '/demo/runs',
    'POST',
    { driverId: fam.driverId, scenarioId, speedFactor: Number(speed) },
    tok,
  );
  console.log(
    `Demo run ${run.id} - trip ${run.tripId} (scenario ${scenarioId}, x${speed}). Open the web app to watch it live.`,
  );
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const runs = await req<Array<{ id: string; status: string; progress: number; error?: string }>>(
      '/demo/runs',
      'GET',
      undefined,
      tok,
    );
    const r = runs.find((x) => x.id === run.id);
    if (!r) break;
    process.stdout.write(`\r${r.status} ${r.progress}%   `);
    if (r.status !== 'running') {
      console.log(r.error ? `\n${r.error}` : '\ndone');
      break;
    }
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});

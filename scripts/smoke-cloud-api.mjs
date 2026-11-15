import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { authorized: { type: 'boolean' }, owner: { type: 'boolean' } },
});
const [rawUrl, origin] = positionals;
if (!rawUrl || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin ?? '')) {
  throw new Error('Usage: node scripts/smoke-cloud-api.mjs https://API_DOMAIN chrome-extension://ID [--authorized] [--owner]');
}
const base = new URL(rawUrl);
if (base.protocol !== 'https:' || (rawUrl !== base.origin && rawUrl !== base.origin + '/')) {
  throw new Error('Use the exact HTTPS origin of the API deployment.');
}

const token = process.env.MOODSHIFT_SMOKE_TOKEN;
if (values.authorized && !/^[A-Za-z0-9_-]{32,128}$/.test(token ?? '')) {
  throw new Error('Set MOODSHIFT_SMOKE_TOKEN to the private demo code in the environment for the authorized check.');
}
const request = (path, options = {}) => fetch(new URL(path, base), {
  ...options, redirect: 'error', signal: AbortSignal.timeout(18_000),
});
const health = await request('/health');
assert.equal(health.status, 200, 'Expected a successful health check');
const status = await health.json();
assert.equal(status.ok, true, 'The API did not report healthy');
assert.equal(typeof status.aiConfigured, 'boolean');
console.log('Health is reachable. Gemini key configured:', status.aiConfigured);

const preflight = await request('/api/interpret', {
  method: 'OPTIONS',
  headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' },
});
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
assert.match(preflight.headers.get('Access-Control-Allow-Headers') ?? '', /Authorization/i);

const post = (path, body, headers = {}) => request(path, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
assert.equal((await post('/api/interpret', {})).status, 401);
assert.equal((await post('/api/interpret', {}, { Origin: 'https://invalid.example' })).status, 403);
console.log('Expected CORS and unauthorized rejection passed.');

if (values.authorized) {
  const auth = { Authorization: `Bearer ${token}` };
  const response = await post('/api/interpret', {
    prompt: 'A little more bass. Keep the current reverb.',
    currentEffects: {
      bassDb: 0, trebleDb: 0, highpassHz: 20, lowpassHz: 20000, reverbMix: 0.1,
      delayMs: 0, delayMix: 0, delayFeedback: 0, distortion: 0, outputGainDb: 0,
    },
    audioFeatures: { rms: 0, bassEnergy: 0, midEnergy: 0, trebleEnergy: 0, brightness: 0, isSilent: true },
  }, auth);
  assert.equal(response.status, 200, 'The authorized Gemini request failed');
  const result = await response.json();
  assert.equal(result.mode, 'patch');
  assert.ok(result.patch?.bassDb > 0 && !Object.hasOwn(result.patch, 'reverbMix'));
  if (!values.owner) {
    const memory = await post('/api/memory', { action: 'view', installationId: '48d6a9cd-bb63-4a3f-8036-1ca90c718c50' }, auth);
    assert.equal(memory.status, 403, 'Shared demo must refuse memory access');
  }
  console.log('Live authorized Gemini patch passed.');
}

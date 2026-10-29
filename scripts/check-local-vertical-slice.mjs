const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? 'http://127.0.0.1:4001';
const gatewayUrl = process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000';
const modelUrl = process.env.MODEL_URL ?? 'http://127.0.0.1:4010';
const serviceToken = process.env.SERVICE_TOKEN ?? 'local-service-token';

const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

async function request(url, init) {
  try {
    if(url.startsWith(controlPlaneUrl))init={...init,headers:{authorization:`Bearer ${serviceToken}`,...init?.headers}};
    return await fetch(url, init);
  } catch (error) {
    failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function json(response) {
  return response ? response.json() : null;
}

const services = [
  ['control-plane', `${controlPlaneUrl}/api/v1/calls`],
  ['gateway-sim', `${gatewayUrl}/health`],
  ['test-model', `${modelUrl}/health`],
];
for (const [name, url] of services) {
  const response = await request(url);
  assert(response?.ok, `${name} health check did not return 2xx`);
}

const controlHealthResponse = await request(`${controlPlaneUrl}/health`);
const controlHealth = await json(controlHealthResponse);
assert(controlHealthResponse?.ok, 'control-plane dependency health did not return 2xx');
assert(controlHealth?.database === 'up' || controlHealth?.database === 'memory', 'control-plane store was not ready');
assert(controlHealth?.cache === 'up' || controlHealth?.cache === 'disabled', 'Redis dependency health was unexpected');

const credentialResponse = await request(`${controlPlaneUrl}/internal/v1/policy/credentials/resolve`, {
  method: 'POST',
  headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ apiKey: 'local-employee-key' }),
});
const credential = await json(credentialResponse);
assert(credentialResponse?.ok, 'control-plane credential resolution did not return 2xx');
assert(credential?.credentialId === 'credential-demo-001', 'API key was not resolved by the control plane');

for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173']) {
  const response = await request(`${gatewayUrl}/v1/chat/completions`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type,idempotency-key',
    },
  });
  assert(response?.status === 204, `CORS preflight failed for ${origin}`);
  assert(response?.headers.get('access-control-allow-origin') === origin, `CORS origin mismatch for ${origin}`);
}

const beforeQuotaResponse = await request(`${controlPlaneUrl}/api/v1/calls/quota`);
const beforeQuota = await json(beforeQuotaResponse);
const authHeaders = {
  authorization: 'Bearer local-employee-key',
  'content-type': 'application/json',
  origin: 'http://127.0.0.1:5173',
};

const nonStreamResponse = await request(`${gatewayUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { ...authHeaders, 'idempotency-key': `check-nonstream-${crypto.randomUUID()}` },
  body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'local check' }] }),
});
const nonStream = await json(nonStreamResponse);
assert(nonStreamResponse?.status === 200, 'non-stream request did not return 200');
assert(nonStream?.usage?.prompt_tokens > 0, 'non-stream usage was not collected');

const streamResponse = await request(`${gatewayUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { ...authHeaders, 'idempotency-key': `check-stream-${crypto.randomUUID()}` },
  body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'local stream check' }], stream: true }),
});
const stream = streamResponse ? await streamResponse.text() : '';
assert(streamResponse?.status === 200, 'stream request did not return 200');
assert(stream.includes('data: [DONE]'), 'stream response did not end with [DONE]');
assert(stream.includes('"prompt_tokens":13'), 'stream usage event was not collected');

const deniedResponse = await request(`${gatewayUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { ...authHeaders, 'idempotency-key': `check-denied-${crypto.randomUUID()}` },
  body: JSON.stringify({ model: 'unknown-model', messages: [{ role: 'user', content: 'denied' }] }),
});
const denied = await json(deniedResponse);
assert(deniedResponse?.status === 403, 'unknown model was not denied before upstream');
assert(denied?.error?.code === 'model_not_open', 'unknown model reasonCode was not preserved');

const unauthorizedResponse = await request(`${gatewayUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
  body: JSON.stringify({ model: 'test-model', messages: [] }),
});
assert(unauthorizedResponse?.status === 401, 'invalid API key was not rejected');

const syncResponse = await request(`${controlPlaneUrl}/internal/v1/gateway-sync`, {
  method: 'POST',
  headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    provider: 'higress',
    resourceType: 'model_route',
    resourceId: 'local-check-route',
    desiredVersion: `check-${Date.now()}`,
    previousVersion: null,
    idempotencyKey: `check-sync-${crypto.randomUUID()}`,
    spec: { model: 'test-model' },
  }),
});
const sync = await json(syncResponse);
assert(syncResponse?.status === 202, 'gateway sync did not return 202');
assert(sync?.status === 'rejected' && sync?.errorCode === 'provider_unconfigured', 'unconfigured HigressProvider must reject publication');

const afterQuotaResponse = await request(`${controlPlaneUrl}/api/v1/calls/quota`);
const afterQuota = await json(afterQuotaResponse);
const expectedQuota = Math.round((Number(beforeQuota?.availableAmount) - 0.04) * 100) / 100;
const actualQuota = Math.round(Number(afterQuota?.availableAmount) * 100) / 100;
assert(actualQuota === expectedQuota, 'two successful requests did not settle two reservations');

const callsResponse = await request(`${controlPlaneUrl}/api/v1/calls`);
const calls = await json(callsResponse);
const successIds=[nonStreamResponse?.headers.get('x-request-id'),streamResponse?.headers.get('x-request-id')];
const recent = Array.isArray(calls?.data) ? calls.data.filter(call=>successIds.includes(call.requestId)) : [];
assert(recent.length === 2 && recent.every((call) => call.billableState === 'confirmed' && call.inputTokens > 0 && call.outputTokens > 0), 'call logs did not contain confirmed token usage');
assert(Array.isArray(calls?.data)&&calls.data.some(call=>call.requestId===denied?.requestId&&call.outcome==='rejected_before_upstream'&&call.errorCode==='model_not_open'&&call.forwarded===false),'policy refusal log or forwarding state is missing');

if (failures.length) {
  console.error('Local vertical slice check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Local vertical slice check passed: health, CORS, non-stream, SSE, deny, auth, sync, quota, and call logs.');
}

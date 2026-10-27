import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { VerificationRun } from '@ai-gateway/contracts';
import { summarizeVerification } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { PlatformService } from './platform.service';
import { verificationCost, verificationPrice } from './verification';

const operator = 'operator-demo-001';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function harness(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const ledger = new DemoStore();
  const repository = new WorkspaceRepository(ledger);
  await repository.initialize();
  const platform = new PlatformService(repository, ledger);
  const service = (await repository.read()).services[0];
  await repository.transact(async tx => {
    const current = tx.state.services.find(value => value.id === service.id)!;
    current.baseUrl = `http://127.0.0.1:${port}`;
    current.configVersion += 1;
    current.verification = 'unverified';
    current.verificationMessage = '';
    current.mappings[0].upstreamModel = 'upstream-validation-model';
    Object.assign(current.mappings[0], { inputPrice: 2, outputPrice: 3, cachedInputPrice: 0.5 });
  });
  return { ledger, repository, platform, serviceId: service.id };
}

const completion = (usage: unknown) => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage });

describe('platform connection verification metering', () => {
  it('records per-mapping evidence and internal cost without touching business quota or call statistics', async () => {
    let requests = 0;
    const h = await harness((_request, response) => {
      requests++;
      response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': `upstream-${requests}` });
      response.end(completion({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } }));
    });
    const balances = structuredClone([...h.ledger.quotaBatches.values()]);
    const result = await h.platform.verifyService(operator, h.serviceId, { idempotencyKey: 'verify-key-1' });
    expect(result.verification).toBe('passed');
    expect(result.verificationApplied).toBe(true);
    const run = result.verificationRun as VerificationRun;
    expect(run.state).toBe('completed');
    expect(run.diagnostic).toBe(true);
    expect(run.results[0].upstreamRequestId).toBe('upstream-1');
    expect(run.results[0].usage).toEqual({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, complete: true });
    // (80 * 2 + 10 * 3 + 20 * 0.5) micro-CNY per million tokens
    expect(run.results[0].cost.amount).toBe(0.0002);
    expect(summarizeVerification(run).internalCost).toBe(0.0002);
    expect(h.ledger.callLogs).toHaveLength(0);
    expect([...h.ledger.quotaBatches.values()]).toEqual(balances);

    const replay = await h.platform.verifyService(operator, h.serviceId, { idempotencyKey: 'verify-key-1' });
    expect(replay.replayed).toBe(true);
    expect(requests).toBe(1);
  });

  it('distinguishes unknown usage, unknown price and authentication failures', async () => {
    let mode: 'unknown-price' | 'no-usage' | 'auth' = 'no-usage';
    const h = await harness((_request, response) => {
      if (mode === 'auth') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'denied' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(mode === 'unknown-price' ? completion({ prompt_tokens: 5, completion_tokens: 1 }) : JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
    const noUsage = await h.platform.verifyService(operator, h.serviceId, { idempotencyKey: 'verify-no-usage' });
    const noUsageRun = noUsage.verificationRun as VerificationRun;
    expect(noUsageRun.results[0].cost.state).toBe('usage_unknown');
    expect(noUsageRun.results[0].cost.amount).toBeNull();
    expect(summarizeVerification(noUsageRun).internalCost).toBeNull();

    await h.repository.transact(async tx => {
      const mapping = tx.state.services[0].mappings[0];
      Object.assign(mapping, { inputPrice: null, outputPrice: null, cachedInputPrice: null });
    });
    mode = 'unknown-price';
    const unknownPrice = await h.platform.verifyService(operator, h.serviceId, { idempotencyKey: 'verify-unknown-price' });
    const unknownPriceRun = unknownPrice.verificationRun as VerificationRun;
    expect(unknownPriceRun.results[0].cost.state).toBe('price_unknown');
    expect(summarizeVerification(unknownPriceRun).internalCost).toBeNull();
    expect(unknownPrice.verification).toBe('passed');
    expect(unknownPrice.verificationMessage).toContain('成本未知');

    mode = 'auth';
    const failed = await h.platform.verifyService(operator, h.serviceId, { idempotencyKey: 'verify-auth' });
    const failedRun = failed.verificationRun as VerificationRun;
    expect(failedRun.results[0].outcome).toBe('failed');
    expect(failedRun.results[0].errorCode).toBe('auth_failed');
    expect(failed.verification).toBe('failed');
    expect(failed.verificationMessage).toContain('鉴权失败');
  });

  it('allows one running verification per service and expires crashed leases without resending', async () => {
    const h = await harness((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(completion({ prompt_tokens: 1, completion_tokens: 1 }));
    });
    const service = (await h.repository.read()).services[0];
    const started = await h.ledger.startVerification({
      serviceId: h.serviceId, serviceName: service.name, operatorId: operator, configVersion: service.configVersion,
      mappings: [{ definitionId: service.mappings[0].definitionId, upstreamModel: service.mappings[0].upstreamModel, inputPrice: 1, outputPrice: 1, cachedInputPrice: 1, attemptedAt: null }],
      idempotencyKey: 'lease-first',
    });
    await expect(h.platform.verifyService(operator, h.serviceId, { idempotencyKey: 'lease-second' })).rejects.toThrow('already running');
    const stale = h.ledger.verificationRuns.find(run => run.id === started.run.id)!;
    stale.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    const recoveredReplay = await h.ledger.startVerification({
      serviceId: h.serviceId, serviceName: service.name, operatorId: operator, configVersion: service.configVersion,
      mappings: stale.mappings, idempotencyKey: 'lease-first',
    });
    expect(recoveredReplay.replayed).toBe(true);
    expect(recoveredReplay.run.state).toBe('interrupted');
    const next = await h.ledger.startVerification({
      serviceId: h.serviceId, serviceName: service.name, operatorId: operator, configVersion: service.configVersion,
      mappings: stale.mappings, idempotencyKey: 'lease-third',
    });
    expect(stale.state).toBe('interrupted');
    expect(next.run.state).toBe('running');
  });

  it('never writes a result when replaying a still-running verification', async () => {
    const h = await harness((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(completion({ prompt_tokens: 1, completion_tokens: 1 }));
    });
    const service = (await h.repository.read()).services[0];
    await h.ledger.startVerification({
      serviceId: h.serviceId, serviceName: service.name, operatorId: operator, configVersion: service.configVersion,
      mappings: [{ definitionId: service.mappings[0].definitionId, upstreamModel: service.mappings[0].upstreamModel, inputPrice: 1, outputPrice: 1, cachedInputPrice: 1, attemptedAt: null }],
      idempotencyKey: 'running-replay',
    });
    const replay = await h.platform.verifyService(operator, h.serviceId, { idempotencyKey: 'running-replay' });
    expect(replay.replayed).toBe(true);
    expect(replay.verificationApplied).toBe(false);
    expect((await h.repository.read()).services[0].verification).toBe('unverified');
  });

  it('does not mark a changed configuration as passed when an old run is replayed', async () => {
    const h = await harness((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(completion({ prompt_tokens: 1, completion_tokens: 1 }));
    });
    await h.platform.verifyService(operator, h.serviceId, { idempotencyKey: 'config-key' });
    await h.repository.transact(async tx => {
      const current = tx.state.services[0];
      current.configVersion += 1;
      current.verification = 'unverified';
      current.verificationMessage = '连接配置已变更，需要重新验证';
    });
    const replay = await h.platform.verifyService(operator, h.serviceId, { idempotencyKey: 'config-key' });
    expect(replay.replayed).toBe(true);
    expect(replay.verificationApplied).toBe(false);
    const current = (await h.repository.read()).services[0];
    expect(current.verification).toBe('unverified');
  });

  it('pages verification history newest-first and enforces operator access', async () => {
    const h = await harness((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(completion({ prompt_tokens: 1, completion_tokens: 1 }));
    });
    await h.platform.verifyService(operator, h.serviceId, { idempotencyKey: 'history-one' });
    await h.platform.verifyService(operator, h.serviceId, { idempotencyKey: 'history-two' });
    const page = await h.platform.verificationHistory(operator, h.serviceId, { limit: '1' });
    expect(page.items).toHaveLength(1);
    expect(page.nextBefore).toBeTruthy();
    const older = await h.platform.verificationHistory(operator, h.serviceId, { limit: '1', before: page.nextBefore! });
    expect(older.items[0].id).not.toBe(page.items[0].id);
    await expect(h.platform.verificationHistory('employee-demo-001', h.serviceId, {})).rejects.toThrow();
    await expect(h.platform.verificationHistory(operator, 'missing-service', {})).rejects.toThrow();
  });

  it('treats a zero price as a priced cost and never invents zero for unknown usage', () => {
    const price = verificationPrice('service', 1, { definitionId: 'definition', upstreamModel: 'model', inputPrice: 0, outputPrice: 0, cachedInputPrice: 0 });
    expect(price).not.toBeNull();
    expect(verificationCost(price, { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 })).toMatchObject({ state: 'priced', amount: 0 });
    expect(verificationCost(null, { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 })).toMatchObject({ state: 'price_unknown', amount: null });
    expect(verificationCost(price, null)).toMatchObject({ state: 'usage_unknown', amount: null });
    expect(verificationPrice('service', 1, { definitionId: 'definition', upstreamModel: 'model', inputPrice: null, outputPrice: 1, cachedInputPrice: 1 })).toBeNull();
  });
});

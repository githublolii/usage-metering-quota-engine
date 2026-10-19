import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch, Agent, setGlobalDispatcher } from 'undici';
import { createApp } from '../../src/app.js';

/**
 * Shared test harness: per-file ephemeral HTTP server + typed API helpers.
 *
 * Transport: concurrency suites fire hundreds of requests in parallel.
 * Node's global fetch opens one socket per request, and OS accept queues
 * refuse very large simultaneous bursts (ECONNREFUSED at ~250 on loopback).
 * A bounded Agent keeps every request in flight while reusing a fixed
 * socket set — the storms stress the ENGINE, not the TCP stack.
 */
setGlobalDispatcher(new Agent({ connections: 200, pipelining: 1 }));

export interface TestServer {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

export interface TestAccount {
  readonly accountId: string;
  readonly apiKey: string;
}

export async function provisionAccount(
  baseUrl: string,
  planName = 'Starter',
): Promise<TestAccount> {
  const response = await undiciFetch(`${baseUrl}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `test-${randomUUID()}`, planName }),
  });
  const body = (await response.json()) as {
    account?: { id: string };
    apiKey?: string;
  };
  if (response.status !== 201 || body.account === undefined || body.apiKey === undefined) {
    throw new Error(`Account provisioning failed: HTTP ${response.status}`);
  }
  return { accountId: body.account.id, apiKey: body.apiKey };
}

export interface ApiResponse<T = any> {
  readonly status: number;
  readonly body: T;
  readonly replayed: boolean;
  readonly problem?: {
    readonly title?: string;
    readonly detail?: string;
    readonly status?: number;
    readonly errors?: Array<{ path: string; message: string }>;
  };
}

export async function apiCall(
  baseUrl: string,
  method: string,
  path: string,
  apiKey: string | null,
  body?: unknown,
): Promise<ApiResponse> {
  const response = await undiciFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(apiKey !== null ? { 'x-api-key': apiKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => null)) as any;
  return {
    status: response.status,
    body: parsed,
    replayed: response.headers.get('x-idempotent-replay') === 'true',
    problem: parsed?.title !== undefined && parsed?.status !== undefined ? parsed : undefined,
  };
}

export async function createUser(
  baseUrl: string,
  apiKey: string,
  userId: string,
  planName = 'Basic',
): Promise<void> {
  const response = await apiCall(baseUrl, 'POST', '/users', apiKey, {
    userId,
    planName,
  });
  if (response.status !== 201) {
    throw new Error(`User creation failed for "${userId}": HTTP ${response.status}`);
  }
}

export function consumeBody(
  userId: string,
  units: number,
  requestId: string = randomUUID(),
): { userId: string; units: number; requestId: string } {
  return { userId, units, requestId };
}

export async function consume(
  baseUrl: string,
  apiKey: string,
  body: { userId: string; units: number; requestId: string },
): Promise<ApiResponse> {
  return apiCall(baseUrl, 'POST', '/metering/consume', apiKey, body);
}

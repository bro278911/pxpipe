/**
 * The main pxpipe proxy doubles as the warp CONNECT proxy, so one fixed port
 * can be named in HTTPS_PROXY for every agent on the machine. These cover the
 * two seams that wiring adds: which requests get handed to the forward proxy
 * instead of the dashboard router, and whether the handlers actually tunnel.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createServer as createTcpServer, connect as netConnect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWarpHandlerSet, isForwardProxyRequest } from '../src/warp/index.js';
import { routeDestination } from '../src/warp/route.js';

const caDir = mkdtempSync(join(tmpdir(), 'pxpipe-warp-serve-'));
afterAll(() => rmSync(caDir, { recursive: true, force: true }));

describe('isForwardProxyRequest', () => {
  it('leaves origin-form requests to the normal router', () => {
    expect(isForwardProxyRequest('/v1/messages')).toBe(false);
    expect(isForwardProxyRequest('/')).toBe(false);
    expect(isForwardProxyRequest('/api/stats.json')).toBe(false);
  });

  it('claims absolute-form requests, which only a forward proxy receives', () => {
    expect(isForwardProxyRequest('http://api.anthropic.com/v1/messages')).toBe(true);
    expect(isForwardProxyRequest('https://api.anthropic.com/v1/messages')).toBe(true);
  });

  it('is case-insensitive on the scheme', () => {
    expect(isForwardProxyRequest('HTTP://api.anthropic.com/v1/messages')).toBe(true);
  });

  it('treats a protocol-relative path as origin-form, not a proxy request', () => {
    // `//evil.test/x` is a legal request target; reading it as absolute-form
    // would hand an ordinary path to the forward proxy.
    expect(isForwardProxyRequest('//evil.test/x')).toBe(false);
  });

  it('handles a missing url', () => {
    expect(isForwardProxyRequest(undefined)).toBe(false);
  });
});

describe('createWarpHandlerSet', () => {
  it('routes the inference path back into the pxpipe port it was given', () => {
    const { routes } = createWarpHandlerSet({ port: 47821, caDir });
    const target = routeDestination(routes[routes.length - 1]!);
    expect(target).toBe('http://127.0.0.1:47821');
  });

  it('puts operator routes ahead of the built-in Anthropic rule', () => {
    const { routes } = createWarpHandlerSet({
      port: 47821,
      routes: ['127.0.0.1:9090/v1/*=http://127.0.0.1:47821'],
      caDir,
    });
    expect(routes).toHaveLength(2);
    expect(routeDestination(routes[0]!)).toBe('http://127.0.0.1:47821');
  });

  it('mints a CA under the directory it is given, not the home directory', () => {
    const { ca } = createWarpHandlerSet({ port: 47821, caDir });
    expect(ca.certPath.startsWith(caDir)).toBe(true);
  });
});

describe('CONNECT on the main server', () => {
  it('tunnels a host no route matches, so non-agent traffic still works', async () => {
    // A local echo stands in for the real upstream: the tunnel is what is
    // under test, and reaching the network would make this suite flaky.
    const echo = createTcpServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const echoPort = (echo.address() as { port: number }).port;

    const { handlers } = createWarpHandlerSet({ port: 47821, caDir });
    const proxy = createServer(handlers.handleAbsoluteForm);
    proxy.on('connect', handlers.handleConnect);
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as { port: number }).port;

    const reply = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(proxyPort, '127.0.0.1', () => {
        socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\n`);
      });
      let seenEstablished = false;
      let out = '';
      socket.on('data', (chunk) => {
        out += chunk.toString();
        if (!seenEstablished && out.includes('\r\n\r\n')) {
          seenEstablished = true;
          expect(out).toContain('200 Connection established');
          out = '';
          socket.write('ping');
          return;
        }
        if (seenEstablished && out.length >= 4) {
          socket.destroy();
          resolve(out);
        }
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('tunnel timed out')), 5000).unref();
    });

    expect(reply).toBe('ping');
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });
});

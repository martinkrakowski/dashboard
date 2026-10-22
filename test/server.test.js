import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, defaultApiUrl } from '../src/server.js';

const TOKEN = 'test-token';

const INGRESSROUTE = {
  metadata: {
    namespace: 'apps',
    name: 'my-app',
    annotations: {
      'dashboard.krakowski.cloud/section': 'Apps',
      'dashboard.krakowski.cloud/name': 'My App',
      'dashboard.krakowski.cloud/icon': 'fa-cube',
    },
  },
  spec: {
    entryPoints: ['websecure'],
    routes: [{ match: 'Host(`my.example.com`)' }],
  },
};

const INGRESS = {
  metadata: {
    namespace: 'apps',
    name: 'other',
    annotations: {
      'dashboard.krakowski.cloud/section': 'Data',
      'dashboard.krakowski.cloud/description': 'database ui',
    },
  },
  spec: {
    tls: [{}],
    rules: [{ host: 'db.example.com' }],
  },
};

const EXPECTED = {
  Apps: [
    {
      name: 'My App',
      type: 'Service',
      icon: 'fa-cube',
      description: '',
      href: 'https://my.example.com',
    },
  ],
  Data: [
    {
      name: 'db.example.com',
      type: 'Service',
      icon: 'fa-cloud',
      description: 'database ui',
      href: 'https://db.example.com',
    },
  ],
};

async function startFakeApi() {
  const seen = [];
  let fail = false;
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    if (fail) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'forbidden' }));
      return;
    }
    let items = [];
    if (req.url.includes('/ingressroutes')) items = [INGRESSROUTE];
    else if (req.url.includes('/ingresses')) items = [INGRESS];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    setFail: (value) => {
      fail = value;
    },
  };
}

// An API that sends headers and then trickles a body that never ends: the socket stays busy, so
// only the app's total deadline (or close()) can end the request.
async function startStalledApi() {
  let requests = 0;
  let closed = 0;
  const server = createServer((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    const trickle = setInterval(() => {
      res.write(' ');
    }, 200);
    res.on('close', () => {
      clearInterval(trickle);
      closed++;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    requestCount: () => requests,
    closedCount: () => closed,
  };
}

// An API whose response body is far over the 8 MiB cap.
async function startHugeApi() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(Buffer.alloc(9 * 1024 * 1024, 0x78));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

function makeTempToken() {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-test-'));
  const file = join(dir, 'token');
  writeFileSync(file, `${TOKEN}\n`);
  return { dir, file };
}

function captureLogger(lines) {
  return {
    info: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };
}

async function startApp(fake, cacheSeconds, logger) {
  const temp = makeTempToken();
  const app = createApp({
    KUBE_API_URL: fake.url,
    KUBE_TOKEN_FILE: temp.file,
    CACHE_SECONDS: cacheSeconds,
    ...(logger ? { logger } : {}),
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, temp };
}

async function stop(fake, app, temp) {
  await app.close();
  await new Promise((resolve) => fake.server.close(resolve));
  rmSync(temp.dir, { recursive: true, force: true });
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('server', () => {
  it('answers /services.json with the expected cards and sends the bearer token', async () => {
    const fake = await startFakeApi();
    const { app, base, temp } = await startApp(fake, 30);
    try {
      const res = await fetch(`${base}/services.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.json()).toEqual(EXPECTED);
      expect(fake.seen.some((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    } finally {
      await stop(fake, app, temp);
    }
  });

  it('serves /healthz and 404s unknown paths', async () => {
    const fake = await startFakeApi();
    const { app, base, temp } = await startApp(fake, 30);
    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe('ok');

      const missing = await fetch(`${base}/nope`);
      expect(missing.status).toBe(404);

      const wrongMethod = await fetch(`${base}/services.json`, { method: 'POST' });
      expect(wrongMethod.status).toBe(404);
    } finally {
      await stop(fake, app, temp);
    }
  });

  it('returns 503 when the API fails before any success', async () => {
    const fake = await startFakeApi();
    fake.setFail(true);
    const { app, base, temp } = await startApp(fake, 0);
    try {
      const res = await fetch(`${base}/services.json`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'discovery unavailable' });
    } finally {
      await stop(fake, app, temp);
    }
  });

  it('serves the last good list with a Warning header when the API fails after a success', async () => {
    const fake = await startFakeApi();
    const { app, base, temp } = await startApp(fake, 0);
    try {
      const first = await fetch(`${base}/services.json`);
      expect(first.status).toBe(200);
      const firstBody = await first.text();
      expect(JSON.parse(firstBody)).toEqual(EXPECTED);

      fake.setFail(true);
      const second = await fetch(`${base}/services.json`);
      expect(second.status).toBe(200);
      expect(second.headers.get('warning')).toBe('110 - "stale"');
      expect(await second.text()).toBe(firstBody);
    } finally {
      await stop(fake, app, temp);
    }
  });

  it('answers HEAD with the same status and headers but no body', async () => {
    const fake = await startFakeApi();
    const { app, base, temp } = await startApp(fake, 30);
    try {
      const health = await fetch(`${base}/healthz`, { method: 'HEAD' });
      expect(health.status).toBe(200);
      expect(health.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(await health.text()).toBe('');

      const services = await fetch(`${base}/services.json`, { method: 'HEAD' });
      expect(services.status).toBe(200);
      expect(services.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(services.headers.get('cache-control')).toBe('no-cache');
      expect(await services.text()).toBe('');
    } finally {
      await stop(fake, app, temp);
    }
  });

  it('brackets an IPv6 Kubernetes service host in the default API URL', () => {
    expect(defaultApiUrl('fd00::1', '443')).toBe('https://[fd00::1]:443');
    expect(defaultApiUrl('10.0.0.1', '443')).toBe('https://10.0.0.1:443');
  });

  it('answers 503 within the total deadline when an upstream stalls forever', async () => {
    const fake = await startStalledApi();
    const { app, base, temp } = await startApp(fake, 0);
    try {
      const startedAt = Date.now();
      const res = await fetch(`${base}/services.json`);
      const elapsed = Date.now() - startedAt;
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'discovery unavailable' });
      expect(elapsed).toBeLessThan(6000);
    } finally {
      await stop(fake, app, temp);
    }
  }, 10000);

  it('close() cancels a stalled upstream request and resolves promptly', async () => {
    const fake = await startStalledApi();
    const { app, base, temp } = await startApp(fake, 0);
    try {
      const ac = new AbortController();
      const client = fetch(`${base}/services.json`, { signal: ac.signal }).catch(() => 'aborted');
      await waitUntil(() => fake.requestCount() >= 2);
      expect(fake.requestCount()).toBeGreaterThanOrEqual(2);
      ac.abort();
      const startedAt = Date.now();
      await app.close();
      expect(Date.now() - startedAt).toBeLessThan(1000);
      await waitUntil(() => fake.closedCount() >= 1);
      expect(fake.closedCount()).toBeGreaterThanOrEqual(1);
      expect(await client).toBe('aborted');
    } finally {
      await stop(fake, app, temp);
    }
  });

  it('rejects an upstream body over the 8 MiB cap', async () => {
    const fake = await startHugeApi();
    const lines = [];
    const { app, base, temp } = await startApp(fake, 0, captureLogger(lines));
    try {
      const res = await fetch(`${base}/services.json`);
      expect(res.status).toBe(503);
      expect(lines).toContain('BodyTooLarge');
    } finally {
      await stop(fake, app, temp);
    }
  });

  it('logs a handler error by class and status only, never the message', async () => {
    const lines = [];
    const secret = 'a very secret handler message';
    const app = createApp({ logger: captureLogger(lines) });
    const res = {
      headersSent: false,
      writeHead(status) {
        if (status === 200) throw new Error(secret);
        return this;
      },
      end(body) {
        this.body = body;
        return this;
      },
    };
    app.server.emit('request', { method: 'GET', url: '/healthz' }, res);
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toContain('Error 500');
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.some((line) => /^GET \/healthz 500 \d+$/.test(line))).toBe(true);
    expect(res.body).toBe('internal error');
  });

  it('logs the request path without the query string', async () => {
    const fake = await startFakeApi();
    const lines = [];
    const { app, base, temp } = await startApp(fake, 30, captureLogger(lines));
    try {
      const res = await fetch(`${base}/services.json?x=secret`);
      expect(res.status).toBe(200);
      expect(lines.some((line) => line.includes('/services.json'))).toBe(true);
      for (const line of lines) {
        expect(line).not.toContain('secret');
      }
    } finally {
      await stop(fake, app, temp);
    }
  });

  it('never puts the token in a response body or a log line', async () => {
    const fake = await startFakeApi();
    const lines = [];
    const { app, base, temp } = await startApp(fake, 0, captureLogger(lines));
    try {
      fake.setFail(true);
      const failing = await fetch(`${base}/services.json`);
      expect(failing.status).toBe(503);
      expect(await failing.text()).not.toContain(TOKEN);

      fake.setFail(false);
      const ok = await fetch(`${base}/services.json`);
      expect(ok.status).toBe(200);
      const okBody = await ok.text();
      expect(JSON.parse(okBody)).toEqual(EXPECTED);
      expect(okBody).not.toContain(TOKEN);

      fake.setFail(true);
      const stale = await fetch(`${base}/services.json`);
      expect(stale.status).toBe(200);
      expect(stale.headers.get('warning')).toBe('110 - "stale"');
      expect(await stale.text()).not.toContain(TOKEN);

      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain(TOKEN);
      }
    } finally {
      await stop(fake, app, temp);
    }
  });
});

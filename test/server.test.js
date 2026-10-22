import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

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

function makeTempToken() {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-test-'));
  const file = join(dir, 'token');
  writeFileSync(file, `${TOKEN}\n`);
  return { dir, file };
}

async function startApp(fake, cacheSeconds) {
  const temp = makeTempToken();
  const app = createApp({
    KUBE_API_URL: fake.url,
    KUBE_TOKEN_FILE: temp.file,
    CACHE_SECONDS: cacheSeconds,
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

  it('never puts the token in a response body', async () => {
    const fake = await startFakeApi();
    const { app, base, temp } = await startApp(fake, 30);
    try {
      const res = await fetch(`${base}/services.json`);
      const body = await res.text();
      expect(body).not.toContain(TOKEN);
      expect(JSON.parse(body)).toEqual(EXPECTED);
    } finally {
      await stop(fake, app, temp);
    }
  });
});

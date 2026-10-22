// The discovery service (fleet plan F64): answers GET /services.json from the cluster's Traefik
// IngressRoutes and Ingresses, cached, with a last-good fallback. Read-only, standard library only.

import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { cardsFromObjects, DEFAULT_EXCLUDED_NAMESPACES } from './discover.js';

const REQUEST_TIMEOUT_MS = 5000;
const INGRESSROUTES_PATH = '/apis/traefik.io/v1alpha1/ingressroutes';
const INGRESSES_PATH = '/apis/networking.k8s.io/v1/ingresses';
const WARNING_STALE = '110 - "stale"';

class ApiError extends Error {
  constructor(status) {
    super(`API responded ${status}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

function parseConfig(config) {
  const env = process.env;
  const excludedRaw = config.EXCLUDED_NAMESPACES ?? env.EXCLUDED_NAMESPACES;
  return {
    apiUrl: (config.KUBE_API_URL ?? env.KUBE_API_URL ?? `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT}`).replace(/\/+$/, ''),
    tokenFile: config.KUBE_TOKEN_FILE ?? env.KUBE_TOKEN_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
    caFile: config.KUBE_CA_FILE ?? env.KUBE_CA_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    cacheSeconds: Number(config.CACHE_SECONDS ?? env.CACHE_SECONDS ?? 30),
    excludedNamespaces:
      excludedRaw === undefined
        ? DEFAULT_EXCLUDED_NAMESPACES
        : String(excludedRaw).split(',').map((s) => s.trim()).filter(Boolean),
  };
}

function getJson(url, { token, ca }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const secure = target.protocol === 'https:';
    const transport = secure ? httpsRequest : httpRequest;
    const options = {
      method: 'GET',
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    };
    if (secure) options.ca = ca;

    const req = transport(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const status = res.statusCode;
        if (status < 200 || status >= 300) {
          reject(new ApiError(status));
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          reject(new Error('malformed JSON response'));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('request timeout'));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

export function createApp(config = {}) {
  const cfg = parseConfig(config);

  let lastGood = null; // serialized services.json body of the last successful refresh
  let lastGoodAt = 0;
  let lastAttemptAt = 0;
  let inFlight = null;

  async function doRefresh() {
    try {
      const [token, ca] = await Promise.all([
        readFile(cfg.tokenFile, 'utf8').then((t) => t.trim()),
        cfg.apiUrl.startsWith('https://') ? readFile(cfg.caFile) : Promise.resolve(undefined),
      ]);
      const [ingressRoutes, ingresses] = await Promise.all([
        getJson(`${cfg.apiUrl}${INGRESSROUTES_PATH}`, { token, ca }),
        getJson(`${cfg.apiUrl}${INGRESSES_PATH}`, { token, ca }),
      ]);
      if (!Array.isArray(ingressRoutes.items) || !Array.isArray(ingresses.items)) {
        throw new Error('malformed list response');
      }
      const cards = cardsFromObjects(
        { ingressRoutes: ingressRoutes.items, ingresses: ingresses.items },
        { excludedNamespaces: cfg.excludedNamespaces },
      );
      lastGood = JSON.stringify(cards);
      lastGoodAt = Date.now();
      return { ok: true, stale: false, body: lastGood };
    } catch (err) {
      const status = err.status === undefined ? '' : String(err.status);
      console.error(`${err.name || err.constructor.name} ${status}`.trim());
      if (lastGood !== null) return { ok: false, stale: true, body: lastGood };
      return { ok: false, stale: false, body: null };
    } finally {
      inFlight = null;
    }
  }

  // One refresh at most every CACHE_SECONDS; concurrent requests share the in-flight refresh.
  async function serveServicesBody() {
    const now = Date.now();
    if (lastGood !== null && now - lastGoodAt < cfg.cacheSeconds * 1000) {
      return { ok: true, stale: false, body: lastGood };
    }
    if (inFlight) return inFlight;
    if (now - lastAttemptAt < cfg.cacheSeconds * 1000) {
      if (lastGood !== null) return { ok: false, stale: true, body: lastGood };
      return { ok: false, stale: false, body: null };
    }
    lastAttemptAt = now;
    inFlight = doRefresh();
    return inFlight;
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    let status = 200;
    try {
      const method = req.method || 'GET';
      const pathname = (req.url || '/').split('?')[0];
      if (method !== 'GET' && method !== 'HEAD') {
        status = 404;
        res.writeHead(404);
        res.end();
        return;
      }
      if (pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
      }
      if (pathname === '/services.json') {
        const result = await serveServicesBody();
        if (result.ok) {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-cache',
          });
          res.end(result.body);
        } else if (result.stale) {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-cache',
            Warning: WARNING_STALE,
          });
          res.end(result.body);
        } else {
          status = 503;
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'discovery unavailable' }));
        }
        return;
      }
      status = 404;
      res.writeHead(404);
      res.end();
    } catch (err) {
      status = 500;
      console.error(`InternalError ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end('internal error');
    } finally {
      console.log(`${req.method || 'GET'} ${req.url || '/'} ${status} ${Date.now() - started}`);
    }
  });

  return {
    server,
    close() {
      return new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      });
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const app = createApp();
  app.server.listen(Number(process.env.PORT ?? 8080));
}

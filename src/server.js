// The discovery service (fleet plan F64): answers GET /services.json from the cluster's Traefik
// IngressRoutes and Ingresses, cached, with a last-good fallback. Read-only, standard library only.

import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { cardsFromObjects, DEFAULT_EXCLUDED_NAMESPACES } from './discover.js';

const REQUEST_TIMEOUT_MS = 5000;
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;
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

// The default in-cluster API URL. An IPv6 KUBERNETES_SERVICE_HOST must be bracketed.
export function defaultApiUrl(host, port) {
  const plain = String(host);
  const hostPart = plain.includes(':') ? `[${plain}]` : plain;
  return `https://${hostPart}:${port}`;
}

const defaultLogger = {
  info: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
};

function parseConfig(config) {
  const env = process.env;
  const excludedRaw = config.EXCLUDED_NAMESPACES ?? env.EXCLUDED_NAMESPACES;
  const host = config.KUBERNETES_SERVICE_HOST ?? env.KUBERNETES_SERVICE_HOST;
  const port = config.KUBERNETES_SERVICE_PORT ?? env.KUBERNETES_SERVICE_PORT;
  return {
    apiUrl: (config.KUBE_API_URL ?? env.KUBE_API_URL ?? defaultApiUrl(host, port)).replace(/\/+$/, ''),
    tokenFile: config.KUBE_TOKEN_FILE ?? env.KUBE_TOKEN_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
    caFile: config.KUBE_CA_FILE ?? env.KUBE_CA_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    cacheSeconds: Number(config.CACHE_SECONDS ?? env.CACHE_SECONDS ?? 30),
    excludedNamespaces:
      excludedRaw === undefined
        ? DEFAULT_EXCLUDED_NAMESPACES
        : String(excludedRaw).split(',').map((s) => s.trim()).filter(Boolean),
    logger: config.logger ?? defaultLogger,
  };
}

// The path for the access log: pathname only, never the query string (it can carry secrets).
function accessPath(req) {
  try {
    return new URL(req.url || '/', 'http://x').pathname;
  } catch {
    return (req.url || '/').split('?')[0];
  }
}

// GET url as JSON. Bounded by a 5 s total deadline (a slow or huge body must not hold the
// single-flight refresh slot forever) and an 8 MiB body cap; `requests` collects the in-flight
// request so close() can cancel it.
function getJson(url, { token, ca, requests }) {
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

    let settled = false;
    let deadline = null;
    let req = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (deadline !== null) clearTimeout(deadline);
      if (req !== null) requests.delete(req);
      fn(value);
    };

    req = transport(options, (res) => {
      const chunks = [];
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > BODY_LIMIT_BYTES) {
          const tooLarge = new Error('upstream body exceeds the limit');
          tooLarge.name = 'BodyTooLarge';
          req.destroy(tooLarge);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const status = res.statusCode;
        if (status < 200 || status >= 300) {
          settle(reject, new ApiError(status));
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          settle(reject, new Error('malformed JSON response'));
          return;
        }
        settle(resolve, parsed);
      });
    });
    requests.add(req);
    // Total deadline from the start of the request, in addition to the socket inactivity timeout.
    deadline = setTimeout(() => req.destroy(new Error('timeout')), REQUEST_TIMEOUT_MS);
    req.on('timeout', () => {
      req.destroy(new Error('request timeout'));
    });
    req.on('error', (err) => settle(reject, err));
    req.end();
  });
}

export function createApp(config = {}) {
  const cfg = parseConfig(config);

  const pendingRequests = new Set(); // in-flight upstream requests, cancelled by close()
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
        getJson(`${cfg.apiUrl}${INGRESSROUTES_PATH}`, { token, ca, requests: pendingRequests }),
        getJson(`${cfg.apiUrl}${INGRESSES_PATH}`, { token, ca, requests: pendingRequests }),
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
      cfg.logger.error(`${err.name ?? 'Error'} ${status}`.trim());
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
    const method = req.method || 'GET';
    const isHead = method === 'HEAD';
    // HEAD answers with the same status and headers as GET but never a body.
    const finish = (body) => res.end(isHead ? undefined : body);
    let status = 200;
    try {
      const pathname = (req.url || '/').split('?')[0];
      if (method !== 'GET' && method !== 'HEAD') {
        status = 404;
        res.writeHead(404);
        finish();
        return;
      }
      if (pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        finish('ok');
        return;
      }
      if (pathname === '/services.json') {
        const result = await serveServicesBody();
        if (result.ok) {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-cache',
          });
          finish(result.body);
        } else if (result.stale) {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-cache',
            Warning: WARNING_STALE,
          });
          finish(result.body);
        } else {
          status = 503;
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
          finish(JSON.stringify({ error: 'discovery unavailable' }));
        }
        return;
      }
      status = 404;
      res.writeHead(404);
      finish();
    } catch (err) {
      status = 500;
      cfg.logger.error(`${err.name ?? 'Error'} 500`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      finish('internal error');
    } finally {
      cfg.logger.info(`${method} ${accessPath(req)} ${status} ${Date.now() - started}`);
    }
  });

  return {
    server,
    close() {
      // Cancel in-flight upstream requests so close() never waits behind a stalled refresh.
      for (const req of pendingRequests) {
        req.destroy(new Error('closing'));
      }
      pendingRequests.clear();
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

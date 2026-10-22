// The discovery service (fleet plan F64): answers GET /services.json from the cluster's Traefik
// IngressRoutes and Ingresses, cached, with a last-good fallback. Read-only, standard library only.

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { cardsFromObjects, DEFAULT_EXCLUDED_NAMESPACES } from './discover.js';

const REQUEST_TIMEOUT_MS = 5000;
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const INGRESSROUTES_PATH = '/apis/traefik.io/v1alpha1/ingressroutes';
const INGRESSES_PATH = '/apis/networking.k8s.io/v1/ingresses';
const WARNING_STALE = '110 - "stale"';
const DEFAULT_CACHE_SECONDS = 30;
// The plain http transport exists for tests only, against a loopback API.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

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

// CACHE_SECONDS must be a non-negative number; anything else falls back to the default, with one
// line through the logger when a value was given but could not be used.
function parseCacheSeconds(raw, logger) {
  if (raw === undefined) return DEFAULT_CACHE_SECONDS;
  const text = String(raw).trim();
  const value = text === '' ? NaN : Number(text);
  if (Number.isFinite(value) && value >= 0) return value;
  logger.error(`invalid CACHE_SECONDS; using the default ${DEFAULT_CACHE_SECONDS}`);
  return DEFAULT_CACHE_SECONDS;
}

// `http://` is accepted solely for a loopback host (tests); any other http URL is a configuration
// error. The message names the scheme, never the URL, which could carry credentials.
function assertTransportAllowed(apiUrl) {
  let target;
  try {
    target = new URL(apiUrl);
  } catch {
    return; // an unparseable URL fails later, at request time, as before
  }
  // An IPv6 URL's hostname keeps its brackets; compare without them.
  const hostname =
    target.hostname.startsWith('[') && target.hostname.endsWith(']')
      ? target.hostname.slice(1, -1)
      : target.hostname;
  if (target.protocol === 'http:' && !LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `insecure http API URL: http:// is only allowed for 127.0.0.1, localhost or ::1`,
    );
  }
}

export function parseConfig(config) {
  const env = process.env;
  const excludedRaw = config.EXCLUDED_NAMESPACES ?? env.EXCLUDED_NAMESPACES;
  const host = config.KUBERNETES_SERVICE_HOST ?? env.KUBERNETES_SERVICE_HOST;
  const port = config.KUBERNETES_SERVICE_PORT ?? env.KUBERNETES_SERVICE_PORT;
  const logger = config.logger ?? defaultLogger;
  let apiUrl = config.KUBE_API_URL ?? env.KUBE_API_URL ?? defaultApiUrl(host, port);
  while (apiUrl.endsWith('/')) apiUrl = apiUrl.slice(0, -1);
  assertTransportAllowed(apiUrl);
  return {
    apiUrl,
    tokenFile: config.KUBE_TOKEN_FILE ?? env.KUBE_TOKEN_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
    caFile: config.KUBE_CA_FILE ?? env.KUBE_CA_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    cacheSeconds: parseCacheSeconds(config.CACHE_SECONDS ?? env.CACHE_SECONDS, logger),
    excludedNamespaces:
      excludedRaw === undefined
        ? DEFAULT_EXCLUDED_NAMESPACES
        : String(excludedRaw).split(',').map((s) => s.trim()).filter(Boolean),
    logger,
  };
}

// The path for the access log: pathname only, never the query string (it can carry secrets).
function accessPath(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').pathname;
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
          settle(reject, tooLarge);
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
      // An upstream that closes the socket after the headers destroys the response with
      // ECONNRESET and emits neither `end` nor an `error` on the request; without these listeners
      // the promise would never settle and the single-flight refresh slot would hang forever.
      res.on('error', (err) => settle(reject, err));
      res.on('close', () => {
        if (!res.complete) settle(reject, new Error('upstream closed early'));
      });
    });
    requests.add(req);
    // Total deadline from the start of the request. Settle directly: destroying an already
    // destroyed request returns early and emits nothing, so the promise must not rely on it.
    deadline = setTimeout(() => {
      settle(reject, new Error('timeout'));
      req.destroy(new Error('timeout'));
    }, REQUEST_TIMEOUT_MS);
    req.on('timeout', () => {
      settle(reject, new Error('request timeout'));
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
  let closed = false;

  async function doRefresh() {
    try {
      const [token, ca] = await Promise.all([
        readFile(cfg.tokenFile, 'utf8').then((t) => t.trim()),
        cfg.apiUrl.startsWith('https://') ? readFile(cfg.caFile) : Promise.resolve(undefined),
      ]);
      // close() may have run while the token and CA were being read: start nothing after it.
      if (closed) throw new Error('closed');
      const [ingressRoutes, ingresses] = await Promise.all([
        getJson(`${cfg.apiUrl}${INGRESSROUTES_PATH}`, { token, ca, requests: pendingRequests }),
        getJson(`${cfg.apiUrl}${INGRESSES_PATH}`, { token, ca, requests: pendingRequests }),
      ]);
      if (!Array.isArray(ingressRoutes.items) || !Array.isArray(ingresses.items)) {
        throw new TypeError('malformed list response');
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

  // Inbound limits: a slow or stalled client must not hold a connection open indefinitely.
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxConnections = 256;

  return {
    server,
    close() {
      closed = true;
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

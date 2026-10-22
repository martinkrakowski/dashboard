# dashboard agent instructions

- Node 22, ES modules, the standard library only: no runtime dependency may be added. Dev
  dependencies are vitest only.
- The service is read-only. It reads the ServiceAccount token and CA from
  `/var/run/secrets/kubernetes.io/serviceaccount/` (or the paths in `KUBE_TOKEN_FILE`,
  `KUBE_CA_FILE` for tests), calls the API server named by `KUBERNETES_SERVICE_HOST` and
  `KUBERNETES_SERVICE_PORT`, and never writes to the cluster. The token is re-read from the file at
  every refresh: the kubelet rotates the projected token, and a token read once at startup stops
  working within the hour. The CA may be read once.
- The endpoint is reachable without authentication on the LAN, so the cache is single-flight:
  concurrent misses share one refresh, and a request flood never becomes more than one list call per
  cache window.
- Never log the token, an Authorization header, or a response body. Log one line per request
  at most, and errors by class and status code.
- An API error, timeout (5 s) or malformed response never produces an empty list: answer the last
  good list with a `Warning` header, or 503 when there is none.
- `src/` holds `server.js` (HTTP, cache) and `discover.js` (pure functions: parse objects into
  cards, apply annotations, exclusions and dedupe); `discover.js` must not import `node:http` or
  `node:fs`, so it is testable without a server.
- Tests under `test/` with vitest; run `yarn test` before committing. The CI workflow runs the same.
- Do not commit or push unless explicitly requested.

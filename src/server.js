// Placeholder until lane 1 implements the service (fleet plan F64): answers 503 on every path so
// a premature rollout fails closed instead of serving an empty list.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8080);
createServer((_request, response) => {
  response.writeHead(503, { 'content-type': 'text/plain' });
  response.end('discovery not implemented\n');
}).listen(port);

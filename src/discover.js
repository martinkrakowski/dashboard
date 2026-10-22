// Pure functions turning IngressRoute and Ingress objects into dashboard cards (fleet plan F61,
// F62). No node:http / node:fs here so this module is testable without a server.

export const ANNOTATION_PREFIX = 'dashboard.krakowski.cloud/';

export const DEFAULT_EXCLUDED_NAMESPACES = [
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'flux-system',
  'traefik',
  'cert-manager',
  'kyverno',
  'cnpg-system',
  'external-secrets',
  'keda',
  'monitoring',
  'kured',
  'secrets-source',
  'ack-webhook',
];

// Every host in a Traefik match string, e.g. `Host(`a.example`) || Host(`b.example`) &&
// PathPrefix(`/api/`)` gives ['a.example', 'b.example']; no hosts gives [].
export function hostsFromMatch(match) {
  if (typeof match !== 'string') return [];
  const hosts = [];
  const re = /Host\(\s*`([^`]*)`\s*\)/g;
  let found;
  while ((found = re.exec(match)) !== null) {
    for (const part of found[1].split(',')) {
      const host = part.trim();
      if (host) hosts.push(host);
    }
  }
  return hosts;
}

function annotationsOf(obj) {
  const annotations = obj && obj.metadata && obj.metadata.annotations;
  return annotations && typeof annotations === 'object' ? annotations : {};
}

function isAnnotated(annotations) {
  return Object.keys(annotations).some((key) => key.startsWith(ANNOTATION_PREFIX));
}

function isSkipped(obj, excludedNamespaces) {
  const meta = obj && obj.metadata;
  if (!meta || typeof meta !== 'object') return true;
  if (excludedNamespaces.has(meta.namespace)) return true;
  const annotations = annotationsOf(obj);
  return annotations[ANNOTATION_PREFIX + 'hidden'] === 'true';
}

// IngressRoute hosts: only when spec.entryPoints includes websecure; hosts come from every
// spec.routes[].match. Returns null when the object does not count or is malformed.
function ingressRouteHosts(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const entryPoints = spec.entryPoints;
  if (!Array.isArray(entryPoints) || !entryPoints.includes('websecure')) return null;
  const routes = spec.routes;
  if (!Array.isArray(routes)) return null;
  const hosts = [];
  for (const route of routes) {
    if (!route || typeof route !== 'object') continue;
    if (typeof route.match !== 'string') continue;
    hosts.push(...hostsFromMatch(route.match));
  }
  return hosts;
}

// Ingress hosts: only when spec.tls is a non-empty array; hosts come from spec.rules[].host.
// Returns null when the object does not count or is malformed.
function ingressHosts(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const tls = spec.tls;
  if (!Array.isArray(tls) || tls.length === 0) return null;
  const rules = spec.rules;
  if (!Array.isArray(rules)) return null;
  const hosts = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    if (typeof rule.host === 'string') hosts.push(rule.host);
  }
  return hosts;
}

function compareCaseInsensitive(a, b) {
  return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
}

export function cardsFromObjects(
  { ingressRoutes = [], ingresses = [] },
  { excludedNamespaces = DEFAULT_EXCLUDED_NAMESPACES } = {},
) {
  const excluded = new Set(excludedNamespaces);
  // host -> { obj, annotated }; one card per distinct host, first object wins except an annotated
  // object beats an unannotated one for the same host.
  const chosen = new Map();

  const consider = (obj, hosts) => {
    if (!hosts) return;
    if (isSkipped(obj, excluded)) return;
    const annotated = isAnnotated(annotationsOf(obj));
    for (const host of hosts) {
      const current = chosen.get(host);
      if (!current) {
        chosen.set(host, { obj, annotated });
      } else if (annotated && !current.annotated) {
        chosen.set(host, { obj, annotated });
      }
    }
  };

  for (const obj of Array.isArray(ingressRoutes) ? ingressRoutes : []) {
    consider(obj, ingressRouteHosts(obj && obj.spec));
  }
  for (const obj of Array.isArray(ingresses) ? ingresses : []) {
    consider(obj, ingressHosts(obj && obj.spec));
  }

  const sections = new Map();
  for (const [host, { obj }] of chosen) {
    const annotations = annotationsOf(obj);
    const prefix = ANNOTATION_PREFIX;
    const card = {
      name: annotations[prefix + 'name'] ?? host,
      type: annotations[prefix + 'type'] ?? 'Service',
      icon: annotations[prefix + 'icon'] ?? 'fa-cloud',
      description: annotations[prefix + 'description'] ?? '',
      href: annotations[prefix + 'href'] ?? `https://${host}`,
    };
    const section = annotations[prefix + 'section'] ?? 'Unsorted';
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push(card);
  }

  const result = {};
  for (const [section, cards] of sections) {
    cards.sort((a, b) => compareCaseInsensitive(a.name, b.name));
    result[section] = cards;
  }

  const orderedSections = [...sections.keys()].sort((a, b) => {
    if (a === 'Unsorted') return 1;
    if (b === 'Unsorted') return -1;
    return compareCaseInsensitive(a, b);
  });

  const output = {};
  for (const section of orderedSections) {
    output[section] = result[section];
  }
  return output;
}

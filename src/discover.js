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

// Every host in a Traefik match string: `Host(`a.example`) || Host(`b.example`) &&
// PathPrefix(`/api/`)` gives ['a.example', 'b.example'], and the Traefik v2 multi-argument form
// `Host(`a.example`, `b.example`)` gives both hosts too; no hosts gives [].
export function hostsFromMatch(match) {
  if (typeof match !== 'string') return [];
  const hosts = [];
  const call = /Host\(([^)]*)\)/g;
  const quoted = /`([^`]*)`/g;
  let found;
  while ((found = call.exec(match)) !== null) {
    quoted.lastIndex = 0;
    let argument;
    while ((argument = quoted.exec(found[1])) !== null) {
      for (const part of argument[1].split(',')) {
        const host = part.trim();
        if (host) hosts.push(host);
      }
    }
  }
  return hosts;
}

function annotationsOf(obj) {
  const annotations = obj?.metadata?.annotations;
  return annotations && typeof annotations === 'object' ? annotations : {};
}

// An annotation value, or undefined when it is absent, empty or whitespace-only: an empty value
// behaves like no value at all, so the defaults apply.
function annotationValue(annotations, name) {
  const value = annotations[ANNOTATION_PREFIX + name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function isAnnotated(annotations) {
  return Object.keys(annotations).some((key) => key.startsWith(ANNOTATION_PREFIX));
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
  // host -> { obj, firstHost, annotated }; one card per distinct host, the first object wins except
  // that an object carrying any annotation beats an unannotated one for the same host.
  const chosen = new Map();
  // Hidden applies after collecting (plan F61): a host an object marks hidden stays hidden even
  // when another, unannotated object serves it.
  const hiddenHosts = new Set();

  const consider = (obj, hosts) => {
    if (!hosts) return;
    const meta = obj?.metadata;
    if (!meta || typeof meta !== 'object' || excluded.has(meta.namespace)) return;
    const annotations = annotationsOf(obj);
    if (annotationValue(annotations, 'hidden') === 'true') {
      for (const host of hosts) hiddenHosts.add(host);
      return;
    }
    const annotated = isAnnotated(annotations);
    for (const host of hosts) {
      const current = chosen.get(host);
      if (!current || (annotated && !current.annotated)) {
        chosen.set(host, { obj, firstHost: hosts[0], annotated });
      }
    }
  };

  for (const obj of Array.isArray(ingressRoutes) ? ingressRoutes : []) {
    consider(obj, ingressRouteHosts(obj?.spec));
  }
  for (const obj of Array.isArray(ingresses) ? ingresses : []) {
    consider(obj, ingressHosts(obj?.spec));
  }

  const sections = new Map();
  for (const [host, { obj, firstHost }] of chosen) {
    if (hiddenHosts.has(host)) continue;
    const annotations = annotationsOf(obj);
    // The annotated card fields apply to the object's first host only; every other host of the
    // same object gets the default card, in the same section.
    const card =
      host === firstHost
        ? {
            name: annotationValue(annotations, 'name') ?? host,
            type: annotationValue(annotations, 'type') ?? 'Service',
            icon: annotationValue(annotations, 'icon') ?? 'fa-cloud',
            description: annotationValue(annotations, 'description') ?? '',
            href: annotationValue(annotations, 'href') ?? `https://${host}`,
          }
        : {
            name: host,
            type: 'Service',
            icon: 'fa-cloud',
            description: '',
            href: `https://${host}`,
          };
    const section = annotationValue(annotations, 'section') ?? 'Unsorted';
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push(card);
  }

  for (const cards of sections.values()) {
    cards.sort((a, b) => compareCaseInsensitive(a.name, b.name));
  }

  const orderedSections = [...sections.keys()].sort((a, b) => {
    if (a === 'Unsorted') return 1;
    if (b === 'Unsorted') return -1;
    return compareCaseInsensitive(a, b);
  });

  // Build the result from the Map so a section called `__proto__` or `constructor` becomes an own
  // property instead of mutating the prototype chain.
  return Object.fromEntries(orderedSections.map((section) => [section, sections.get(section)]));
}

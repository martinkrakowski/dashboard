import { describe, it, expect } from 'vitest';
import {
  ANNOTATION_PREFIX,
  DEFAULT_EXCLUDED_NAMESPACES,
  hostsFromMatch,
  cardsFromObjects,
} from '../src/discover.js';

const A = ANNOTATION_PREFIX;

function ingressRoute(name, namespace = 'default', { entryPoints, routes, annotations } = {}) {
  return {
    metadata: { namespace, name, ...(annotations ? { annotations } : {}) },
    spec: {
      entryPoints: entryPoints ?? ['websecure'],
      routes: routes ?? [{ match: 'Host(`a.example`)' }],
    },
  };
}

function ingress(name, namespace = 'default', { tls, rules, annotations } = {}) {
  return {
    metadata: { namespace, name, ...(annotations ? { annotations } : {}) },
    spec: {
      tls: tls ?? [{}],
      rules: rules ?? [{ host: 'a.example' }],
    },
  };
}

function card(name, overrides = {}) {
  return {
    name,
    type: 'Service',
    icon: 'fa-cloud',
    description: '',
    href: `https://${name}`,
    ...overrides,
  };
}

describe('hostsFromMatch', () => {
  it('extracts a single host', () => {
    expect(hostsFromMatch('Host(`a.example`)')).toEqual(['a.example']);
  });

  it('extracts multiple hosts across || and &&', () => {
    expect(hostsFromMatch('Host(`a.example`) || Host(`b.example`) && PathPrefix(`/api/`)')).toEqual([
      'a.example',
      'b.example',
    ]);
  });

  it('returns [] when there are no hosts', () => {
    expect(hostsFromMatch('PathPrefix(`/api/`) && Method(`GET`)')).toEqual([]);
    expect(hostsFromMatch('')).toEqual([]);
    expect(hostsFromMatch(42)).toEqual([]);
  });
});

describe('cardsFromObjects', () => {
  it('only counts IngressRoutes with websecure entry point', () => {
    const web = ingressRoute('web', 'default', { routes: [{ match: 'Host(`web.example`)' }] });
    const plain = ingressRoute('plain', 'default', {
      entryPoints: ['web'],
      routes: [{ match: 'Host(`plain.example`)' }],
    });
    const out = cardsFromObjects({ ingressRoutes: [web, plain], ingresses: [] });
    expect(out).toEqual({ Unsorted: [card('web.example')] });
  });

  it('only counts Ingresses with a non-empty tls array', () => {
    const noTls = ingress('no-tls', 'default', { tls: [], rules: [{ host: 'a.example' }] });
    const withTls = ingress('with-tls', 'default', { tls: [{}], rules: [{ host: 'b.example' }] });
    const out = cardsFromObjects({ ingressRoutes: [], ingresses: [noTls, withTls] });
    expect(out).toEqual({ Unsorted: [card('b.example')] });
  });

  it('uses hosts from every IngressRoute route match', () => {
    const r = ingressRoute('multi', 'default', {
      routes: [
        { match: 'Host(`a.example`)' },
        { match: 'Host(`b.example`) || Host(`c.example`)' },
      ],
    });
    const out = cardsFromObjects({ ingressRoutes: [r], ingresses: [] });
    expect(out.Unsorted.map((c) => c.name).sort()).toEqual(['a.example', 'b.example', 'c.example']);
  });

  it('skips excluded namespaces', () => {
    const r = ingressRoute('r', 'kube-system');
    expect(cardsFromObjects({ ingressRoutes: [r], ingresses: [] })).toEqual({});
    const custom = ingressRoute('c', 'team-a');
    expect(
      cardsFromObjects({ ingressRoutes: [custom], ingresses: [] }, { excludedNamespaces: ['team-a'] }),
    ).toEqual({});
  });

  it('skips objects with hidden=true and keeps hidden=false', () => {
    const hidden = ingressRoute('hidden', 'default', {
      routes: [{ match: 'Host(`hidden.example`)' }],
      annotations: { [A + 'hidden']: 'true' },
    });
    const shown = ingressRoute('shown', 'default', {
      annotations: { [A + 'hidden']: 'false' },
    });
    const out = cardsFromObjects({ ingressRoutes: [hidden, shown], ingresses: [] });
    expect(out).toEqual({ Unsorted: [card('a.example')] });
  });

  it('keeps a section named __proto__ or constructor as an own key', () => {
    const proto = ingressRoute('proto', 'default', {
      annotations: { [A + 'section']: '__proto__' },
    });
    const roundTripped = JSON.parse(JSON.stringify(cardsFromObjects({ ingressRoutes: [proto], ingresses: [] })));
    expect(Object.keys(roundTripped)).toContain('__proto__');
    expect(roundTripped.__proto__).toEqual([card('a.example')]);

    const ctor = ingressRoute('ctor', 'default', {
      routes: [{ match: 'Host(`c.example`)' }],
      annotations: { [A + 'section']: 'constructor' },
    });
    const ctorOut = JSON.parse(JSON.stringify(cardsFromObjects({ ingressRoutes: [ctor], ingresses: [] })));
    expect(Object.keys(ctorOut)).toContain('constructor');
    expect(ctorOut.constructor).toEqual([card('c.example')]);
  });

  it('applies annotation defaults', () => {
    const r = ingressRoute('r', 'default', { routes: [{ match: 'Host(`a.example`)' }] });
    const out = cardsFromObjects({ ingressRoutes: [r], ingresses: [] });
    expect(out).toEqual({ Unsorted: [card('a.example')] });
  });

  it('an annotated object beats an unannotated one for the same host', () => {
    const plain = ingressRoute('plain', 'default');
    const annotated = ingressRoute('annotated', 'default', {
      annotations: { [A + 'name']: 'Annotated' },
    });
    const out = cardsFromObjects({ ingressRoutes: [plain, annotated], ingresses: [] });
    expect(out.Unsorted).toHaveLength(1);
    expect(out.Unsorted[0].name).toBe('Annotated');
  });

  it('keeps the first object when both are annotated or neither is', () => {
    const first = ingressRoute('first', 'default', {
      annotations: { [A + 'name']: 'First' },
    });
    const second = ingressRoute('second', 'default', {
      annotations: { [A + 'name']: 'Second' },
    });
    expect(cardsFromObjects({ ingressRoutes: [first, second], ingresses: [] }).Unsorted[0].name).toBe('First');
    const p1 = ingressRoute('p1', 'default');
    const p2 = ingressRoute('p2', 'default');
    expect(cardsFromObjects({ ingressRoutes: [p1, p2], ingresses: [] }).Unsorted[0].name).toBe('a.example');
  });

  it('dedupes to one card per host', () => {
    const a = ingressRoute('a', 'default');
    const b = ingressRoute('b', 'default');
    const out = cardsFromObjects({ ingressRoutes: [a, b], ingresses: [] });
    expect(out.Unsorted).toHaveLength(1);
  });

  it('orders sections alphabetically with Unsorted last and cards by name case-insensitively', () => {
    const routes = [
      ingressRoute('r1', 'default', {
        routes: [{ match: 'Host(`z.example`)' }],
        annotations: { [A + 'section']: 'Beta', [A + 'name']: 'Zulu' },
      }),
      ingressRoute('r2', 'default', {
        routes: [{ match: 'Host(`a.example`)' }],
        annotations: { [A + 'section']: 'Alpha', [A + 'name']: 'Alpha' },
      }),
      ingressRoute('r3', 'default', {
        routes: [{ match: 'Host(`m.example`)' }],
        annotations: { [A + 'section']: 'Beta', [A + 'name']: 'Mike' },
      }),
      ingressRoute('r4', 'default', {
        routes: [{ match: 'Host(`n.example`)' }],
      }),
      ingressRoute('r5', 'default', {
        routes: [{ match: 'Host(`b.example`)' }],
        annotations: { [A + 'section']: 'Alpha', [A + 'name']: 'bravo' },
      }),
    ];
    const out = cardsFromObjects({ ingressRoutes: routes, ingresses: [] });
    expect(Object.keys(out)).toEqual(['Alpha', 'Beta', 'Unsorted']);
    expect(out.Alpha.map((c) => c.name)).toEqual(['Alpha', 'bravo']);
    expect(out.Beta.map((c) => c.name)).toEqual(['Mike', 'Zulu']);
    expect(out.Unsorted.map((c) => c.name)).toEqual(['n.example']);
  });

  it('skips malformed objects without throwing', () => {
    const badRoutes = [
      null,
      'not an object',
      {},
      { metadata: { namespace: 'default', name: 'no-spec' } },
      { metadata: { namespace: 'default', name: 'bad-routes' }, spec: { entryPoints: ['websecure'], routes: 'oops' } },
      { metadata: { namespace: 'default', name: 'bad-match' }, spec: { entryPoints: ['websecure'], routes: [{ match: 123 }] } },
      { metadata: { namespace: 'default', name: 'null-route' }, spec: { entryPoints: ['websecure'], routes: [null] } },
      { metadata: { namespace: 'default', name: 'no-websecure' }, spec: { entryPoints: ['http'], routes: [{ match: 'Host(`a.example`)' }] } },
    ];
    const badIngresses = [
      null,
      {},
      { metadata: { namespace: 'default', name: 'no-spec' } },
      { metadata: { namespace: 'default', name: 'no-tls' }, spec: { rules: [{ host: 'a.example' }] } },
      { metadata: { namespace: 'default', name: 'bad-rules' }, spec: { tls: [{}], rules: 'oops' } },
      { metadata: { namespace: 'default', name: 'empty-tls' }, spec: { tls: [], rules: [{ host: 'a.example' }] } },
    ];
    expect(cardsFromObjects({ ingressRoutes: badRoutes, ingresses: badIngresses })).toEqual({});
  });

  it('exposes the expected default excluded namespaces', () => {
    expect(DEFAULT_EXCLUDED_NAMESPACES).toEqual([
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
    ]);
  });
});

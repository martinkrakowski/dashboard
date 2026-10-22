import { describe, it, expect } from 'vitest';
import { ANNOTATION_PREFIX, hostsFromMatch, cardsFromObjects, safeHref } from '../src/discover.js';

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

  it('extracts every host from the Traefik v2 multi-argument form', () => {
    expect(hostsFromMatch('Host(`a.example`, `b.example`)')).toEqual(['a.example', 'b.example']);
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

  it('gives a multi-host object one card per host, annotated on the first host only', () => {
    const r = ingressRoute('multi', 'default', {
      routes: [{ match: 'Host(`a.example`) || Host(`b.example`)' }],
      annotations: {
        [A + 'section']: 'Apps',
        [A + 'name']: 'Annotated',
        [A + 'type']: 'Kind',
        [A + 'icon']: 'fa-cube',
        [A + 'description']: 'the first host',
        [A + 'href']: 'https://a.example/app',
      },
    });
    const out = cardsFromObjects({ ingressRoutes: [r], ingresses: [] });
    expect(out).toEqual({
      Apps: [
        {
          name: 'Annotated',
          type: 'Kind',
          icon: 'fa-cube',
          description: 'the first host',
          href: 'https://a.example/app',
        },
        card('b.example'),
      ],
    });
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

  it('hides a host that any object marks hidden, even when another object serves it', () => {
    const hidden = ingressRoute('hidden', 'default', {
      routes: [{ match: 'Host(`shared.example`)' }],
      annotations: { [A + 'name']: 'Hidden', [A + 'hidden']: 'true' },
    });
    const plain = ingressRoute('plain', 'default', {
      routes: [{ match: 'Host(`shared.example`)' }],
    });
    expect(cardsFromObjects({ ingressRoutes: [hidden, plain], ingresses: [] })).toEqual({});
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

  it('treats an empty or whitespace-only annotation value as absent', () => {
    const r = ingressRoute('r', 'default', {
      annotations: { [A + 'name']: '', [A + 'href']: '   ' },
    });
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
    // Two unannotated objects for the same host would give identical cards, so the first one
    // carries a distinguishing type: if the second object won the host, the type would differ.
    const p1 = ingressRoute('p1', 'default', { annotations: { [A + 'type']: 'Winner' } });
    const p2 = ingressRoute('p2', 'default');
    const out = cardsFromObjects({ ingressRoutes: [p1, p2], ingresses: [] });
    expect(out.Unsorted).toHaveLength(1);
    expect(out.Unsorted[0].name).toBe('a.example');
    expect(out.Unsorted[0].type).toBe('Winner');
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

  it('excludes the namespaces on the default list and honours a custom one', () => {
    const inTraefik = ingressRoute('in-traefik', 'traefik');
    const inDefault = ingressRoute('in-default', 'default', {
      routes: [{ match: 'Host(`kept.example`)' }],
    });
    // `traefik` is on the default exclusion list, `default` is not: only the `default` object shows.
    expect(cardsFromObjects({ ingressRoutes: [inTraefik, inDefault], ingresses: [] })).toEqual({
      Unsorted: [card('kept.example')],
    });
    // A custom list replaces the default: `default` is now excluded, `traefik` is not.
    expect(
      cardsFromObjects(
        { ingressRoutes: [inTraefik, inDefault], ingresses: [] },
        { excludedNamespaces: ['default'] },
      ),
    ).toEqual({ Unsorted: [card('a.example')] });
  });
});

describe('safeHref', () => {
  it('keeps http and https, falls back for other schemes and junk', () => {
    expect(safeHref('https://a.example/x', 'https://d')).toBe('https://a.example/x');
    expect(safeHref('http://a.example', 'https://d')).toBe('http://a.example');
    expect(safeHref('javascript:alert(1)', 'https://d')).toBe('https://d');
    expect(safeHref('data:text/html,hi', 'https://d')).toBe('https://d');
    expect(safeHref('not a url', 'https://d')).toBe('https://d');
    expect(safeHref(undefined, 'https://d')).toBe('https://d');
  });
  it('is applied to the href annotation', () => {
    const route = ingressRoute('r', 'default', {
      annotations: { [A + 'href']: 'javascript:alert(1)' },
    });
    const out = cardsFromObjects({ ingressRoutes: [route], ingresses: [] });
    expect(out.Unsorted[0].href).toBe('https://a.example');
  });
});

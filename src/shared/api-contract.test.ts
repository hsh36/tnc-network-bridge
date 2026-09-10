import { z } from 'zod';
import {
  apiContract,
  buildPath,
  ENDPOINT_IDS,
  getConfigSectionSchema,
  responseEnvelopeSchema,
  type EndpointId,
} from './api-contract';
import { API_BASE_PATH } from './constants';
import { CONFIG_SECTION_NAMES } from './schemas';

/**
 * Every `Method /path` pair in IMPLEMENTATION_PLAN §5, transcribed by hand.
 *
 * This list is the acceptance criterion for T2 in executable form: if an endpoint is
 * documented but not in the contract, or the contract drifts away from a documented
 * path, this test fails. Update it only alongside a deliberate change to §5.
 */
const SPEC_ENDPOINTS = [
  'POST /auth/login',
  'POST /auth/logout',
  'GET /auth/session',
  'POST /auth/password',
  'GET /status',
  'GET /health',
  'GET /metrics',
  'GET /metrics/prometheus',
  'GET /metrics/prtg',
  'GET /config/:section',
  'PUT /config/:section',
  'POST /config/test/smb',
  'POST /config/test/ad',
  'POST /config/test/network',
  'GET /shares',
  'POST /shares',
  'GET /shares/:id',
  'PATCH /shares/:id',
  'DELETE /shares/:id',
  'POST /shares/:id/:action',
  'GET /files',
  'GET /locks',
  'POST /locks',
  'DELETE /locks/:id',
  'GET /conflicts',
  'POST /conflicts/:id/resolve',
  'POST /conflicts/:id/acknowledge',
  'GET /versions',
  'GET /versions/:id/download',
  'POST /versions/:id/restore',
  'POST /versions/:id/pin',
  'DELETE /versions/:id',
  'GET /logs',
  'GET /logs/stream',
  'GET /events/stream',
  'GET /system',
  'POST /system/:target',
  'GET /schedules',
  'POST /schedules',
  'GET /schedules/:id',
  'PATCH /schedules/:id',
  'DELETE /schedules/:id',
  'POST /schedules/preview',
  'POST /schedules/:id/run',
  'GET /update/status',
  'POST /update/check',
  'POST /update/apply',
  'POST /update/rollback',
  'GET /update/history',
  // Raspberry Pi OS packages, on their own schedule. Separate endpoints rather than a
  // flag on /update/*: an operator reading a failure needs to know which of the two
  // broke, because a bridge that will not start is a different problem from a Pi that
  // will not boot.
  'GET /os-update/status',
  'POST /os-update/run',
  'GET /network/interfaces',
  'POST /network/apply',
  'POST /network/confirm',
  'GET /network/pending',
  'GET /certificates',
  // The public certificate as a file. On a self-signed appliance this is the only way
  // out of the browser warning that does not involve SSH-ing in to copy it.
  'GET /certificates/download',
  'POST /certificates',
  'POST /certificates/regenerate',
  'GET /firewall',
  'PUT /firewall',
  'POST /firewall/reset',
  'GET /fail2ban/status',
  'POST /fail2ban/unban',
  'GET /tnc-clients',
  'GET /tnc-clients/:id',
  'PATCH /tnc-clients/:id',
  'GET /tokens',
  'POST /tokens',
  'DELETE /tokens/:id',
  'GET /setup/status',
  'POST /setup/password',
  'POST /setup/complete',
] as const;

const routeKey = (id: EndpointId): string => `${apiContract[id].method} ${apiContract[id].path}`;

const allRoutes = new Set(ENDPOINT_IDS.map(routeKey));

describe('API contract', () => {
  describe('coverage of IMPLEMENTATION_PLAN §5', () => {
    it.each(SPEC_ENDPOINTS)('defines %s', (route) => {
      expect(allRoutes.has(route)).toBe(true);
    });

    it('defines no route that §5 does not document', () => {
      const documented = new Set<string>(SPEC_ENDPOINTS);
      const undocumented = [...allRoutes].filter((r) => !documented.has(r));
      expect(undocumented).toEqual([]);
    });

    it('covers every documented endpoint exactly once', () => {
      expect(allRoutes.size).toBe(SPEC_ENDPOINTS.length);
    });
  });

  describe('structural invariants', () => {
    it('gives every endpoint a response schema', () => {
      for (const id of ENDPOINT_IDS) {
        expect(apiContract[id].response).toBeInstanceOf(z.ZodType);
      }
    });

    it('gives every endpoint a non-empty summary', () => {
      for (const id of ENDPOINT_IDS) {
        expect(apiContract[id].summary.length).toBeGreaterThan(10);
      }
    });

    it('declares a params schema covering every path placeholder', () => {
      for (const id of ENDPOINT_IDS) {
        const def = apiContract[id];
        const placeholders = [...def.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
        if (placeholders.length === 0) {
          expect('params' in def).toBe(false);
          continue;
        }
        const params = 'params' in def ? def.params : undefined;
        expect(params).toBeInstanceOf(z.ZodObject);
        const shape = Object.keys((params as z.ZodObject<z.ZodRawShape>).shape);
        for (const placeholder of placeholders) {
          expect(shape).toContain(placeholder);
        }
      }
    });

    it('never declares a request body on a GET or DELETE', () => {
      for (const id of ENDPOINT_IDS) {
        const def = apiContract[id];
        if (def.method === 'GET' || def.method === 'DELETE') {
          expect('body' in def).toBe(false);
        }
      }
    });

    it('marks every state-changing endpoint as mutating', () => {
      // The /config/test/* probes are POST because they take a credentials body,
      // but they change nothing — so they are deliberately not marked.
      const readOnlyPosts = new Set<string>([
        'config.testSmb',
        'config.testAd',
        'config.testNetwork',
      ]);
      for (const id of ENDPOINT_IDS) {
        const def = apiContract[id];
        if (def.method === 'GET') {
          expect('mutates' in def).toBe(false);
        } else if (!readOnlyPosts.has(id)) {
          expect('mutates' in def && def.mutates).toBe(true);
        }
      }
    });

    it('uses well-formed paths', () => {
      for (const id of ENDPOINT_IDS) {
        const { path } = apiContract[id];
        expect(path.startsWith('/')).toBe(true);
        expect(path.endsWith('/')).toBe(false);
        expect(path).not.toContain('//');
        expect(path).not.toContain(API_BASE_PATH);
      }
    });

    it('restricts write access to sessions — no token may mutate', () => {
      for (const id of ENDPOINT_IDS) {
        const def = apiContract[id];
        if ('mutates' in def && def.mutates) {
          expect(def.auth).not.toBe('session-or-token');
        }
      }
    });

    it('leaves only the documented endpoints unauthenticated', () => {
      const publicIds = ENDPOINT_IDS.filter((id) => apiContract[id].auth === 'public');
      expect(publicIds.sort()).toEqual(
        ['auth.login', 'health.get', 'setup.password', 'setup.status'].sort(),
      );
    });

    it('bypasses the envelope only where a consumer demands a fixed shape', () => {
      const unenveloped = ENDPOINT_IDS.filter(
        (id) => 'unenveloped' in apiContract[id] && apiContract[id].unenveloped,
      );
      expect(unenveloped.sort()).toEqual(
        [
          'events.stream',
          'logs.stream',
          'metrics.prometheus',
          'metrics.prtg',
          'versions.download',
          'certificates.download',
        ].sort(),
      );
    });
  });

  describe('buildPath', () => {
    it('prefixes the API base path', () => {
      expect(buildPath('status.get')).toBe(`${API_BASE_PATH}/status`);
    });

    it('substitutes path parameters', () => {
      expect(buildPath('shares.get', { id: 7 })).toBe(`${API_BASE_PATH}/shares/7`);
      expect(buildPath('shares.action', { id: 7, action: 'resync' })).toBe(
        `${API_BASE_PATH}/shares/7/resync`,
      );
    });

    it('encodes parameters so they cannot inject a path segment', () => {
      expect(buildPath('config.get', { section: 'sync/../../etc' })).toBe(
        `${API_BASE_PATH}/config/sync%2F..%2F..%2Fetc`,
      );
    });

    it('throws when a required parameter is missing', () => {
      expect(() => buildPath('shares.get')).toThrow(/Missing path parameter "id"/);
    });
  });

  describe('config section polymorphism', () => {
    it('resolves a real schema for every section', () => {
      for (const section of CONFIG_SECTION_NAMES) {
        expect(getConfigSectionSchema(section)).toBeInstanceOf(z.ZodType);
      }
    });

    it('parses a section payload through its own schema, not the generic one', () => {
      const parsed = getConfigSectionSchema('versioning').parse({});
      expect(parsed).toEqual({ enabled: true, keepCount: 20, keepDays: 90, maxStoreGb: 10 });
    });
  });

  describe('responseEnvelopeSchema', () => {
    it('wraps the payload in the success envelope', () => {
      const schema = responseEnvelopeSchema('auth.logout');
      expect(schema.parse({ ok: true, data: { acknowledged: true } })).toEqual({
        ok: true,
        data: { acknowledged: true },
      });
      expect(() => schema.parse({ ok: false, data: { acknowledged: true } })).toThrow();
    });
  });
});

import { isIP } from 'node:net';
import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';
import { readResponseTextCapped } from './common/http.js';

const TTL = 10 * 60_000;
const text = (value, max = 200) =>
  typeof value === 'string' ? value.slice(0, max) : '';
const coordinate = (value, limit) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) <= limit
    ? value
    : null;

/** Only expose useful observations, never arbitrary banners or upstream HTML. */
export function normalizeShodanHost(raw = {}) {
  const location = raw.location || raw;
  return {
    ip: isIP(raw.ip_str || '') ? raw.ip_str : '',
    organization: text(raw.org),
    asn: text(raw.asn), isp: text(raw.isp), os: text(raw.os),
    domains: Array.isArray(raw.domains) ? raw.domains.slice(0,30).map(v=>text(v)) : [],
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0,30).map(v=>text(v)) : [],
    hostnames: Array.isArray(raw.hostnames)
      ? raw.hostnames.slice(0, 10).map((v) => text(v))
      : [],
    country: text(location.country_name),
    city: text(location.city),
    latitude: coordinate(location.latitude, 90),
    longitude: coordinate(location.longitude, 180),
    observedAt: text(raw.timestamp || raw.last_update, 40),
    ports: [
      ...new Set(
        (Array.isArray(raw.ports) ? raw.ports : [raw.port]).filter(
          (p) => Number.isInteger(p) && p >= 0 && p <= 65535,
        ),
      ),
    ].slice(0, 100),
    services: (Array.isArray(raw.data) ? raw.data : [raw])
      .slice(0, 100)
      .map((service) => ({
        port: Number.isInteger(service.port) ? service.port : null,
        transport: text(service.transport, 10),
        product: text(service.product),
        httpTitle: text(service.http?.title),
        tls: service.ssl?.cert ? {subject:text(service.ssl.cert.subject?.CN),issuer:text(service.ssl.cert.issuer?.CN),expires:text(service.ssl.cert.expires),sha256:text(service.ssl.cert.fingerprint?.sha256)} : null,
        vulnerabilities: Object.keys(service.vulns || {}).filter(v=>/^CVE-\d{4}-\d+$/.test(v)).slice(0,100),
        version: text(service.version, 80),
        observedAt: text(service.timestamp, 40),
      })),
  };
}

/** Standalone local-only API: exact-origin POSTs, bounded memory and credit use. */
export function createShodanMiddleware({
  fetchImpl = fetch,
  env = process.env,
  now = Date.now,
} = {}) {
  const cache = new Map();
  const pending = new Map();
  let activeKey = '';
  let windowStart = now();
  let requests = 0;
  let lastRequest = -Infinity;
  const send = (res, code, payload) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(JSON.stringify(payload));
  };
  return async (req, res) => {
    const admission = admitKeySetupRequest({
      method: req.method,
      remoteAddress: req.socket?.remoteAddress,
      hostHeader: req.headers.host,
      protocol: req.socket?.encrypted ? 'https:' : 'http:',
      origin: req.headers.origin,
      contentType: req.headers['content-type'],
      proxyHeaders: req.headers,
      env,
    });
    if (!admission.ok)
      return send(res, admission.status, {
        error:
          'Shodan is available only from this computer using the local app.',
      });
    const route = new URL(req.url, 'http://localhost').pathname;
    const key = String(env.SHODAN_API_KEY || '').trim();
    if (key !== activeKey) {
      cache.clear();
      pending.clear();
      activeKey = key;
    }
    if (route === '/status' && req.method === 'GET')
      return send(res, 200, { configured: Boolean(key) });
    if (!['/host', '/search', '/count', '/account'].includes(route))
      return send(res, 404, { error: 'Unknown Shodan route.' });
    if (req.method !== 'POST')
      return send(res, 405, { error: 'Use POST for Shodan lookups.' });
    if (!key)
      return send(res, 503, {
        error: 'Add your Shodan API key in POWER UP → SHODAN.',
      });
    let input;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 2048)
          return send(res, 413, { error: 'Request too large.' });
      }
      input = JSON.parse(body);
    } catch {
      return send(res, 400, { error: 'Invalid JSON request.' });
    }
    const query = typeof input?.query === 'string' ? input.query.trim() : '';
    if (route !== '/account' && (
      !query ||
      query.length > 300 ||
      /[\x00-\x1f]/.test(query) ||
      (route === '/host' && !isIP(query))
    )) {
      return send(res, 400, {
        error:
          route === '/host'
            ? 'Enter a valid IPv4 or IPv6 address.'
            : 'Enter a search query of 1–300 characters.',
      });
    }
    const page = input.page ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > 100) return send(res,400,{error:'Page must be an integer from 1 to 100.'});
    if (input.history !== undefined && typeof input.history !== 'boolean') return send(res,400,{error:'History must be a boolean.'});
    const history = input.history === true;
    const id = JSON.stringify([route,query,page,history]);
    const stored = cache.get(id);
    if (stored && now() - stored.time < TTL)
      return send(res, 200, { ...stored.payload, cached: true });
    try {
      let task = pending.get(id);
      if (!task) {
        if (now() - windowStart >= 3_600_000) {
          windowStart = now();
          requests = 0;
        }
        if (requests >= 30 || now() - lastRequest < 2000)
          return send(res, 429, {
            error:
              'Local request limit reached. Wait before searching again (30 upstream requests per hour).',
          });
        requests++;
        lastRequest = now();
        task = (async () => {
          const url = new URL(
            route === '/host'
              ? `/shodan/host/${encodeURIComponent(query)}`
              : route === '/account' ? '/api-info' : route === '/count' ? '/shodan/host/count' : '/shodan/host/search',
            'https://api.shodan.io',
          );
          url.searchParams.set('key', key);
          url.searchParams.set('minify', route === '/host' ? 'false' : 'true');
          if (route === '/host') url.searchParams.set('history',String(history));
          if (route === '/search' || route === '/count') {
            url.searchParams.set('query', query);
            url.searchParams.set('page', String(page));
            url.searchParams.set('facets','country:10,org:10,port:10,product:10');
          }
          const timeout = AbortSignal.timeout(15_000);
          const response = await fetchImpl(url, {
            signal: timeout,
            redirect: 'error',
          });
          if (!response.ok) {
            await response.body?.cancel();
            const messages = {
              401: 'Shodan rejected the API key.',
              403: 'Your Shodan plan does not allow this query, or credits are exhausted.',
              404: 'Shodan has no observations for this IP.',
              429: 'Shodan rate limit reached. Try again later.',
            };
            throw Object.assign(
              new Error(
                messages[response.status] ||
                  'Shodan could not complete this query.',
              ),
              {
                publicStatus: [401, 403, 404, 429].includes(response.status)
                  ? response.status
                  : 502,
              },
            );
          }
          const raw = JSON.parse(
            await readResponseTextCapped(response, 4 * 1024 * 1024, timeout),
          );
          if (route === '/account') return {
            plan:text(raw.plan), queryCredits:Number.isFinite(raw.query_credits)?raw.query_credits:null,
            scanCredits:Number.isFinite(raw.scan_credits)?raw.scan_credits:null,
            monitoredIPs:Number.isFinite(raw.monitored_ips)?raw.monitored_ips:null,
            unlocked:raw.unlocked === true, retrievedAt:new Date(now()).toISOString(),
          };
          const facets = Object.fromEntries(['country','org','port','product'].map(name=>[name,
            Array.isArray(raw.facets?.[name]) ? raw.facets[name].slice(0,10).map(item=>({value:text(String(item.value),120),count:Number.isFinite(item.count)?item.count:0})) : []
          ]));
          const hosts = (
            route === '/host'
              ? [raw]
              : Array.isArray(raw.matches)
                ? raw.matches.slice(0, 100)
                : []
          )
            .map(normalizeShodanHost)
            .filter((h) => h.ip);
          const payload = {
            hosts, facets, page, history,
            total:
              route === '/host'
                ? hosts.length
                : Number.isFinite(raw.total)
                  ? raw.total
                  : hosts.length,
            retrievedAt: new Date(now()).toISOString(),
            cached: false,
          };
          if (activeKey === key) {
            if (cache.size >= 50) cache.delete(cache.keys().next().value);
            cache.set(id, { time: now(), payload });
          }
          return payload;
        })();
        pending.set(id, task);
        task
          .finally(() => {
            if (pending.get(id) === task) pending.delete(id);
          })
          .catch(() => {});
      }
      return send(res, 200, await task);
    } catch (error) {
      // Never log/return fetch errors: they may contain the credential URL.
      return send(res, error.publicStatus || 502, {
        error: error.publicStatus
          ? error.message
          : 'Shodan is unavailable or timed out. Please try again.',
      });
    }
  };
}

export function shodanProxy() {
  const middleware = createShodanMiddleware();
  const install = (server) => {
    server.middlewares.use('/api/shodan', middleware);
  };
  return {
    name: 'shodan-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}

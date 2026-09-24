import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  createShodanMiddleware,
  normalizeShodanHost,
} from '../../server/providers/shodan.js';

async function call(
  middleware,
  {
    route = '/host',
    query = '8.8.8.8',
    method = 'POST',
    remote = '127.0.0.1',
    origin = 'http://localhost:4173',
    extraHeaders = {},
  } = {},
) {
  const req = Readable.from([JSON.stringify({ query })]);
  req.url = route;
  req.method = method;
  req.socket = { remoteAddress: remote };
  req.headers = {
    host: 'localhost:4173',
    origin,
    'content-type': 'application/json',
    ...extraHeaders,
  };
  const headers = {};
  const res = {
    setHeader: (name, value) => {
      headers[name] = value;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
  await middleware(req, res);
  return { code: res.statusCode, body: res.body, headers };
}
const fixture = {
  ip_str: '8.8.8.8',
  org: 'Google',
  latitude: null,
  longitude: null,
  ports: [53],
  data: [
    {
      port: 53,
      transport: 'udp',
      product: 'DNS',
      data: '<script>unsafe</script>',
      timestamp: '2026-09-12T00:00:00',
    },
  ],
};

test('Shodan preserves missing coordinates and excludes arbitrary banners', () => {
  const host = normalizeShodanHost(fixture);
  assert.equal(host.latitude, null);
  assert.equal(host.longitude, null);
  assert.equal(JSON.stringify(host).includes('<script>'), false);
  assert.equal(
    normalizeShodanHost({ ...fixture, latitude: 0, longitude: 0 }).latitude,
    0,
  );
  assert.equal(
    normalizeShodanHost({ ...fixture, latitude: 100 }).latitude,
    null,
  );
});

test('Shodan rejects remote, cross-origin, proxied, keyless and invalid requests without contacting upstream', async () => {
  let calls = 0;
  const middleware = createShodanMiddleware({
    env: { SHODAN_API_KEY: 'fixture-secret' },
    fetchImpl: () => {
      calls++;
      throw Error('unexpected');
    },
  });
  for (const options of [
    { remote: '10.0.0.2' },
    { origin: 'https://evil.example' },
    { origin: '' },
    { extraHeaders: { 'x-forwarded-for': '1.2.3.4' } },
  ])
    assert.equal((await call(middleware, options)).code, 403);
  assert.equal((await call(middleware, { query: 'not an IP' })).code, 400);
  assert.equal((await call(middleware, { method: 'GET' })).code, 405);
  const keyless = await call(createShodanMiddleware({ env: {} }));
  assert.equal(keyless.code, 503);
  assert.equal(keyless.headers['Cache-Control'], 'private, no-store');
  assert.equal(calls, 0);
});

test('Shodan coalesces concurrent requests, caches successes, and gates cache access', async () => {
  let calls = 0;
  const middleware = createShodanMiddleware({
    env: { SHODAN_API_KEY: 'fixture-secret' },
    fetchImpl: async (url) => {
      calls++;
      assert.equal(url.hostname, 'api.shodan.io');
      return new Response(JSON.stringify(fixture));
    },
  });
  const [a, b] = await Promise.all([call(middleware), call(middleware)]);
  assert.equal(a.code, 200);
  assert.equal(b.code, 200);
  assert.equal(calls, 1);
  const cached = await call(middleware);
  assert.equal(cached.body.cached, true);
  assert.equal(calls, 1);
  assert.equal((await call(middleware, { remote: '10.0.0.2' })).code, 403);
  assert.equal(JSON.stringify(cached).includes('fixture-secret'), false);
  assert.equal((await call(middleware, { query: '1.1.1.1' })).code, 429);
});

test('Shodan caps search page and redacts upstream errors containing credentials', async () => {
  const search = createShodanMiddleware({
    env: { SHODAN_API_KEY: 'fixture-secret' },
    fetchImpl: async (url) => {
      assert.equal(url.searchParams.get('page'), '1');
      assert.equal(url.searchParams.get('query'), 'country:US');
      return new Response(JSON.stringify({ matches: [fixture], total: 5000 }));
    },
  });
  const result = await call(search, { route: '/search', query: 'country:US' });
  assert.equal(result.code, 200);
  assert.equal(result.body.total, 5000);
  const broken = createShodanMiddleware({
    env: { SHODAN_API_KEY: 'fixture-secret' },
    fetchImpl: async () => {
      throw Error('https://api.shodan.io/?key=fixture-secret');
    },
  });
  const error = await call(broken);
  assert.equal(error.code, 502);
  assert.equal(JSON.stringify(error).includes('fixture-secret'), false);
});

test('Shodan invalidates cached results after a key change and enforces the hourly budget', async () => {
  let clock = 0;
  let calls = 0;
  const env = { SHODAN_API_KEY: 'first-fixture' };
  const middleware = createShodanMiddleware({
    env,
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify(fixture));
    },
  });
  await call(middleware);
  env.SHODAN_API_KEY = 'second-fixture';
  clock += 3000;
  assert.equal((await call(middleware)).body.cached, false);
  for (let i = 0; i < 28; i++) {
    clock += 3000;
    assert.equal((await call(middleware, { query: `8.8.4.${i}` })).code, 200);
  }
  clock += 3000;
  assert.equal((await call(middleware, { query: '1.1.1.1' })).code, 429);
  assert.equal(calls, 30);
});

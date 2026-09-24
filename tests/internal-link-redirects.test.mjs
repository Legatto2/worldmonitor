import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { buildCorpus } from '../scripts/build-crawlable-corpus.mjs';
import { LEGAL_DOCUMENT_DIGESTS } from '../shared/legal.ts';

// #8603. Googlebot follows an internal link as a crawl signal. A link that
// redirects wastes a fetch and sends the signal to a non-canonical URL, and a
// link that 404s wastes the fetch entirely. Both are generator defects, not
// content defects: one `withUtmSource()` line put a 308 on 300+ published
// pages and one byline literal put a 307 on 275. This suite is the build-time
// half of that, so the next such line reds a PR instead of Search Console.
//
// The helpers below deliberately mirror the small readers in
// tests/crawlable-corpus.test.mjs (`read`, `generatedPageRoutes`,
// `decodeHtmlAttribute`). Those are module-private to a 7,700-line suite that
// takes about 90 seconds to import, so importing them here would run that
// suite as a side effect of this one.

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WWW_ORIGIN = 'https://www.worldmonitor.app';

function readRepo(relative) {
  return readFileSync(join(repoRoot, relative), 'utf8');
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * The query keys middleware strips with a 308. Re-derived from middleware.ts
 * rather than copied: a hand-copied list keeps passing after middleware adds a
 * key, which is exactly the silent-drift failure this gate exists to prevent.
 */
function indexNoiseQueryKeys() {
  const source = readRepo('middleware.ts');
  const block = source.match(/const INDEX_NOISE_QUERY_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(block, 'INDEX_NOISE_QUERY_KEYS extraction from middleware.ts found nothing');
  const keys = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(keys.includes('utm_source'), `expected utm_source in ${JSON.stringify(keys)}`);
  assert.ok(keys.includes('ref') && keys.includes('wm_referral'), `expected the referral keys in ${JSON.stringify(keys)}`);
  return keys;
}

/** Variant dashboard hosts, re-derived from middleware VARIANT_HOST_MAP. */
function variantHosts() {
  const source = readRepo('middleware.ts');
  const block = source.match(/const VARIANT_HOST_MAP: Record<string, string> = \{([\s\S]*?)\}/)?.[1];
  assert.ok(block, 'VARIANT_HOST_MAP extraction from middleware.ts found nothing');
  const hosts = [...block.matchAll(/'([a-z]+\.worldmonitor\.app)'/g)].map((match) => match[1]);
  assert.ok(hosts.length >= 5, `expected the variant hosts, got ${JSON.stringify(hosts)}`);
  return hosts;
}

const vercelConfig = JSON.parse(readRepo('vercel.json'));

/**
 * The legal set is content-locked by a digest in shared/legal.ts, and all four
 * documents share one TERMS_VERSION that a checkout acceptance record points
 * at. Editing one — even to retarget a hyperlink — forces a version bump that
 * tells every buyer the terms they accepted changed, so a link fix there has
 * to ride a real legal revision rather than an SEO pass. Only the
 * redirect-source rule is waived: an index-noise key or a bare variant host in
 * these documents still fails. Residual as of #8603: docs/terms.mdx and its zh
 * mirror link https://www.worldmonitor.app/docs, a 307 to /docs/documentation.
 */
const DIGEST_LOCKED_DOCS = new Set(Object.keys(LEGAL_DOCUMENT_DIGESTS)
  .flatMap((doc) => [doc, doc.replace(/^docs\//, 'docs/zh/')]));

/**
 * Redirect `source` values that fire for a request to `host`. Vercel applies
 * `redirects` before middleware, and a `has` host condition scopes a rule to
 * the hosts its regex matches — so `/` is a redirect on a variant host and a
 * real page on www, and a host-blind check would reject every homepage link.
 * Only parameter-free sources are returned: those are the ones an href can
 * equal exactly.
 */
function literalRedirectSourcesFor(host) {
  return new Set(vercelConfig.redirects
    .filter((rule) => {
      const hostCondition = (rule.has ?? []).find((condition) => condition.type === 'host');
      return !hostCondition || new RegExp(hostCondition.value).test(host);
    })
    .map((rule) => rule.source)
    .filter((source) => !source.includes(':')));
}

/** Every path the generated corpus actually writes: `/a/b/` for index.html, `/a/b.json` for a file. */
function generatedRoutes(outDir) {
  const routes = new Set();
  const visit = (relative) => {
    for (const entry of readdirSync(join(outDir, relative), { withFileTypes: true })) {
      const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.name === 'index.html') routes.add(`/${relative === '.' ? '' : `${relative}/`}`);
      else routes.add(`/${child}`);
    }
  };
  visit('.');
  return routes;
}

/**
 * Published documentation routes. Mintlify serves `/docs/<page>` only when the
 * page is BOTH a file on disk and listed in docs.json navigation, so the
 * intersection is the route set — a nav entry with no file 404s, and this repo
 * currently has three of those.
 */
function docsRoutes() {
  const config = JSON.parse(readRepo('docs/docs.json'));
  const navPages = [];
  const walk = (node) => {
    if (typeof node === 'string') navPages.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(config.navigation);
  assert.ok(navPages.length > 100, `docs.json navigation extraction found ${navPages.length} pages`);
  const files = new Set();
  const visit = (relative) => {
    for (const entry of readdirSync(join(repoRoot, 'docs', relative), { withFileTypes: true })) {
      const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.name.endsWith('.mdx')) files.add(child.slice(0, -'.mdx'.length));
    }
  };
  visit('.');
  return new Set(navPages.filter((page) => files.has(page)).map((page) => `/docs/${page}`));
}

/** Astro blog routes: the two index pages plus one route per post and per glossary term. */
function blogRoutes(manifest) {
  const routes = new Set(['/blog/', '/blog/glossary/', '/blog/authors/elie-habib/']);
  for (const file of readdirSync(join(repoRoot, 'blog-site/src/content/blog'))) {
    if (file.endsWith('.md')) routes.add(`/blog/posts/${file.slice(0, -'.md'.length)}/`);
  }
  for (const route of manifest.sections.glossary.routes) routes.add(route);
  assert.ok(routes.size > 50, `blog route extraction found ${routes.size} routes`);
  return routes;
}

/**
 * Application routes the SPA answers directly. Taken from vercel.json
 * `rewrites` (a parameter-free rewrite source is by definition a 200), plus
 * `/` — the homepage is only ever a CONDITIONAL rewrite source, so it never
 * appears in that list even though it is the most-linked page on the site.
 */
function appRoutes() {
  const routes = new Set(vercelConfig.rewrites
    .map((rule) => rule.source)
    .filter((source) => !source.includes(':')));
  routes.add('/');
  return routes;
}

function knownRoutes(outDir, manifest) {
  return new Set([
    ...generatedRoutes(outDir),
    ...docsRoutes(),
    ...blogRoutes(manifest),
    ...appRoutes(),
  ]);
}

/**
 * Every same-site href in the generated corpus, as {page, href, url}. Anchors
 * only (`<a href>`): a `<link rel>` or an asset src is not a crawl signal of
 * this kind.
 */
function* corpusHrefs(outDir) {
  const pages = readdirSync(outDir, { recursive: true }).map(String).filter((path) => path.endsWith('.html'));
  for (const page of pages) {
    const html = readFileSync(join(outDir, page), 'utf8');
    for (const [, raw] of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
      const href = decodeHtmlAttribute(raw);
      if (/^(?:mailto:|tel:|#)/.test(href)) continue;
      let url;
      try {
        url = new URL(href, WWW_ORIGIN);
      } catch {
        continue;
      }
      if (!/(^|\.)worldmonitor\.app$/.test(url.hostname)) continue;
      yield { page, href, url };
    }
  }
}

/**
 * The four link defects, as a list of human-readable strings. Returned rather
 * than asserted per href so a red run names every offender at once instead of
 * one per re-run.
 */
function linkViolations({ page, href, url }, { noiseKeys, hosts, routes, slashlessCorpusForms }) {
  const violations = [];
  const where = `${page}: ${href}`;
  const carried = noiseKeys.filter((key) => url.searchParams.has(key));
  if (carried.length > 0) {
    violations.push(`${where} — carries index-noise query key(s) ${carried.join(', ')} (middleware 308s them away)`);
  }
  if (hosts.includes(url.hostname) && (url.pathname === '/' || url.pathname === '')) {
    violations.push(`${where} — links a bare variant host (308 to /dashboard); link the /dashboard path directly`);
  }
  if (literalRedirectSourcesFor(url.hostname).has(url.pathname)) {
    violations.push(`${where} — equals a vercel.json redirect source, so it never answers 200`);
  }
  if (slashlessCorpusForms.has(url.pathname)) {
    violations.push(`${where} — slashless form of a slash-normalised corpus route; link ${url.pathname}/`);
  }
  // Variant and api hosts serve a different application from a different
  // route table, so only www hrefs are resolved against the www route set.
  if (url.hostname === 'www.worldmonitor.app' && !routes.has(url.pathname)) {
    violations.push(`${where} — resolves to no published route (404)`);
  }
  return violations;
}

describe('internal links never redirect or 404 (#8603)', () => {
  it('publishes no corpus href that redirects, 404s, or carries index noise', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'wm-internal-links-'));
    try {
      const manifest = await buildCorpus({ rootDir: repoRoot, outDir, baseUrl: WWW_ORIGIN });
      const routes = knownRoutes(outDir, manifest);
      const slashlessCorpusForms = new Set([...generatedRoutes(outDir)]
        .filter((route) => route.endsWith('/') && route !== '/')
        .map((route) => route.slice(0, -1)));
      const context = { noiseKeys: indexNoiseQueryKeys(), hosts: variantHosts(), routes, slashlessCorpusForms };

      const violations = [];
      let scanned = 0;
      for (const href of corpusHrefs(outDir)) {
        scanned += 1;
        violations.push(...linkViolations(href, context));
      }
      // A floor, because the scan must not silently cover nothing: the corpus
      // publishes thousands of same-site anchors across ~280 pages.
      assert.ok(scanned > 5000, `expected the whole corpus to be scanned, saw ${scanned} same-site hrefs`);
      // Deduplicated by shape so 196 identical country CTAs read as one line.
      const unique = [...new Set(violations.map((line) => line.replace(/^[^:]+: /, '')))];
      assert.deepEqual(
        unique,
        [],
        `${violations.length} internal links do not answer 200:\n${unique.slice(0, 40).join('\n')}`,
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('publishes no docs or blog source link that redirects or carries index noise', () => {
    const noiseKeys = indexNoiseQueryKeys();
    const hosts = variantHosts();
    const sources = [];
    const published = docsRoutes();
    const visit = (relative) => {
      for (const entry of readdirSync(join(repoRoot, 'docs', relative), { withFileTypes: true })) {
        const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) visit(child);
        else if (entry.name.endsWith('.mdx') && published.has(`/docs/${child.slice(0, -'.mdx'.length)}`)) {
          sources.push([`docs/${child}`, readRepo(`docs/${child}`)]);
        }
      }
    };
    visit('.');
    for (const file of readdirSync(join(repoRoot, 'blog-site/src/content/blog'))) {
      if (file.endsWith('.md')) sources.push([`blog-site/src/content/blog/${file}`, readRepo(`blog-site/src/content/blog/${file}`)]);
    }
    assert.ok(sources.length > 200, `expected published docs and blog sources, saw ${sources.length}`);

    const violations = [];
    for (const [file, source] of sources) {
      // Markdown links and raw anchors only. An inline-code or fenced origin
      // string such as the WebMCP allow-list is documentation OF a host, not a
      // link to it, and rewriting it would falsify the document.
      const targets = [
        ...[...source.matchAll(/\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/g)].map((match) => match[1]),
        ...[...source.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => decodeHtmlAttribute(match[1])),
      ];
      // Mintlify resolves a root-relative link in an .mdx against the docs
      // base path, so `[Terms](/terms)` renders as href="/docs/terms" (probed
      // on www.worldmonitor.app/docs/dpa, 2026-09-24). Judging those against
      // the site root would report every one of them as a redirect it is not.
      const base = file.startsWith('docs/') ? `${WWW_ORIGIN}/docs/` : WWW_ORIGIN;
      for (const target of targets) {
        let url;
        try {
          url = new URL(target.startsWith('/') ? `.${target}` : target, base);
        } catch {
          continue;
        }
        if (!/(^|\.)worldmonitor\.app$/.test(url.hostname)) continue;
        const where = `${file}: ${target}`;
        const carried = noiseKeys.filter((key) => url.searchParams.has(key));
        if (carried.length > 0) violations.push(`${where} — carries index-noise query key(s) ${carried.join(', ')}`);
        if (hosts.includes(url.hostname) && (url.pathname === '/' || url.pathname === '')) {
          violations.push(`${where} — links a bare variant host (308 to /dashboard)`);
        }
        if (!DIGEST_LOCKED_DOCS.has(file) && literalRedirectSourcesFor(url.hostname).has(url.pathname)) {
          violations.push(`${where} — equals a vercel.json redirect source, so it never answers 200`);
        }
      }
    }
    assert.deepEqual(violations, [], `${violations.length} docs or blog links do not answer 200:\n${violations.join('\n')}`);
  });

  it('publishes no welcome-page href that redirects or carries index noise', () => {
    const noiseKeys = indexNoiseQueryKeys();
    const hosts = variantHosts();
    const welcomeDir = join(repoRoot, 'pro-test/src/welcome');
    const files = readdirSync(welcomeDir).filter((file) => file.endsWith('.tsx'));
    assert.ok(files.length > 0, 'expected welcome section sources to scan');
    const violations = [];
    let scanned = 0;
    for (const file of files) {
      const source = readFileSync(join(welcomeDir, file), 'utf8');
      // `${DASHBOARD_PATH}` is the one template hole in these hrefs; it always
      // expands to a path, so substituting it keeps the URL parseable.
      const targets = [...source.matchAll(/href[=:]\s*[{`'"]+((?:\$\{DASHBOARD_PATH\}|https:\/\/[a-z.]*worldmonitor\.app|\/)[^`'"\s]*)/g)]
        .map((match) => match[1].replaceAll('${DASHBOARD_PATH}', '/dashboard'));
      for (const target of targets) {
        let url;
        try {
          url = new URL(target, WWW_ORIGIN);
        } catch {
          continue;
        }
        if (!/(^|\.)worldmonitor\.app$/.test(url.hostname)) continue;
        scanned += 1;
        const where = `pro-test/src/welcome/${file}: ${target}`;
        const carried = noiseKeys.filter((key) => url.searchParams.has(key));
        if (carried.length > 0) violations.push(`${where} — carries index-noise query key(s) ${carried.join(', ')}`);
        if (hosts.includes(url.hostname) && (url.pathname === '/' || url.pathname === '')) {
          violations.push(`${where} — links a bare variant host (308 to /dashboard)`);
        }
        if (literalRedirectSourcesFor(url.hostname).has(url.pathname)) {
          violations.push(`${where} — equals a vercel.json redirect source, so it never answers 200`);
        }
      }
    }
    assert.ok(scanned >= 20, `expected the welcome CTAs to be scanned, saw ${scanned}`);
    assert.deepEqual(violations, [], `${violations.length} welcome links do not answer 200:\n${violations.join('\n')}`);
  });
});

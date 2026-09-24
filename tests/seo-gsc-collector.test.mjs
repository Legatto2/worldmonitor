import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

import {
  assertNoSecrets,
  collectGscSnapshot,
  createFixtureTransport,
  createServiceAccountAssertion,
  decodeServiceAccount,
  describeDisagreement,
  buildInventory,
  pickIndexStatus,
  renderGscMarkdown,
  runCli,
  stratifiedSample,
  toScorecardSearchExport,
} from '../scripts/seo-gsc-collect.mjs';
import { normalizeSearchExport } from '../scripts/seo-ai-visibility-collector.mjs';

const repoPath = (relativePath) => new URL(`../${relativePath}`, import.meta.url).pathname;

const FIXTURES = 'tests/fixtures/gsc/';
const silent = () => {};

const collect = async (fixtures = FIXTURES) => {
  const { snapshot, markdown } = await runCli(
    ['--fixtures', fixtures, '--stdout'],
    { log: silent },
  );
  return { snapshot, markdown };
};

const querySet = JSON.parse(
  readFileSync(repoPath('docs/research/seo-ai-visibility/query-set.json'), 'utf8'),
);

describe('Search Console collector', () => {
  it('produces the same snapshot from the same fixtures', async () => {
    const first = await collect();
    const second = await collect();
    assert.deepEqual(first.snapshot, second.snapshot);
    assert.equal(first.markdown, second.markdown);
    assert.equal(first.snapshot.observedAt, '2026-09-24T00:00:00Z');
    assert.equal(first.snapshot.snapshotId, 'gsc-2026-09-24');
  });

  it('writes a dated snapshot and a markdown summary', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'wm-gsc-'));
    try {
      const { written } = await runCli(
        ['--fixtures', FIXTURES, '--out-dir', outDir],
        { log: silent },
      );
      assert.deepEqual(
        readdirSync(outDir).sort(),
        ['2026-09-24.json', '2026-09-24.md'],
      );
      for (const path of written) assert.ok(statSync(path).size > 0, path);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('pages past a row-limit boundary instead of stopping at the first page', async () => {
    const { snapshot } = await collect();
    const window28 = snapshot.performance.windows.find((entry) => entry.label === '28d');
    // Page 0 of the recording holds exactly rowLimit rows, so a collector that
    // does not paginate would report 3 and miss the rest.
    assert.equal(window28.rowCounts.page, 5);
    const countries = window28.byFamily.country_pages;
    assert.ok(countries, 'the second page contributed a family the first page did not');
    assert.equal(countries.impressions, 44);
    assert.equal(window28.status, 'available');
  });

  it('keeps the rows it collected when the quota runs out mid-pagination', async () => {
    const { snapshot } = await collect();
    const window90 = snapshot.performance.windows.find((entry) => entry.label === '90d');
    assert.equal(window90.status, 'partial');
    assert.match(window90.reason, /quota was exhausted/);
    // The rows already collected stay. A quota-exhausted run must not report
    // zero, because zero is a measurement and this is an absence of one.
    assert.equal(window90.rowCounts.query, 3);
    assert.ok(window90.totals.impressions > 0);
    assert.equal(snapshot.performance.status, 'partial');
    assert.ok(snapshot.samplingNotes.some((note) => note.includes('quota was exhausted')));
  });

  it('stops inspecting and says so when the urlInspection quota runs out', async () => {
    const { snapshot } = await collect(`${FIXTURES}quota/`);
    assert.equal(snapshot.indexation.status, 'partial');
    assert.match(snapshot.indexation.reason, /quota was exhausted/);
    assert.ok(snapshot.indexation.sample.inspected < snapshot.inventory.declared);
    assert.equal(snapshot.indexation.sample.complete, false);
    assert.equal(snapshot.indexation.sample.extrapolated, false);
  });

  it('records a googleCanonical that differs from the declared canonical', async () => {
    const { snapshot } = await collect();
    const mismatches = snapshot.indexation.canonicalMismatches;
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].url, 'https://www.worldmonitor.app/compare/worldmonitor-vs-acled/');
    assert.equal(mismatches[0].googleCanonical, 'https://www.worldmonitor.app/compare/');
    assert.notEqual(mismatches[0].googleCanonical, mismatches[0].userCanonical);
  });

  it('fails the run on a URL that maps to no family', async () => {
    await assert.rejects(
      () => collect(`${FIXTURES}unmapped/`),
      /does not map to a page family/,
    );
  });

  it('flags a live status that contradicts the recorded coverage state', async () => {
    const { snapshot } = await collect();
    const flagged = snapshot.indexation.liveStateDisagreements;
    const redirected = flagged.find(
      (row) => row.url === 'https://www.worldmonitor.app/crises/sudan-conflict/',
    );
    assert.ok(redirected, 'a recorded 404 that now redirects must be flagged');
    assert.equal(redirected.coverageState, 'Not found (404)');
    assert.equal(redirected.liveStatus, 301);
    assert.equal(redirected.disagreement, 'google-recorded-404-live-redirects');
    // Flagged, not resolved: the coverage state is still reported as Google
    // recorded it, so a reader sees both numbers rather than a silent fix.
    assert.equal(
      snapshot.indexation.byFamily.crises.coverageStates['Not found (404)'],
      1,
    );
  });

  it('carries a host dimension for the apex and the variant hosts', async () => {
    const { snapshot } = await collect();
    assert.deepEqual(
      Object.keys(snapshot.inventory.byHost).sort(),
      ['tech.worldmonitor.app', 'worldmonitor.app', 'www.worldmonitor.app'],
    );
    assert.equal(snapshot.indexation.byHost['worldmonitor.app'].declared, 1);
    assert.equal(snapshot.indexation.byHost['tech.worldmonitor.app'].indexed, 1);
    // Without the host dimension the www denominator would absorb both.
    assert.equal(snapshot.indexation.byHost['www.worldmonitor.app'].declared, 13);
  });

  it('reports HTML indexability apart from subresources and markdown twins', async () => {
    const { snapshot } = await collect();
    const { byKind, htmlPages } = snapshot.indexation;
    assert.equal(byKind.subresource.crawledNotIndexed, 1);
    assert.equal(byKind.subresource.servingNoindex, 1);
    assert.equal(byKind['markdown-twin'].crawledNotIndexed, 1);
    // The headline counts only HTML, and only the cell that warrants
    // attention: crawled, declined, no noindex, still answering as HTML.
    assert.equal(htmlPages.crawledNotIndexed, 1);
    assert.equal(htmlPages.actionable, 1);
    assert.equal(
      htmlPages.actionableUrls[0].url,
      'https://www.worldmonitor.app/countries/france/',
    );
    assert.equal(htmlPages.indexedShare.basis, 'inspected-html');
  });

  it('records a content-type that contradicts the URL extension', async () => {
    const { snapshot } = await collect();
    const disagreements = snapshot.indexation.kindDisagreements;
    assert.equal(disagreements.length, 1);
    assert.equal(disagreements[0].url, 'https://www.worldmonitor.app/pricing.md');
    assert.equal(disagreements[0].declaredKind, 'markdown-twin');
    assert.equal(disagreements[0].observedKind, 'html');
  });

  it('keeps an unmeasured value null with a reason rather than zero', async () => {
    const { snapshot } = await collect();
    // The blog post has no recorded inspection. Reporting it as not indexed
    // would invent a measurement.
    const blog = snapshot.indexation.byFamily.blog;
    assert.equal(blog.inspected, 1);
    assert.equal(blog.indexed, null);
    assert.match(blog.indexedReason, /no URL in this group returned an index status/);
    assert.equal(blog.indexedShare.value, null);
    const window28 = snapshot.performance.windows.find((entry) => entry.label === '28d');
    assert.equal(window28.byFamily.blog.ctr, null);
    assert.equal(window28.byFamily.blog.impressionsPerIndexedUrl, null);
    assert.match(
      window28.byFamily.blog.impressionsPerIndexedUrlReason,
      /no URL in this family was confirmed indexed/,
    );
  });

  it('labels a capped export and never projects its share onto the reported total', async () => {
    const { snapshot, markdown } = await collect();
    const capped = snapshot.samplingNotes.find((note) => note.includes('1486'));
    assert.ok(capped, 'a reported total larger than the rows seen must be labelled');
    assert.match(capped, /capped/);
    assert.match(capped, /Do not multiply a share/);
    const complete = snapshot.samplingNotes.find((note) => note.includes('Not found (404)'));
    assert.match(complete, /complete/);
    assert.match(markdown, /Do not multiply a share/);
    const shares = [
      snapshot.indexation.htmlPages.indexedShare,
      ...Object.values(snapshot.indexation.byFamily).map((entry) => entry.indexedShare),
      ...Object.values(snapshot.indexation.byKind).map((entry) => entry.indexedShare),
    ];
    for (const value of shares) {
      assert.equal(value.extrapolated, false);
      assert.ok(['inspected', 'inspected-html'].includes(value.basis), value.basis);
    }
  });

  it('samples every family before giving any family a second slot', () => {
    const urls = [
      ...Array.from({ length: 10 }, (_, index) => ({
        url: `https://www.worldmonitor.app/countries/c${index}/`,
        family: 'country_pages',
      })),
      { url: 'https://www.worldmonitor.app/tools/a/', family: 'tools' },
      { url: 'https://www.worldmonitor.app/compare/a/', family: 'compare' },
    ];
    const picked = stratifiedSample(urls, 3);
    assert.deepEqual(
      [...new Set(picked.map((entry) => entry.family))].sort(),
      ['compare', 'country_pages', 'tools'],
    );
    assert.equal(stratifiedSample(urls, 99).length, 12);
  });

  it('feeds the per-family numbers into the existing scorecard contract', async () => {
    const { snapshot } = await collect();
    const normalized = normalizeSearchExport(toScorecardSearchExport(snapshot), {
      querySet,
      observedAt: '2026-09-24T00:00:00Z',
      provider: 'Google Search Console',
      schemaVersion: 2,
    });
    assert.equal(normalized.property, null);
    assert.deepEqual(
      normalized.windows.map((window) => window.label).sort(),
      ['28d', '90d'],
    );
    const homepage = normalized.pageFamilyRows.find(
      (row) => row.windowLabel === '28d' && row.pageFamily === 'homepage',
    );
    assert.equal(homepage.metrics.impressions, 2100);
    assert.equal(homepage.metrics.indexedPages, 1);
  });
});

describe('Search Console collector secrecy', () => {
  const MARKERS = ['private_key', 'client_email', 'sc-domain:', 'inspectionResultLink', 'BEGIN PRIVATE KEY'];

  it('leaves the property identifier out of the picked index status', () => {
    const response = JSON.parse(
      readFileSync(repoPath('tests/fixtures/gsc/url-inspection.json'), 'utf8'),
    )['https://www.worldmonitor.app/'];
    // The recording deliberately carries the link that embeds the property id.
    // If it did not, this test could not fail and would prove nothing.
    assert.match(JSON.stringify(response), /sc-domain:/);
    assert.equal(JSON.stringify(pickIndexStatus(response)).includes('sc-domain:'), false);
    assert.equal(pickIndexStatus(response).coverageState, 'Submitted and indexed');
    assert.equal(pickIndexStatus({}), null);
  });

  it('greps the generated snapshot and summary for credential markers', async () => {
    const { snapshot, markdown } = await collect();
    const serialized = JSON.stringify(snapshot);
    for (const marker of MARKERS) {
      assert.equal(serialized.includes(marker), false, `snapshot leaked ${marker}`);
      assert.equal(markdown.includes(marker), false, `summary leaked ${marker}`);
    }
    assert.equal(snapshot.property, null);
    assert.equal(snapshot.propertyKind, 'domain');
  });

  it('refuses to write output that contains a marker or the property id', () => {
    for (const marker of MARKERS) {
      assert.throws(
        () => assertNoSecrets(`{"note":"${marker}"}`),
        /refusing to write output/,
      );
    }
    assert.throws(
      () => assertNoSecrets('{"note":"https://example.test/prefix"}', { property: 'https://example.test/prefix' }),
      /property identifier/,
    );
    assert.equal(assertNoSecrets('{"ok":true}', { property: 'sc-domain:example.test' }), '{"ok":true}');
  });

  it('keeps every committed research artifact free of credential markers', () => {
    const root = repoPath('docs/research/seo-ai-visibility');
    const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
    const files = walk(root);
    assert.ok(files.length > 0, 'the research directory must not be empty');
    for (const path of files) {
      const contents = readFileSync(path, 'utf8');
      for (const marker of MARKERS) {
        assert.equal(contents.includes(marker), false, `${path} contains ${marker}`);
      }
    }
  });
});

describe('Search Console service-account assertion', () => {
  it('signs a verifiable assertion without reading a credential from disk', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const serviceAccount = {
      client_email: 'collector@example.iam.gserviceaccount.test',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
    const encoded = Buffer.from(JSON.stringify(serviceAccount)).toString('base64');
    const decoded = decodeServiceAccount(encoded);
    assert.equal(decoded.client_email, serviceAccount.client_email);

    const assertion = createServiceAccountAssertion(decoded, { nowSeconds: 1_700_000_000 });
    const [header, claims, signature] = assertion.split('.');
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));
    assert.equal(verified, true);
    const payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
    assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
    assert.equal(payload.scope, 'https://www.googleapis.com/auth/webmasters.readonly');
    assert.equal(payload.exp - payload.iat, 3600);
  });

  it('rejects a key that is not base64-encoded JSON', () => {
    assert.throws(() => decodeServiceAccount('not-a-key'), /not base64-encoded JSON/);
    assert.throws(() => decodeServiceAccount(''), /is empty/);
    assert.throws(
      () => decodeServiceAccount(Buffer.from('{"client_email":"a@b.test"}').toString('base64')),
      /missing private_key/,
    );
  });
});

describe('Search Console collector units', () => {
  it('counts a sitemap index by its children rather than as a page', () => {
    const inventory = buildInventory([
      {
        url: 'https://www.worldmonitor.app/sitemap.xml',
        xml: '<sitemapindex><sitemap><loc>https://www.worldmonitor.app/sitemap-main.xml</loc></sitemap></sitemapindex>',
      },
      {
        url: 'https://www.worldmonitor.app/sitemap-main.xml',
        xml: '<urlset><url><loc>https://www.worldmonitor.app/</loc></url></urlset>',
      },
    ]);
    assert.equal(inventory.urls.length, 1);
    assert.equal(inventory.sitemaps[0].kind, 'index');
    assert.equal(inventory.sitemaps[0].childCount, 1);
    assert.equal(inventory.sitemaps[1].urlCount, 1);
  });

  it('reports no disagreement when there is nothing to disagree about', () => {
    const indexed = { verdict: 'PASS', coverageState: 'Submitted and indexed' };
    assert.equal(
      describeDisagreement(indexed, { status: 200, xRobotsTag: null }),
      null,
    );
    assert.equal(describeDisagreement(null, { status: 200, xRobotsTag: null }), null);
    assert.equal(
      describeDisagreement(indexed, { status: null, xRobotsTag: null }),
      null,
    );
    assert.equal(
      describeDisagreement(indexed, { status: 503, xRobotsTag: null }),
      'google-recorded-indexed-live-errors',
    );
  });

  it('renders a summary that names the sampling basis', async () => {
    const { snapshot } = await collect();
    const markdown = renderGscMarkdown(snapshot);
    assert.match(markdown, /## By page family/);
    assert.match(markdown, /## By response kind/);
    assert.match(markdown, /## By host/);
    assert.match(markdown, /## Sampling/);
    assert.match(markdown, /Property identifier: withheld/);
  });

  it('rejects an empty inventory rather than reporting an empty snapshot', async () => {
    const transport = createFixtureTransport(repoPath(FIXTURES));
    await assert.rejects(
      () => collectGscSnapshot({
        transport,
        documents: [{ url: 'https://www.worldmonitor.app/sitemap-main.xml', xml: '<urlset></urlset>' }],
        observedAt: '2026-09-24T00:00:00Z',
        windows: [],
      }),
      /sitemap inventory is empty/,
    );
  });
});

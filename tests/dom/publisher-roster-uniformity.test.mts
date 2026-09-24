/**
 * #6419 step 3: one claim renders one publisher roster on every surface that
 * lists publishers (NewsPanel cluster rows, Country Deep Dive rows, Insights
 * server stories), and the older per-surface source lists are gone.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { InsightsPanel } from '@/components/InsightsPanel';
import { NewsPanel } from '@/components/NewsPanel';
import { clusterNews } from '@/services/clustering';
import type { ServerInsightStory } from '@/services/insights-loader';
import type { NewsItem } from '@/types';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const UNDECLARED = 'Synthetic Unmapped Outlet 6419';
const TITLE = 'Port strike halts container traffic in Rotterdam';
const LABELS = ['Reuters World', 'Reuters US', 'BBC World', 'Fars News', 'The Verge', UNDECLARED];

function newsItem(source: string, title = TITLE): NewsItem {
  return {
    source,
    title,
    link: `https://example.com/${encodeURIComponent(source + title)}`,
    pubDate: new Date('2026-09-24T00:00:00.000Z'),
    isAlert: false,
  } as NewsItem;
}

type RosterView = {
  summary: string;
  rows: Array<{ name: string; chip: string; chipTitle: string | null; feeds: string | null; risk: string | null }>;
  legend: string;
  href: string | null;
};

function readRoster(root: Element): RosterView | null {
  const roster = root.querySelectorAll('.publisher-roster');
  if (roster.length === 0) return null;
  expect(roster).toHaveLength(1);
  const el = roster[0]!;
  expect(el.tagName).toBe('DETAILS');
  return {
    summary: el.querySelector('summary')?.textContent?.trim() ?? '',
    rows: [...el.querySelectorAll('li')].map((li) => ({
      name: li.querySelector('.publisher-name')?.textContent ?? '',
      chip: li.querySelector('.tier-chip')?.textContent ?? '',
      chipTitle: li.querySelector('.tier-chip')?.getAttribute('title') ?? null,
      feeds: li.getAttribute('title'),
      risk: li.querySelector('.propaganda-badge, .provenance-fact-marker')?.textContent ?? null,
    })),
    legend: el.querySelector('.tier-legend')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    href: el.querySelector('.tier-legend a')?.getAttribute('href') ?? null,
  };
}

function newsPanelRow(labels: string[]): Element {
  vi.useFakeTimers();
  const panel = new NewsPanel('roster-test', 'Roster');
  document.body.appendChild(panel.getElement());
  (panel as unknown as { renderClusters(clusters: unknown[]): void })
    .renderClusters(clusterNews(labels.map((source) => newsItem(source))));
  vi.runAllTimers();
  const rows = panel.getElement().querySelectorAll('.item.clustered');
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function deepDiveRow(labels: string[]): Element {
  const panel = new CountryDeepDivePanel(null);
  const body = document.createElement('div');
  document.body.appendChild(body);
  (panel as unknown as { newsBody: HTMLElement }).newsBody = body;
  panel.updateNews(labels.map((source) => newsItem(source)));
  expect(body.querySelectorAll('.cdp-news-item')).toHaveLength(1);
  return body;
}

function insightsStory(labels: string[], extra: Partial<ServerInsightStory> = {}): Element {
  const renderer = Object.create(InsightsPanel.prototype) as {
    renderServerStories(stories: ServerInsightStory[], sentiments: null): string;
  };
  const host = document.createElement('div');
  host.innerHTML = renderer.renderServerStories([{
    primaryTitle: TITLE,
    primarySource: labels[0]!,
    primaryLink: 'https://example.com/story',
    pubDate: '2026-09-24T00:00:00.000Z',
    sourceCount: labels.length,
    uniqueSourceCount: 5,
    importanceScore: 50,
    velocity: { level: 'normal', sourcesPerHour: 0 },
    isAlert: false,
    category: 'general',
    threatLevel: 'low',
    sources: labels,
    ...extra,
  } as ServerInsightStory], null);
  return host;
}

const EXPECTED: RosterView = {
  summary: 'Reported by 5 publishers, including 1 tier-1',
  rows: [
    { name: 'Reuters', chip: 'T1', chipTitle: 'Tier 1: Wire services and official bodies', feeds: 'Feeds seen: Reuters World (T1), Reuters US (T1)', risk: '?' },
    { name: 'BBC', chip: 'T2', chipTitle: 'Tier 2: Major outlets', feeds: 'Feeds seen: BBC World (T2)', risk: null },
    { name: 'Fars News', chip: 'T3', chipTitle: 'Tier 3: Specialist, regional and think-tank sources', feeds: 'Feeds seen: Fars News (T3)', risk: '?' },
    { name: 'The Verge', chip: 'T4', chipTitle: 'Tier 4: Aggregators and blogs', feeds: 'Feeds seen: The Verge (T4)', risk: '?' },
    { name: UNDECLARED, chip: 'T?', chipTitle: 'Tier not declared: not yet reviewed', feeds: `Feeds seen: ${UNDECLARED} (T?)`, risk: '?' },
  ],
  legend: 'Tiers rank sources; they do not judge this claim. How tiers are assigned',
  href: '/docs/data-sources#source-credibility-%26-feed-tiering',
};

describe('publisher roster renders identically on every surface (#6419 step 3)', () => {
  it('NewsPanel cluster, Country Deep Dive and Insights show the same roster for one claim', () => {
    const surfaces = {
      newsPanel: readRoster(newsPanelRow(LABELS)),
      deepDive: readRoster(deepDiveRow(LABELS)),
      insights: readRoster(insightsStory(LABELS)),
    };
    expect(surfaces).toEqual({ newsPanel: EXPECTED, deepDive: EXPECTED, insights: EXPECTED });
  });

  it('says how many publishers were listed when the digest counted more', () => {
    const roster = readRoster(insightsStory(LABELS, { corroborationCount: 7 }));
    expect(roster?.summary).toBe('Reported by 7 publishers, including 1 tier-1 (5 listed)');
    expect(roster?.rows).toHaveLength(5);
  });

  it('omits the roster where the pill already names the only publisher', () => {
    const oneNewsroom = ['Reuters World', 'Reuters US'];
    expect(readRoster(newsPanelRow(oneNewsroom))).toBeNull();
    document.body.innerHTML = '';
    expect(readRoster(deepDiveRow(oneNewsroom))).toBeNull();
    expect(readRoster(insightsStory(oneNewsroom, { uniqueSourceCount: 1 }))).toBeNull();
  });

  it('replaces the NewsPanel "Also:" chips and the Deep Dive "+N sources" tooltip', () => {
    const row = newsPanelRow(LABELS);
    expect(row.querySelector('.also-reported')).toBeNull();
    expect(row.querySelector('.top-source')).toBeNull();
    expect(row.textContent).not.toContain('Also:');

    const body = deepDiveRow(LABELS);
    const meta = body.querySelector('.cdp-news-meta')!;
    expect(meta.getAttribute('title')).toBeNull();
    expect(meta.textContent).not.toMatch(/\+\d+ sources?/);
    expect(body.querySelector('.cdp-news-item .publisher-roster')).toBeNull();
  });
});

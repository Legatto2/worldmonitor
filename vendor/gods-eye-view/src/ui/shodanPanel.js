import { CustomDataSource, Cartesian3, Color, HeightReference } from 'cesium';
import './shodanPanel.css';
import { createPublicCameraPanel } from './publicCameraPanel.js';

/** Explicit lookups only: camera movement never triggers an API request. */
export function initShodanPanel({ viewer }) {
  const source = new CustomDataSource('Shodan observations');
  viewer.dataSources.add(source);
  const abort = new AbortController();
  const button = document.createElement('button');
  button.id = 'shodan-chip';
  button.textContent = '◎ SHODAN';
  button.setAttribute('aria-controls', 'shodan-panel');
  button.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('section');
  panel.id = 'shodan-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Shodan internet exposure');
  // Static markup only. All provider strings are inserted with textContent.
  panel.innerHTML = `
    <header><h2>SHODAN</h2><button type="button" aria-label="Close Shodan">×</button></header>
    <nav class="shodan-actions" aria-label="Shodan views"><button type="button" data-view="shodan" aria-pressed="true">Shodan results</button><button type="button" data-view="cameras" aria-pressed="false">Public cameras</button></nav>
    <div data-shodan-view>
    <p>Internet exposure observations</p>
    <form>
      <label>Lookup type<select name="mode"><option value="host">IP address</option><option value="search">Search Shodan</option></select></label>
      <label>IP address or search query<input name="query" type="text" placeholder="8.8.8.8" maxlength="300" required autocomplete="off" spellcheck="false"></label>
      <p class="shodan-note">Searches may use Shodan credits. Up to 100 service observations per search; no automatic refresh.</p>
      <button type="submit">Look up</button>
    </form>
    <div class="shodan-actions"><label><input type="checkbox" checked> Show map markers</label><button type="button" data-clear>Clear results</button></div>
    <p class="shodan-note">IP locations are approximate. An exposed service is not evidence of malicious activity. Observations may be outdated.</p>
    <p role="status" aria-live="polite"></p><div class="shodan-results"></div></div>
    <div data-camera-view hidden></div>`;
  document.body.append(button, panel);
  const form = panel.querySelector('form');
  const input = form.elements.query;
  const status = panel.querySelector('[role="status"]');
  const results = panel.querySelector('.shodan-results');
  const submit = form.querySelector('[type="submit"]');
  let disposed = false;
  let requestVersion = 0;
  let entities = new Map();
  let selectedView = 'shodan';
  const cameras = createPublicCameraPanel({
    root: panel.querySelector('[data-camera-view]'),
    viewer,
    onReveal: () => {
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
    },
  });
  const switchView = (view) => {
    selectedView = view;
    panel.querySelector('[data-shodan-view]').hidden = view !== 'shodan';
    panel.querySelector('[data-camera-view]').hidden = view !== 'cameras';
    for (const tab of panel.querySelectorAll('[data-view]'))
      tab.setAttribute('aria-pressed', String(tab.dataset.view === view));
    cameras.setActive(view === 'cameras' && !panel.hidden);
    panel.scrollTop = 0;
  };
  for (const tab of panel.querySelectorAll('[data-view]'))
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  const show = (open) => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    cameras.setActive(open && selectedView === 'cameras');
    if (open)
      panel
        .querySelector(
          selectedView === 'shodan'
            ? 'input[name="query"]'
            : '[data-camera-view] input[type="text"]',
        )
        .focus();
    else button.focus();
  };
  const openTool = (event) => {
    if (!['shodan', 'cameras'].includes(event.detail)) return;
    show(true);
    switchView(event.detail);
  };
  window.addEventListener('gev:open-tool', openTool);
  button.addEventListener('click', () => show(panel.hidden));
  panel
    .querySelector('header button')
    .addEventListener('click', () => show(false));
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      show(false);
    }
  });
  form.elements.mode.addEventListener('change', () => {
    const search = form.elements.mode.value === 'search';
    input.placeholder = search ? 'org:"Google" country:US' : '8.8.8.8';
    submit.textContent = search ? 'Search (may use credits)' : 'Look up';
  });
  panel
    .querySelector('[type="checkbox"]')
    .addEventListener('change', (event) => {
      source.show = event.target.checked;
      viewer.scene.requestRender();
    });
  const clear = () => {
    if (entities.has(viewer.selectedEntity)) viewer.selectedEntity = undefined;
    source.entities.removeAll();
    entities.clear();
    results.replaceChildren();
    viewer.scene.requestRender();
  };
  panel.querySelector('[data-clear]').addEventListener('click', () => {
    requestVersion++;
    clear();
    status.textContent = 'Results cleared.';
    submit.disabled = false;
  });
  function render(payload) {
    clear();
    let mapped = 0;
    for (const [index, host] of payload.hosts.entries()) {
      const card = document.createElement('article');
      const heading = document.createElement('h3');
      heading.textContent = host.ip;
      card.append(heading);
      const record = document.createElement('a');
      record.href = `https://www.shodan.io/host/${encodeURIComponent(host.ip)}`;
      record.textContent = 'View indexed Shodan record';
      record.target = '_blank';
      record.rel = 'noopener noreferrer';
      card.append(record);
      const lines = [
        host.organization || 'Organization unknown',
        [host.city, host.country].filter(Boolean).join(', ') ||
          'Location unknown',
        `Ports: ${host.ports.join(', ') || 'Unknown'}`,
        `Hostnames: ${host.hostnames.join(', ') || 'Unknown'}`,
        `Observed: ${host.observedAt || 'Unknown'}`,
      ];
      for (const line of lines) {
        const p = document.createElement('p');
        p.textContent = line;
        card.append(p);
      }
      for (const service of host.services) {
        const p = document.createElement('p');
        p.textContent = `${service.port ?? '?'} / ${service.transport || '?'} · ${[service.product, service.version].filter(Boolean).join(' ') || 'Service unidentified'}${service.observedAt ? ` · ${service.observedAt}` : ''}`;
        card.append(p);
      }
      if (host.latitude !== null && host.longitude !== null) {
        const entity = source.entities.add({
          id: `shodan-${index}`,
          name: `Shodan: ${host.ip}`,
          position: Cartesian3.fromDegrees(host.longitude, host.latitude),
          point: {
            pixelSize: 10,
            color: Color.fromCssColorString('#f0b65a'),
            outlineColor: Color.BLACK,
            outlineWidth: 2,
            heightReference: HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        entities.set(entity, card);
        mapped++;
        const locate = document.createElement('button');
        locate.type = 'button';
        locate.textContent = 'Locate approximate position';
        locate.addEventListener('click', () => {
          source.show = true;
          panel.querySelector('[type="checkbox"]').checked = true;
          viewer.camera.flyTo({
            destination: Cartesian3.fromDegrees(
              host.longitude,
              host.latitude,
              180000,
            ),
            duration: 1.2,
          });
        });
        card.append(locate);
        const nearby = document.createElement('button');
        nearby.type = 'button';
        nearby.textContent = 'Find public cameras nearby';
        nearby.addEventListener('click', () => {
          switchView('cameras');
          cameras.near({ lat: host.latitude, lon: host.longitude });
        });
        card.append(nearby);
      }
      results.append(card);
    }
    status.textContent = `${payload.hosts.length} observations shown of ${payload.total.toLocaleString()}; ${mapped} mapped. ${payload.cached ? 'Cached' : 'Retrieved'} ${payload.retrievedAt}.`;
    if (!payload.hosts.length)
      status.textContent = 'No matching observations found.';
    viewer.scene.requestRender();
  }
  const removeSelection = viewer.selectedEntityChanged.addEventListener(
    (entity) => {
      const card = entities.get(entity);
      if (!card) return;
      switchView('shodan');
      show(true);
      card.scrollIntoView({ block: 'nearest' });
    },
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const version = ++requestVersion;
    submit.disabled = true;
    status.textContent = 'Querying Shodan…';
    try {
      const response = await fetch(`/api/shodan/${form.elements.mode.value}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: input.value.trim() }),
        signal: abort.signal,
      });
      const payload = await response.json();
      if (disposed || version !== requestVersion) return;
      if (!response.ok)
        throw new Error(payload.error || 'Shodan request failed.');
      render(payload);
    } catch (error) {
      if (!disposed && version === requestVersion)
        status.textContent = error.message;
    } finally {
      if (!disposed && version === requestVersion) submit.disabled = false;
    }
  });
  fetch('/api/shodan/status', { signal: abort.signal })
    .then((r) => r.json())
    .then((data) => {
      if (!disposed && requestVersion === 0)
        status.textContent = data.configured
          ? 'Ready. Enter an IP address or choose Search Shodan.'
          : data.error || 'Add your API key in POWER UP → SHODAN to begin.';
    })
    .catch(() => {
      if (!disposed && requestVersion === 0)
        status.textContent = 'Shodan connection unavailable.';
    });
  return () => {
    disposed = true;
    window.removeEventListener('gev:open-tool', openTool);
    abort.abort();
    removeSelection();
    cameras.destroy();
    clear();
    viewer.dataSources.remove(source, true);
    button.remove();
    panel.remove();
  };
}

import { CustomDataSource, Cartesian3, Color, HeightReference } from 'cesium';
import {
  filterPublicCameras,
  publicCameraSources,
  PUBLIC_CAMERA_ATTRIBUTION,
} from './publicCameraCore.js';

/** Only operator-published catalog IDs are eligible; no guessed camera endpoints. */
export function createPublicCameraPanel({ root, viewer, onReveal }) {
  root.innerHTML = `
    <h3>PUBLIC CAMERAS</h3>
    <p class="shodan-note">Operator-published traffic snapshots. Updated images, not continuous video. No Shodan credits used.</p>
    <label>Search public cameras<input type="text" placeholder="Austin, London, San Diego, or a street"></label>
    <div class="shodan-actions"><button type="button" data-all>All locations</button><button type="button" data-reload>Reload catalog</button></div>
    <p data-near class="shodan-note"></p><p role="status" aria-live="polite" data-catalog-status></p>
    <section data-player hidden aria-label="Public camera snapshot viewer">
      <h4 data-title></h4><p data-provider></p><img alt="" hidden>
      <p data-frame-status role="status" aria-live="polite"></p>
      <div class="shodan-actions"><button type="button" data-refresh>Refresh snapshot</button><button type="button" data-stop>Stop viewing</button></div>
      <label><input type="checkbox" checked> Refresh every 10 seconds</label>
    </section>
    <div data-camera-results></div>`;
  const source = new CustomDataSource('Public camera viewer');
  source.show = false;
  viewer.dataSources.add(source);
  const input = root.querySelector('input[type="text"]');
  const list = root.querySelector('[data-camera-results]');
  const catalogStatus = root.querySelector('[data-catalog-status]');
  const player = root.querySelector('[data-player]');
  const frameStatus = root.querySelector('[data-frame-status]');
  const img = root.querySelector('img');
  const refreshButton = root.querySelector('[data-refresh]');
  const auto = root.querySelector('[type="checkbox"]');
  const nearLabel = root.querySelector('[data-near]');
  const pins = new Map();
  let catalog = [];
  let near = null;
  let active = false;
  let disposed = false;
  let current = null;
  let timer;
  let frameAbort;
  let objectUrl;
  let generation = 0;
  let catalogTask;
  const lifetime = new AbortController();
  function releaseImage() {
    img.hidden = true;
    img.removeAttribute('src');
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  function stop() {
    generation++;
    clearTimeout(timer);
    frameAbort?.abort();
    current = null;
    releaseImage();
    player.hidden = true;
    refreshButton.disabled = false;
  }
  function setActive(value) {
    active = value;
    source.show = catalog.length > 0;
    if (!value) stop();
    viewer.scene.requestRender();
    if (value && !catalog.length) void load();
  }
  async function refresh() {
    clearTimeout(timer);
    if (!current || !active || disposed || document.hidden) return;
    frameAbort?.abort();
    frameAbort = new AbortController();
    const controller = frameAbort;
    const version = ++generation;
    const camera = current;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    refreshButton.disabled = true;
    frameStatus.textContent = 'Loading operator snapshot…';
    try {
      const response = await fetch(
        `/api/cctv/frame/${encodeURIComponent(camera.id)}?liveOnly=1&t=${Date.now()}`,
        { signal: frameAbort.signal, cache: 'no-store' },
      );
      if (
        !response.ok ||
        response.headers.get('X-CCTV-Source') !== 'upstream-image'
      )
        throw new Error(
          'No current operator snapshot available. Try another camera or refresh later.',
        );
      const type = response.headers.get('content-type') || '';
      if (!/^image\/(jpeg|png|webp)(;|$)/i.test(type))
        throw new Error(
          'This feed does not provide a supported camera snapshot.',
        );
      const blob = await response.blob();
      if (blob.size > 12 * 1024 * 1024)
        throw new Error('Camera snapshot exceeds the size limit.');
      if (version !== generation || disposed) return;
      releaseImage();
      objectUrl = URL.createObjectURL(blob);
      img.src = objectUrl;
      img.alt = `${camera.name} — ${camera.provider} public traffic camera`;
      img.hidden = false;
      frameStatus.textContent = `Snapshot retrieved ${new Date().toLocaleTimeString()}. Camera capture time is not supplied; the image may be delayed.`;
    } catch (error) {
      if (version !== generation || disposed) return;
      releaseImage();
      frameStatus.textContent =
        error.name === 'AbortError'
          ? 'Camera request timed out. Try again.'
          : error.message;
    } finally {
      clearTimeout(timeout);
      if (version === generation && !disposed) {
        refreshButton.disabled = false;
        if (auto.checked && active && current && !document.hidden)
          timer = setTimeout(refresh, 10_000);
      }
    }
  }
  function watch(camera, fly = true) {
    stop();
    current = camera;
    player.hidden = false;
    root.querySelector('[data-title]').textContent =
      `${camera.city} · ${camera.name}`;
    const provider = root.querySelector('[data-provider]');
    provider.replaceChildren();
    const attribution = PUBLIC_CAMERA_ATTRIBUTION[camera.sourceKind];
    const link = document.createElement('a');
    link.href = attribution.url;
    link.textContent = attribution.title;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    provider.append(link);
    if (fly)
      viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(camera.lon, camera.lat, 2500),
        duration: 1.2,
      });
    onReveal();
    void refresh();
    player.scrollIntoView({ block: 'nearest' });
  }
  function render() {
    if (pins.has(viewer.selectedEntity)) viewer.selectedEntity = undefined;
    source.entities.removeAll();
    pins.clear();
    list.replaceChildren();
    source.show = catalog.length > 0;
    const matches = filterPublicCameras(catalog, input.value, near);
    nearLabel.textContent = near
      ? 'Within 100 km of the approximate Shodan position. These are separate public cameras, not the Shodan device.'
      : '';
    catalogStatus.textContent = `${matches.length} matching public cameras; ${Math.min(100, matches.length)} shown on the map. Search to narrow the list.`;
    if (!matches.length)
      catalogStatus.textContent =
        'No public cameras match this area or search. Try All locations or a different city.';
    for (const camera of matches.slice(0, 100)) {
      const card = document.createElement('article');
      const title = document.createElement('h4');
      title.textContent = `${camera.city} · ${camera.name}`;
      const detail = document.createElement('p');
      detail.textContent = `${camera.provider}${near ? ` · ${camera.distanceKm.toFixed(1)} km from approximate position` : ''}`;
      const view = document.createElement('button');
      view.type = 'button';
      view.textContent = 'Fly to & view snapshot';
      view.addEventListener('click', () => watch(camera));
      card.append(title, detail, view);
      list.append(card);
      const entity = source.entities.add({
        id: `public-viewer-${camera.id}`,
        name: `${camera.city}: ${camera.name}`,
        position: Cartesian3.fromDegrees(camera.lon, camera.lat),
        point: {
          pixelSize: 9,
          color: Color.CYAN,
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      pins.set(entity, camera);
    }
    viewer.scene.requestRender();
  }
  async function load() {
    if (catalogTask) return catalogTask;
    catalogStatus.textContent = 'Loading operator-published camera catalog…';
    catalogTask = (async () => {
      try {
        const response = await fetch('/api/cctv/sources', {
          signal: lifetime.signal,
        });
        if (!response.ok)
          throw new Error(
            'Public camera catalog unavailable. Use Reload catalog to retry.',
          );
        const payload = await response.json();
        if (disposed) return;
        catalog = publicCameraSources(payload.sources);
        render();
      } catch (error) {
        if (!disposed) catalogStatus.textContent = error.message;
      } finally {
        catalogTask = null;
      }
    })();
    return catalogTask;
  }
  input.addEventListener('input', render);
  root.querySelector('[data-all]').addEventListener('click', () => {
    near = null;
    input.value = '';
    render();
  });
  root
    .querySelector('[data-reload]')
    .addEventListener('click', () => void load());
  root.querySelector('[data-stop]').addEventListener('click', stop);
  refreshButton.addEventListener('click', () => void refresh());
  auto.addEventListener('change', () => {
    clearTimeout(timer);
    if (auto.checked) void refresh();
  });
  const onVisibility = () => {
    if (document.hidden) {
      clearTimeout(timer);
      generation++;
      frameAbort?.abort();
      refreshButton.disabled = false;
    } else if (current && active) void refresh();
  };
  document.addEventListener('visibilitychange', onVisibility);
  const removeSelection = viewer.selectedEntityChanged.addEventListener(
    (entity) => {
      const camera = pins.get(entity);
      if (camera) { onReveal(); setActive(true); watch(camera, false); }
    },
  );
  return {
    setActive,
    near(position) {
      near = position;
      input.value = '';
      setActive(true);
      if (catalog.length) render();
    },
    destroy() {
      disposed = true;
      stop();
      lifetime.abort();
      removeSelection();
      document.removeEventListener('visibilitychange', onVisibility);
      if (pins.has(viewer.selectedEntity)) viewer.selectedEntity = undefined;
      viewer.dataSources.remove(source, true);
      root.replaceChildren();
    },
  };
}

const PUBLIC_SOURCES = new Set([
  'austin-open-data',
  'caltrans-open-data',
  'tfl-open-data',
]);

export function publicCameraSources(sources) {
  return (Array.isArray(sources) ? sources : []).filter(
    (camera) =>
      camera &&
      PUBLIC_SOURCES.has(camera.sourceKind) &&
      typeof camera.id === 'string' &&
      Number.isFinite(camera.lat) &&
      Math.abs(camera.lat) <= 90 &&
      Number.isFinite(camera.lon) &&
      Math.abs(camera.lon) <= 180,
  );
}

export function cameraDistanceKm(a, b) {
  const rad = Math.PI / 180;
  const dlat = (b.lat - a.lat) * rad;
  const dlon = (b.lon - a.lon) * rad;
  const value =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, value)));
}

export function filterPublicCameras(sources, query, near = null) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return publicCameraSources(sources)
    .map((camera) => ({
      ...camera,
      distanceKm: near ? cameraDistanceKm(near, camera) : null,
    }))
    .filter((camera) =>
      terms.every((term) =>
        `${camera.name} ${camera.city} ${camera.provider}`
          .toLowerCase()
          .includes(term),
      ),
    )
    .filter((camera) => !near || camera.distanceKm <= 100)
    .sort((a, b) =>
      near
        ? a.distanceKm - b.distanceKm
        : `${a.city} ${a.name}`.localeCompare(`${b.city} ${b.name}`),
    );
}

export const PUBLIC_CAMERA_ATTRIBUTION = Object.freeze({
  'austin-open-data': {
    title: 'Austin Transportation & Public Works',
    url: 'https://data.austintexas.gov/',
  },
  'caltrans-open-data': {
    title: 'Caltrans',
    url: 'https://quickmap.dot.ca.gov/',
  },
  'tfl-open-data': {
    title: 'Transport for London',
    url: 'https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service',
  },
});

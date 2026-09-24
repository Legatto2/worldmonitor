import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicCameraSources,
  filterPublicCameras,
  cameraDistanceKm,
} from './publicCameraCore.js';
const austin = {
  id: 'austin-test',
  name: 'Congress Avenue',
  city: 'Austin',
  provider: 'Austin Transportation',
  sourceKind: 'austin-open-data',
  lat: 30.2672,
  lon: -97.7431,
};
const london = {
  id: 'tfl-test',
  name: 'Trafalgar Square',
  city: 'London',
  provider: 'Transport for London',
  sourceKind: 'tfl-open-data',
  lat: 51.508,
  lon: -0.128,
};
test('public camera catalog excludes fallback and unverified configured feeds', () => {
  assert.deepEqual(
    publicCameraSources([
      austin,
      london,
      { ...austin, sourceKind: 'configured' },
      { ...austin, sourceKind: 'fallback' },
      { ...austin, lat: null },
      { ...austin, lon: 200 },
    ]),
    [austin, london],
  );
});
test('camera search combines city, provider and street terms without touching Shodan', () => {
  assert.equal(
    filterPublicCameras([austin, london], 'AUSTIN Congress')[0].id,
    austin.id,
  );
  assert.equal(
    filterPublicCameras([austin, london], 'London')[0].id,
    london.id,
  );
  assert.equal(filterPublicCameras([austin, london], 'missing').length, 0);
});
test('nearby cameras use a 100 km radius and never imply a distant camera is the Shodan device', () => {
  assert.equal(cameraDistanceKm(austin, austin), 0);
  assert.ok(cameraDistanceKm(austin, london) > 7000);
  assert.deepEqual(
    filterPublicCameras([austin, london], '', austin).map((c) => c.id),
    [austin.id],
  );
  assert.equal(
    filterPublicCameras([austin, london], '', { lat: 0, lon: 0 }).length,
    0,
  );
});

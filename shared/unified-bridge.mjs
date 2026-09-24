export const BRIDGE_VERSION = 1;
export const DATASET_KINDS = Object.freeze(['earthquakes','news','natural','military','fires','outages','imported']);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = (value,limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value)<=limit;
const string = (value,limit=240) => typeof value === 'string' ? value.slice(0,limit) : '';
export function validCenter(value) {
  return Boolean(value && finite(value.lat,90) && finite(value.lon,180) && (value.zoom === undefined || typeof value.zoom === 'number' && Number.isFinite(value.zoom) && value.zoom >= 0 && value.zoom <= 22));
}
export function localOrigin(value) {
  try { const url = new URL(value); return url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname) && url.origin === value ? value : null; } catch { return null; }
}
export function safeSourceUrl(value) {
  try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) && !url.username && !url.password ? url.href.slice(0,2048) : null; } catch { return null; }
}
export function normalizePoints(kind,rows) {
  if (!DATASET_KINDS.includes(kind) || !Array.isArray(rows)) return [];
  return rows.slice(0,500).flatMap((raw,index) => {
    const row=object(raw); const location=object(row.location);
    const lat=row.lat ?? row.latitude ?? location.latitude;
    const lon=row.lon ?? row.lng ?? row.longitude ?? location.longitude;
    if (!finite(lat,90) || !finite(lon,180)) return [];
    const date=row.occurredAt ?? row.timestamp ?? row.lastSeen ?? row.date ?? row.acq_date;
    const parsed=date == null ? null : new Date(typeof date === 'number' && date < 1e12 ? date*1000 : date);
    return [{ id: `${kind}:${string(row.id,120) || index}`,kind,lat,lon,
      title: string(row.title || row.place || row.callsign || row.name || row.country || `${kind} observation`),
      observedAt: parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null,
      sourceUrl:safeSourceUrl(row.sourceUrl || row.url),
    }];
  });
}
export function validPoint(point) {
  return Boolean(point && validCenter(point) && DATASET_KINDS.includes(point.kind) && typeof point.id === 'string' && point.id.length<=160 && typeof point.title==='string' && point.title.length<=240 && (point.observedAt === null || typeof point.observedAt==='string' && point.observedAt.length<=40) && (point.sourceUrl===null || typeof point.sourceUrl==='string' && point.sourceUrl.length<=2048 && safeSourceUrl(point.sourceUrl)));
}
export function validState(value) {
  return Boolean(value && value.version===BRIDGE_VERSION && value.type==='wm:state' && Array.isArray(value.points) && value.points.length<=3500 && value.points.every(validPoint) && (value.center===null || validCenter(value.center)));
}

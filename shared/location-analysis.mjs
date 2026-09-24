/** Local-only, bounded geospatial import and analysis. No collectors or network IO. */
export const MAX_RECORDS = 500;
const finite=(n,b)=>typeof n==='number' && Number.isFinite(n) && Math.abs(n)<=b;
export function parseCsv(text){
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='"'){if(quoted && text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
  else if(c===',' && !quoted){row.push(cell);cell='';}
  else if((c==='\n'||c==='\r') && !quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell='';}
  else cell+=c;
 }
 if(quoted)throw Error('CSV has an unclosed quoted field.');
 row.push(cell);if(row.some(v=>v.trim()))rows.push(row);
 const header=(rows.shift()||[]).map(v=>v.trim().toLowerCase().replace(/^\uFEFF/,''));
 if(!header.includes('latitude')||!header.includes('longitude'))throw Error('CSV requires latitude and longitude columns.');
 return rows.map(values=>Object.fromEntries(header.map((key,i)=>[key,values[i]??''])));
}
export function importLocations(text,format){
 if(text.length>2_000_000)throw Error('File exceeds the 2 MB limit.');
 let rows;
 if(format==='csv')rows=parseCsv(text).map(r=>({...r,latitude:r.latitude.trim()?Number(r.latitude):NaN,longitude:r.longitude.trim()?Number(r.longitude):NaN}));
 else {const json=JSON.parse(text);if(json.type!=='FeatureCollection'||!Array.isArray(json.features))throw Error('Use a GeoJSON FeatureCollection of Point features.');rows=json.features.map(f=>({...f.properties,latitude:f.geometry?.type==='Point'?f.geometry.coordinates?.[1]:null,longitude:f.geometry?.type==='Point'?f.geometry.coordinates?.[0]:null}));}
 if(rows.length>MAX_RECORDS)throw Error('Import at most 500 records per project.');
 let rejected=0;const points=[];
 rows.forEach((r,i)=>{
  if(!finite(r.latitude,90)||!finite(r.longitude,180)){rejected++;return;}
  const raw=r.timestamp||r.observedAt||'';const date=raw?new Date(raw):null;
  if(date&&!Number.isFinite(date.getTime())){rejected++;return;}
  points.push({id:String(i),lat:r.latitude,lon:r.longitude,title:String(r.title||r.name||'Imported observation').slice(0,240),timestamp:date?.toISOString()||null,sourceUrl:null});
 });
 return {points,rejected};
}
export function distanceKm(a,b){const rad=n=>n*Math.PI/180;const dlat=rad(b.lat-a.lat),dlon=rad(b.lon-a.lon);const h=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2;return 6371*2*Math.asin(Math.sqrt(Math.min(1,h)));}
export function filterLocations(points,{from='',to='',center=null,radiusKm=0}={}){
 const start=from?Date.parse(from):-Infinity,end=to?Date.parse(to):Infinity;
 if(Number.isNaN(start)||Number.isNaN(end)||start>end)throw Error('Enter a valid date range with start before end.');
 if(center&&(!finite(center.lat,90)||!finite(center.lon,180)||!Number.isFinite(radiusKm)||radiusKm<=0||radiusKm>20040))throw Error('Use valid coordinates and a radius of 0–20,040 km.');
 return points.filter(p=>{const time=p.timestamp?Date.parse(p.timestamp):null;return (!from&&!to||time!==null&&time>=start&&time<=end)&&(!center||distanceKm(center,p)<=radiusKm);}).sort((a,b)=>(a.timestamp||'').localeCompare(b.timestamp||''));
}
export function exportLocations(points,format){
 if(format==='geojson')return JSON.stringify({type:'FeatureCollection',features:points.map(p=>({type:'Feature',geometry:{type:'Point',coordinates:[p.lon,p.lat]},properties:{title:p.title,timestamp:p.timestamp}}))},null,2);
 const escape=value=>{let text=String(value??'');if(typeof value==='string'&&/^[=+@\-\t\r]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
 return ['latitude,longitude,title,timestamp',...points.map(p=>[p.lat,p.lon,p.title,p.timestamp].map(escape).join(','))].join('\r\n');
}

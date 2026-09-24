// Local-only replacement for the Railway-seeded USGS layer. No arbitrary upstream URLs.
export function localEarthquakes(fetcher=fetch){
 let cache=null,expires=0,pending=null;
 return async(req,res,next)=>{
  if(req.url?.split('?')[0]!=='/api/seismology/v1/list-earthquakes')return next();
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'){res.statusCode=405;return res.end(JSON.stringify({error:'Method not allowed'}));}
  try{
   if(!cache || Date.now()>expires){
    pending ??= (async()=>{
     const result=await fetcher('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',{signal:AbortSignal.timeout(12000),redirect:'error'});
     if(!result.ok)throw new Error('USGS unavailable');
     const data=await result.json();
     if(!Array.isArray(data.features))throw new Error('Invalid USGS feed');
     const earthquakes=data.features.slice(0,500).flatMap(row=>{
      const p=row.properties,c=row.geometry?.coordinates;
      if(!p || !Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1]))return [];
      return [{id:String(row.id),place:String(p.place || 'Unknown location'),magnitude:p.mag || 0,depthKm:c[2] || 0,location:{latitude:c[1],longitude:c[0]},occurredAt:p.time,sourceUrl:p.url || '',source:'usgs',category:'earthquake'}];
     });
     cache={earthquakes};expires=Date.now()+60000;
    })().finally(()=>{pending=null;});
    await pending;
   }
   res.end(JSON.stringify(cache));
  }catch{res.statusCode=503;res.end(JSON.stringify({error:'Live USGS earthquake feed unavailable'}));}
 };
}

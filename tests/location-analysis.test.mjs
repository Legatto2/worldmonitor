import test from 'node:test';import assert from 'node:assert/strict';
import {importLocations,filterLocations,exportLocations,distanceKm} from '../shared/location-analysis.mjs';
test('CSV supports quoted titles, rejects missing/out-of-range coordinates and preserves zero',()=>{
 const result=importLocations('latitude,longitude,title,timestamp\n0,0,"Port, Alpha",2025-01-01T00:00:00Z\n,2,missing,\n91,2,invalid,','csv');
 assert.equal(result.points.length,1);assert.equal(result.rejected,2);assert.equal(result.points[0].title,'Port, Alpha');
 assert.throws(()=>importLocations('latitude,longitude\n"0,0','csv'),/unclosed/);
});
test('GeoJSON imports only valid points and filters date and radius',()=>{
 const points=importLocations(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[0,0]},properties:{title:'A',timestamp:'2025-01-01T00:00:00Z'}},{type:'Feature',geometry:{type:'Point',coordinates:[1,0]},properties:{title:'B',timestamp:'2025-01-02T00:00:00Z'}}]}),'geojson').points;
 assert.equal(filterLocations(points,{center:{lat:0,lon:0},radiusKm:50}).length,1);
 assert.equal(filterLocations(points,{from:'2025-01-02T00:00:00Z'}).length,1);
 assert.throws(()=>filterLocations(points,{from:'2025-02-01',to:'2025-01-01'}),/date range/);
 assert.ok(distanceKm({lat:0,lon:179},{lat:0,lon:-179})<223);
 assert.equal(JSON.parse(exportLocations(points,'geojson')).features.length,2);
});
test('CSV export neutralizes spreadsheet formulas; imports are bounded',()=>{
 assert.ok(exportLocations([{lat:0,lon:0,title:'=1+1',timestamp:null}],'csv').includes("'=1+1"));
 assert.throws(()=>importLocations('latitude,longitude\n'+'0,0\n'.repeat(501),'csv'),/500/);
});

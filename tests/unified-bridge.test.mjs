import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePoints,validState,localOrigin,validCenter,safeSourceUrl} from '../shared/unified-bridge.mjs';
test('bridge rejects foreign origins and malformed locations',()=>{
 assert.equal(localOrigin('https://example.org'),null);assert.equal(localOrigin('http://localhost:4480/path'),null);assert.equal(localOrigin('http://localhost:4480'),'http://localhost:4480');
 for(const point of [{lat:null,lon:0},{lat:91,lon:0},{lat:0,lon:Infinity},{lat:0,lon:0,zoom:-1}])assert.equal(validCenter(point),false);
 assert.equal(safeSourceUrl('javascript:alert(1)'),null);assert.equal(safeSourceUrl('https://user:pass@example.org'),null);
});
test('normalization preserves observations and caps untrusted datasets',()=>{
 const rows=normalizePoints('earthquakes',[{id:'x',location:{latitude:1,longitude:2},place:'Test',occurredAt:1700000000,sourceUrl:'https://earthquake.usgs.gov/'}]);
 assert.equal(rows[0].observedAt,'2023-11-14T22:13:20.000Z');assert.equal(validState({type:'wm:state',version:1,points:rows,center:null}),true);
 assert.equal(normalizePoints('news',Array(600).fill({lat:0,lon:0})).length,500);
 assert.deepEqual(normalizePoints('news',[{lat:null,lon:null}]),[]);
 assert.equal(validState({type:'wm:state',version:1,points:Array(3501).fill(rows[0]),center:null}),false);
});

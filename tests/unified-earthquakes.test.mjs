import test from 'node:test';
import assert from 'node:assert/strict';
import {localEarthquakes} from '../scripts/unified/local-earthquakes.mjs';
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v},end(body){this.body=JSON.parse(body)}});
test('USGS local feed coalesces requests, maps records and caches',async()=>{
 let calls=0;const middleware=localEarthquakes(async()=>{calls++;return {ok:true,json:async()=>({features:[{id:'a',geometry:{coordinates:[2,1,3]},properties:{place:'Test',mag:4,time:1000,url:'https://earthquake.usgs.gov/'}}]})}});
 const a=response(),b=response();await Promise.all([middleware({method:'GET',url:'/api/seismology/v1/list-earthquakes'},a,()=>assert.fail()),middleware({method:'GET',url:'/api/seismology/v1/list-earthquakes'},b,()=>assert.fail())]);
 assert.equal(calls,1);assert.equal(a.body.earthquakes[0].location.latitude,1);assert.deepEqual(a.body,b.body);
});
test('USGS failures are explicit and non-GET requests never fetch',async()=>{
 const middleware=localEarthquakes(async()=>{throw Error('unavailable')});let res=response();await middleware({method:'GET',url:'/api/seismology/v1/list-earthquakes'},res,()=>{});assert.equal(res.statusCode,503);
 res=response();await middleware({method:'POST',url:'/api/seismology/v1/list-earthquakes'},res,()=>{});assert.equal(res.statusCode,405);
});

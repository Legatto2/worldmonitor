import { CustomDataSource, Cartesian3, Color, Math as CesiumMath } from 'cesium';
import { BRIDGE_VERSION, localOrigin, validCenter, validState, safeSourceUrl } from '../../../../shared/unified-bridge.mjs';

/** Only the explicitly configured dashboard window may control this renderer. */
export function initUnifiedBridge({ viewer, restoration }) {
  const origin = localOrigin(String(import.meta.env.UNIFIED_PARENT_ORIGIN || ''));
  if (!origin || window.parent === window) return () => {};
  document.body.classList.add('unified-embedded');
  const source = new CustomDataSource('World Monitor observations');
  viewer.dataSources.add(source);
  const points = new Map();
  let disposed = false;
  const colors = {earthquakes:'#ffb454',news:'#67e8f9',natural:'#7ce5a5',military:'#f07cdb',fires:'#ff6e57',outages:'#cba6ff'};
  const bar = document.createElement('div');
  bar.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:185;background:#0c202eee;color:#dcecf4;padding:8px 12px;border:1px solid #426070;border-radius:5px;display:flex;gap:10px;align-items:center;font:11px system-ui';
  const count=document.createElement('span');count.textContent='World Monitor · waiting for observations';
  const back=document.createElement('button');back.type='button';back.textContent='Dashboard at this location';
  back.style.cssText='color:#67e8f9;background:#172d3b;border:1px solid #426070;padding:5px;cursor:pointer';
  bar.append(count,back);
  const details=document.createElement('section');details.hidden=true;details.setAttribute('aria-label','World Monitor observation');
  details.style.cssText='position:fixed;bottom:95px;left:12px;z-index:180;width:min(290px,80vw);padding:14px;background:#0c202ef5;color:#dcecf4;border:1px solid #426070;border-radius:5px;font:12px/1.5 system-ui';
  document.body.append(bar,details);
  const post=(message)=>window.parent.postMessage({...message,version:BRIDGE_VERSION},origin);
  const currentCenter=()=>{ const p=viewer.camera.positionCartographic;return {lat:CesiumMath.toDegrees(p.latitude),lon:CesiumMath.toDegrees(p.longitude),zoom:Math.max(0,Math.min(18,Math.log2(40075016/Math.max(1,p.height))))}; };
  back.addEventListener('click',()=>post({type:'gev:focus-dashboard',center:currentCenter()}));
  const focus=center=>viewer.camera.flyTo({destination:Cartesian3.fromDegrees(center.lon,center.lat,Math.max(1000,Math.min(30000000,40075016/2**(center.zoom ?? 4)))),duration:1});
  const message=event=>{
    if(event.origin!==origin || event.source!==window.parent || event.data?.version!==BRIDGE_VERSION || disposed)return;
    const data=event.data;
    if(data.type==='wm:focus' && validCenter(data.center))focus(data.center);
    if(data.type==='wm:tool' && ['shodan','cameras'].includes(data.tool))window.dispatchEvent(new CustomEvent('gev:open-tool',{detail:data.tool}));
    if(validState(data)) {
      if(points.has(viewer.selectedEntity))viewer.selectedEntity=undefined;
      source.entities.removeAll();points.clear();details.hidden=true;
      for(const point of data.points) {
        const entity=source.entities.add({name:`World Monitor · ${point.title}`,position:Cartesian3.fromDegrees(point.lon,point.lat),point:{pixelSize:9,color:Color.fromCssColorString(colors[point.kind]),outlineColor:Color.BLACK,outlineWidth:2,disableDepthTestDistance:Number.POSITIVE_INFINITY}});
        points.set(entity,point);
      }
      count.textContent=`World Monitor · ${points.size} observations`;
      if(data.center)focus(data.center);
      viewer.scene.requestRender();
    }
  };
  window.addEventListener('message',message);
  const removeSelection=viewer.selectedEntityChanged.addEventListener(entity=>{
    const point=points.get(entity);if(!point){details.hidden=true;return;}
    details.replaceChildren();details.hidden=false;
    const title=document.createElement('strong');title.textContent=point.title;
    const meta=document.createElement('p');meta.textContent=`${point.kind} · ${point.observedAt || 'Observation time unavailable'}`;
    const locate=document.createElement('button');locate.textContent='View location in World Monitor';locate.addEventListener('click',()=>post({type:'gev:focus-dashboard',center:{lat:point.lat,lon:point.lon,zoom:7}}));
    details.append(title,meta,locate);
    if(safeSourceUrl(point.sourceUrl)){const link=document.createElement('a');link.href=point.sourceUrl;link.textContent=' Source';link.target='_blank';link.rel='noopener noreferrer';link.style.color='#67e8f9';details.append(link);}
  });
  Promise.resolve(restoration).catch(()=>{}).then(()=>{if(!disposed)post({type:'gev:ready'});});
  return ()=>{disposed=true;window.removeEventListener('message',message);removeSelection();viewer.dataSources.remove(source,true);bar.remove();details.remove();document.body.classList.remove('unified-embedded');};
}

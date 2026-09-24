import { BRIDGE_VERSION, DATASET_KINDS, localOrigin, normalizePoints, validCenter, type DatasetKind, type UnifiedPoint, type UnifiedCenter } from '../../shared/unified-bridge.mjs';
import './unified-globe-workspace.css';

/** Keep both renderers isolated, sharing only bounded, validated observations. */
export class UnifiedGlobeWorkspace {
  private readonly opener = document.createElement('button');
  private readonly shell = document.createElement('section');
  private readonly viewport = document.createElement('div');
  private readonly status = document.createElement('p');
  private readonly list = document.createElement('div');
  private readonly counts = document.createElement('div');
  private readonly datasets = new Map<DatasetKind,UnifiedPoint[]>();
  private readonly enabled = new Set<DatasetKind>(DATASET_KINDS);
  private readonly cleanups: Array<() => void> = [];
  private frame: HTMLIFrameElement|null = null;
  private ready = false;
  private flushTimer: ReturnType<typeof setTimeout>|undefined;
  private readyTimer: ReturnType<typeof setTimeout>|undefined;
  private center: UnifiedCenter|null = null;
  private tool: 'shodan'|'cameras'|null = null;
  private previousOverflow = '';

  static create(getCenter: () => UnifiedCenter|null, onReturn: (center:UnifiedCenter)=>void): UnifiedGlobeWorkspace|null {
    const origin = localOrigin(String(import.meta.env.VITE_UNIFIED_GLOBE_ORIGIN || ''));
    return origin ? new UnifiedGlobeWorkspace(origin,getCenter,onReturn) : null;
  }
  private constructor(private readonly origin:string, private readonly getCenter:()=>UnifiedCenter|null, private readonly onReturn:(center:UnifiedCenter)=>void) {
    this.opener.className='unified-globe-opener'; this.opener.textContent='◉ 3D OPERATIONS'; this.opener.type='button';
    this.opener.setAttribute('aria-controls','unified-globe-workspace');
    this.opener.setAttribute('aria-expanded','false');
    this.shell.id='unified-globe-workspace'; this.shell.hidden=true;
    this.shell.setAttribute('role','dialog'); this.shell.setAttribute('aria-modal','true'); this.shell.setAttribute('aria-label','Unified intelligence workspace');
    const header=document.createElement('header');
    const title=document.createElement('strong'); title.textContent='WORLD MONITOR × GOD’S EYE';
    header.append(title,this.makeButton('Shodan',()=>this.openTool('shodan')),this.makeButton('Public cameras',()=>this.openTool('cameras')),this.makeButton('Reload globe',()=>this.loadFrame()),this.makeButton('Back to dashboard',()=>this.close()));
    const body=document.createElement('div'); body.className='unified-workspace-body';
    const aside=document.createElement('aside');
    const heading=document.createElement('h2'); heading.textContent='World Monitor context';
    const description=document.createElement('p'); description.textContent='Loaded dashboard observations, drawn on the 3D globe. Other layers remain available on the dashboard.';
    this.status.setAttribute('role','status'); this.status.setAttribute('aria-live','polite');
    const filters=document.createElement('div'); filters.className='unified-dataset-filters';
    for (const kind of DATASET_KINDS) {
      const label=document.createElement('label'); const input=document.createElement('input'); input.type='checkbox'; input.checked=true;
      input.addEventListener('change',()=>{ if(input.checked)this.enabled.add(kind);else this.enabled.delete(kind);this.schedule(); });
      label.append(input,document.createTextNode(kind)); filters.append(label);
    }
    this.counts.className='unified-counts'; this.list.className='unified-context-list';
    aside.append(heading,description,this.status,this.counts,filters,this.list);
    this.viewport.className='unified-globe-viewport'; body.append(aside,this.viewport); this.shell.append(header,body);
    document.body.append(this.opener,this.shell);
    this.opener.addEventListener('click',()=>this.open());
    const message=(event:MessageEvent):void=>{
      if(event.origin!==this.origin || event.source!==this.frame?.contentWindow || event.data?.version!==BRIDGE_VERSION)return;
      if(event.data.type==='gev:ready') { this.ready=true;clearTimeout(this.readyTimer);this.status.textContent='Connected to the 3D globe.';this.flush(); if(this.tool)this.openTool(this.tool); }
      if(event.data.type==='gev:focus-dashboard' && validCenter(event.data.center)) { this.onReturn(event.data.center);this.close(); }
      if(event.data.type==='gev:close')this.close();
    };
    window.addEventListener('message',message);this.cleanups.push(()=>window.removeEventListener('message',message));
    const keyboard=(event:KeyboardEvent):void=>{ if(this.shell.hidden)return; if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.close();} };
    window.addEventListener('keydown',keyboard);this.cleanups.push(()=>window.removeEventListener('keydown',keyboard));
  }
  private makeButton(text:string,action:()=>void):HTMLButtonElement {
    const button=document.createElement('button');button.type='button';button.textContent=text;button.addEventListener('click',action);return button;
  }
  public setDataset(kind:DatasetKind,rows:unknown):void { this.datasets.set(kind,normalizePoints(kind,rows));this.schedule(); }
  public focus(center:UnifiedCenter):void { if(!validCenter(center))return;this.center=center;this.post({type:'wm:focus',center}); }
  private post(message:Record<string,unknown>):void { if(this.ready)this.frame?.contentWindow?.postMessage({...message,version:BRIDGE_VERSION},this.origin); }
  private schedule():void { clearTimeout(this.flushTimer);this.flushTimer=setTimeout(()=>this.flush(),120); }
  private flush():void {
    const points=[...this.datasets].filter(([kind])=>this.enabled.has(kind)).flatMap(([,rows])=>rows);
    this.counts.textContent=`${points.length} observations · ${this.datasets.size}/${DATASET_KINDS.length} datasets loaded`;
    this.list.replaceChildren();
    if(!points.length) {const empty=document.createElement('p');empty.textContent='No dashboard observations loaded yet. God’s Eye’s own data layers and Shodan remain available.';this.list.append(empty);}
    for(const point of points.slice(0,60)) {
      const card=this.makeButton(`${point.kind.toUpperCase()} · ${point.title}`,()=>this.focus({lat:point.lat,lon:point.lon,zoom:7}));
      card.title=point.observedAt || 'Observation time unavailable';this.list.append(card);
    }
    if(points.length>60){const note=document.createElement('p');note.textContent='Showing the first 60 records here; all selected observations are sent to the globe.';this.list.append(note);}
    if(this.ready){this.post({type:'wm:state',points,center:this.center});this.center=null;}
  }
  private loadFrame():void {
    this.ready=false;clearTimeout(this.readyTimer);this.frame?.remove();
    this.frame=document.createElement('iframe');this.frame.title='God’s Eye 3D intelligence globe';
    this.frame.referrerPolicy='no-referrer';
    this.frame.allow='fullscreen';
    this.frame.src=`${this.origin}/?unified=1#v=2&lat=20&lon=0&alt=18000000&pitch=-90&map=esri-imagery&l=`;
    this.viewport.replaceChildren(this.frame);this.status.textContent='Starting the 3D globe…';
    this.readyTimer=setTimeout(()=>{if(!this.ready)this.status.textContent='The globe has not connected. Check the local launcher, then choose Reload globe.';},45000);
  }
  private open():void {
    if(!this.shell.hidden)return;this.center=this.getCenter();this.shell.hidden=false;
    this.previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    this.opener.setAttribute('aria-expanded','true');this.loadFrame();this.shell.querySelector('button')?.focus();this.flush();
  }
  private openTool(tool:'shodan'|'cameras'):void {this.tool=tool;this.post({type:'wm:tool',tool});if(this.ready)this.tool=null;}
  private close():void {
    if(this.shell.hidden)return;this.shell.hidden=true;this.ready=false;
    this.frame?.remove();this.frame=null;clearTimeout(this.readyTimer);
    document.body.style.overflow=this.previousOverflow;this.opener.setAttribute('aria-expanded','false');this.opener.focus();
  }
  public destroy():void {this.close();clearTimeout(this.flushTimer);for(const cleanup of this.cleanups)cleanup();this.opener.remove();this.shell.remove();this.datasets.clear();}
}

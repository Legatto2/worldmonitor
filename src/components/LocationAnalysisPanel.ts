import { importLocations,filterLocations,exportLocations,type LocationRecord } from '../../shared/location-analysis.mjs';

/** Imported records stay in memory and are shared only with the local globe. */
export class LocationAnalysisPanel {
  readonly element=document.createElement('details');
  private points:LocationRecord[]=[];
  private filtered:LocationRecord[]=[];
  private generation=0;
  private disposed=false;
  constructor(private readonly onChange:(points:LocationRecord[])=>void,private readonly getCenter:()=>{lat:number;lon:number}|null){
    this.element.className='location-analysis';
    const summary=document.createElement('summary');summary.textContent='Location analysis';
    const note=document.createElement('p');note.textContent='Import your own or authorized event data. GeoJSON Point features or CSV: latitude, longitude, title, timestamp. Up to 500 records / 2 MB. Files stay on this computer; clear or reload to remove them.';
    const file=document.createElement('input');file.type='file';file.accept='.geojson,.json,.csv';file.setAttribute('aria-label','Import location file');
    const status=document.createElement('p');status.setAttribute('role','status');status.textContent='No location file loaded.';
    const fields=document.createElement('div');
    const input=(label:string,type:string)=>{const wrap=document.createElement('label');wrap.textContent=label;const el=document.createElement('input');el.type=type;wrap.append(el);fields.append(wrap);return el;};
    const from=input('Start date/time','datetime-local'),to=input('End date/time','datetime-local');
    const lat=input('Center latitude','number'),lon=input('Center longitude','number'),radius=input('Radius km (blank disables)','number');
    lat.step=lon.step='any';radius.min='0';radius.max='20040';
    const button=(label:string,fn:()=>void)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',fn);return b;};
    const apply=()=>{try{
      if(radius.value&&(!lat.value.trim()||!lon.value.trim()))throw Error('Enter both center coordinates.');
      this.filtered=filterLocations(this.points,{from:from.value,to:to.value,center:radius.value?{lat:Number(lat.value),lon:Number(lon.value)}:null,radiusKm:Number(radius.value)});
      this.onChange(this.filtered);status.textContent=`${this.filtered.length} of ${this.points.length} imported locations shown. Dates sort oldest first; undated records are excluded when a date filter is active.`;
    }catch(error){status.textContent=error instanceof Error?error.message:'Invalid filter';}};
    const actions=document.createElement('div');actions.className='location-analysis-actions';
    actions.append(button('Use dashboard center',()=>{const center=this.getCenter();if(center){lat.value=String(center.lat);lon.value=String(center.lon);}}),button('Apply filters',apply),button('Reset filters',()=>{from.value=to.value=lat.value=lon.value=radius.value='';apply();}),button('Clear imported data',()=>{this.generation++;this.points=[];this.filtered=[];file.value='';this.onChange([]);status.textContent='Imported data cleared.';}));
    for(const format of ['geojson','csv'])actions.append(button('Export '+format.toUpperCase(),()=>{
      if(!this.filtered.length){status.textContent='No filtered records to export.';return;}
      const url=URL.createObjectURL(new Blob([exportLocations(this.filtered,format)],{type:format==='csv'?'text/csv':'application/geo+json'}));const link=document.createElement('a');link.href=url;link.download='location-analysis.'+format;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }));
    file.addEventListener('change',async()=>{const version=++this.generation;const selected=file.files?.[0];if(!selected)return;
      try{if(selected.size>2_000_000)throw Error('File exceeds the 2 MB limit.');const result=importLocations(await selected.text(),selected.name.toLowerCase().endsWith('.csv')?'csv':'geojson');if(this.disposed||version!==this.generation)return;this.points=result.points;apply();status.textContent+=` ${result.rejected} invalid records skipped.`;}
      catch(error){if(!this.disposed&&version===this.generation)status.textContent=error instanceof Error?error.message:'Import failed';}
    });
    this.element.append(summary,note,file,fields,actions,status);
  }
  reveal():void{this.element.open=true;this.element.scrollIntoView({block:'nearest'});}
  destroy():void{this.disposed=true;this.generation++;this.points=[];this.filtered=[];this.element.remove();}
}

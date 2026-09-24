export interface LocationRecord {id:string;lat:number;lon:number;title:string;timestamp:string|null;sourceUrl:null}
export const MAX_RECORDS:number;
export function parseCsv(text:string):Record<string,string>[];
export function importLocations(text:string,format:string):{points:LocationRecord[];rejected:number};
export function distanceKm(a:{lat:number;lon:number},b:{lat:number;lon:number}):number;
export function filterLocations(points:LocationRecord[],options?:{from?:string;to?:string;center?:{lat:number;lon:number}|null;radiusKm?:number}):LocationRecord[];
export function exportLocations(points:LocationRecord[],format:string):string;

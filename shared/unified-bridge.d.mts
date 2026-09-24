export interface UnifiedCenter { lat:number; lon:number; zoom?:number }
export type DatasetKind = 'earthquakes'|'news'|'natural'|'military'|'fires'|'outages';
export interface UnifiedPoint extends UnifiedCenter { id:string; kind:DatasetKind; title:string; observedAt:string|null; sourceUrl:string|null }
export const BRIDGE_VERSION: 1;
export const DATASET_KINDS: readonly DatasetKind[];
export function validCenter(value: unknown): value is UnifiedCenter;
export function localOrigin(value: string): string|null;
export function safeSourceUrl(value: unknown): string|null;
export function normalizePoints(kind: DatasetKind, rows: unknown): UnifiedPoint[];
export function validPoint(value: unknown): value is UnifiedPoint;
export function validState(value: unknown): value is {type:'wm:state';version:1;points:UnifiedPoint[];center:UnifiedCenter|null};

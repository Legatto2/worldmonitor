import {defineConfig,mergeConfig} from 'vite';
import base from './vite.config';
import {localEarthquakes} from './scripts/unified/local-earthquakes.mjs';
export default defineConfig(async env=>mergeConfig(typeof base==='function' ? await base(env) : await base,{
 plugins:[{name:'unified-local-earthquakes',enforce:'pre',configureServer(server){server.middlewares.use(localEarthquakes());}}],
}));

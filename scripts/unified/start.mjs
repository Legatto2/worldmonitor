import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadEnvFile } from '../_seed-utils.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const envIndex=process.argv.indexOf('--env-file');
if(envIndex>=0){
  const path=process.argv[envIndex+1];
  if(!path || !existsSync(path))throw new Error('The supplied environment file does not exist.');
  process.env.WM_SEED_ENV_FILE=path;
  loadEnvFile(import.meta.url,{only:['SHODAN_API_KEY','GOOGLE_MAPS_API_KEY','CESIUM_ION_TOKEN']});
}
const parent='http://localhost:4480', globe='http://localhost:4481';
const children=[];
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const child of children)child.kill();}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
function start(cwd,args,env){
  const child=spawn(process.execPath,args,{cwd,env:{...process.env,...env},stdio:'inherit',windowsHide:true});
  children.push(child);
  child.on('error',()=>{console.error('Unable to start a workspace server.');stop();process.exitCode=1;});
  child.on('exit',code=>{if(!stopping){process.exitCode=code || 1;stop();}});
}
start(root,['node_modules/vite/bin/vite.js','--config','vite.unified.config.ts','--host','127.0.0.1','--port','4480','--strictPort'],{VITE_UNIFIED_GLOBE_ORIGIN:globe,VITE_E2E:'1'});
start(root+'vendor/gods-eye-view',['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4481','--strictPort'],{GEV_PARENT_ORIGIN:parent,HOST:'localhost',PORT:'4481'});
console.log(`Unified workspace: ${parent} (3D operations: ${globe})`);

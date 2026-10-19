import fs from 'node:fs';
import { chromium } from 'playwright';
const base=process.env.HLS_BENCHMARK_ORIGIN||'http://127.0.0.1:2284';
const assetId=process.env.HLS_BENCHMARK_ASSET_ID;
if (!assetId) throw new Error('Set HLS_BENCHMARK_ASSET_ID to an asset in the isolated test library');
const apiKey=fs.readFileSync(process.env.HLS_BENCHMARK_API_KEY_FILE||'/tmp/hls-benchmark-api-key','utf8').trim();
const count=Number(process.env.HLS_BENCHMARK_RUNS||23);
const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage();
await page.goto(`${base}/api/server/ping`);
await page.setContent('<button id="play">Play</button><video id="v" muted playsinline></video>');
await page.addScriptTag({path:process.env.HLS_BENCHMARK_HLSJS_PATH||'/workspace/web/node_modules/hls.js/dist/hls.min.js'});
const results=[];
for(let n=0;n<count;n++){
 await page.evaluate(({base,assetId,apiKey})=>{
  const video=document.querySelector('#v');performance.clearResourceTimings();
  window.__bench={clickAt:null,firstFrameAt:null,mediaTime:null,events:[],errors:[],hls:null,video,sessionId:null,selected:null};
  const b=window.__bench;
  video.removeAttribute('src'); video.load();
  const ev=name=>b.events.push({name,at:performance.now(),time:video.currentTime});
  for(const name of ['playing','waiting','seeking','seeked','ended','stalled','error'])video.addEventListener(name,()=>ev(name));
  video.requestVideoFrameCallback(function cb(now,meta){if(b.firstFrameAt===null){b.firstFrameAt=now;b.mediaTime=meta.mediaTime;}if(!b.stopFrames)video.requestVideoFrameCallback(cb);});
  document.querySelector('#play').onclick=()=>{
   b.clickAt=performance.now();ev('click');
   const h=new Hls({xhrSetup(xhr){xhr.setRequestHeader('x-api-key',apiKey)}});b.hls=h;
   h.on(Hls.Events.ERROR,(_e,d)=>b.errors.push({details:d.details,fatal:d.fatal}));
   h.on(Hls.Events.MANIFEST_PARSED,(_e,d)=>{const i=d.levels.findIndex(l=>l.height===1080&&String(l.videoCodec).includes('avc'));b.selected=d.levels[i];b.sessionId=d.levels[i].url[0].split('/').at(-3);h.loadLevel=i;h.nextLevel=i;video.play().catch(e=>b.errors.push({play:e.message}));});
   h.loadSource(`${base}/api/assets/${assetId}/video/stream/main.m3u8`);h.attachMedia(video);
  };
 },{base,assetId,apiKey});
 await page.evaluate(()=>document.querySelector('#play').click());
 let failure=null;
 try{await page.waitForFunction(()=>window.__bench.firstFrameAt!==null||window.__bench.errors.some(e=>e.fatal),null,{timeout:20000});}catch(e){failure=e.message;}
 const result=await page.evaluate(()=>{const b=window.__bench;const resources=performance.getEntriesByType('resource').filter(x=>x.name.includes('/video/stream/')).map(x=>({path:x.name.split('/').slice(-2).join('/'),start:x.startTime,duration:x.duration,transferSize:x.transferSize,encodedBodySize:x.encodedBodySize}));return{clickAt:b.clickAt,firstFrameAt:b.firstFrameAt,mediaTime:b.mediaTime,ttffMs:b.firstFrameAt===null?null:b.firstFrameAt-b.clickAt,selected:b.selected&&{height:b.selected.height,videoCodec:b.selected.videoCodec,bitrate:b.selected.bitrate},events:b.events,errors:b.errors,resources};});
 result.run=n+1;result.phase=n<3?'warmup':'valid';if(failure)result.failure=failure;results.push(result);console.log(JSON.stringify(result));
 await page.evaluate(async({base,assetId,apiKey})=>{const b=window.__bench;b.stopFrames=true;b.hls?.destroy();if(b.sessionId){const response=await fetch(`${base}/api/assets/${assetId}/video/stream/${b.sessionId}`,{method:'DELETE',headers:{'x-api-key':apiKey}});b.deleteStatus=response.status;}document.querySelector('#v').pause();document.querySelector('#v').removeAttribute('src');document.querySelector('#v').load();},{base,assetId,apiKey});
 await page.waitForTimeout(150);
}
const vals=results.slice(3).map(x=>x.ttffMs).filter(x=>x!==null).sort((a,b)=>a-b);const pct=p=>vals.length?vals[Math.ceil(p*vals.length)-1]:null;
console.log('SUMMARY',JSON.stringify({runs:results.length,warmups:3,valid:vals.length,p50:pct(.5),p90:pct(.9),p95:pct(.95),max:vals.at(-1),errors:results.filter(x=>x.errors?.some(e=>e.fatal)||x.failure).length}));
await browser.close();

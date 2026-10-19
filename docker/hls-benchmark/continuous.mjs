import fs from 'node:fs';
import { chromium } from 'playwright';
const base = process.env.HLS_BENCHMARK_ORIGIN || 'http://172.17.0.1:2284';
const assetId = process.env.HLS_BENCHMARK_ASSET_ID;
if (!assetId) throw new Error('Set HLS_BENCHMARK_ASSET_ID to an asset in the isolated test library');
const apiKey = fs.readFileSync(process.env.HLS_BENCHMARK_API_KEY_FILE || '/tmp/hls-benchmark-api-key', 'utf8').trim();
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const requests = [];
page.on('response', async response => {
  if (response.url().includes('/video/stream/')) {
    requests.push({url: response.url().split('/').slice(-2).join('/'), status: response.status(), at: Date.now()});
  }
});
page.on('pageerror', e => console.error('PAGEERROR', e.message));
await page.goto(`${base}/api/server/ping`);
await page.setContent('<button id="play">Play</button><video id="v" muted playsinline controls style="width:800px;height:450px"></video><pre id="out"></pre>');
await page.addScriptTag({ path: process.env.HLS_BENCHMARK_HLSJS_PATH || '/workspace/web/node_modules/hls.js/dist/hls.min.js' });
await page.evaluate(({base,assetId,apiKey}) => {
  const video=document.querySelector('#v');
  const b=window.__bench={clickAt:null,firstFrameAt:null,firstMediaTime:null,events:[],errors:[],levels:[],hls:null,video};
  const event=(name, extra={})=>b.events.push({name,at:performance.now(),time:video.currentTime,...extra});
  for (const name of ['playing','waiting','seeking','seeked','ended','stalled','error']) video.addEventListener(name,()=>event(name));
  video.requestVideoFrameCallback(function cb(now,meta){ if(b.firstFrameAt===null){b.firstFrameAt=now;b.firstMediaTime=meta.mediaTime;event('firstFrame',{mediaTime:meta.mediaTime});} if(!b.stopFrames) video.requestVideoFrameCallback(cb); });
  document.querySelector('#play').addEventListener('click',()=>{
    b.clickAt=performance.now(); event('click');
    const h=new Hls({xhrSetup(xhr){xhr.setRequestHeader('x-api-key',apiKey)},debug:false}); b.hls=h;
    h.on(Hls.Events.ERROR,(_e,data)=>b.errors.push({type:data.type,details:data.details,fatal:data.fatal}));
    h.on(Hls.Events.MANIFEST_PARSED,(_e,data)=>{b.levels=data.levels.map((l,i)=>({i,height:l.height,bitrate:l.bitrate,videoCodec:l.videoCodec})); const idx=data.levels.findIndex(l=>l.height===1080&&String(l.videoCodec).includes('avc')); b.sessionId=idx>=0?data.levels[idx].url[0].split('/').at(-3):null; if(idx>=0){h.loadLevel=idx;h.nextLevel=idx;} video.play().catch(e=>b.errors.push({play:e.message})); event('manifest',{levels:b.levels,selected:idx});});
    h.loadSource(`${base}/api/assets/${assetId}/video/stream/main.m3u8`); h.attachMedia(video);
  });
}, {base,assetId,apiKey});
await page.click('#play');
await page.waitForFunction(()=>window.__bench.firstFrameAt!==null || window.__bench.errors.some(x=>x.fatal),null,{timeout:30000});
const first=await page.evaluate(()=>({clickAt:window.__bench.clickAt,firstFrameAt:window.__bench.firstFrameAt,firstMediaTime:window.__bench.firstMediaTime,ttffMs:window.__bench.firstFrameAt-window.__bench.clickAt,events:window.__bench.events,errors:window.__bench.errors,levels:window.__bench.levels}));
console.log('FIRST_FRAME',JSON.stringify(first));
await page.waitForFunction(()=>window.__bench.video.currentTime>=60 || window.__bench.errors.some(x=>x.fatal),null,{timeout:85000}).catch(()=>{});
const continuous=await page.evaluate(()=>({currentTime:window.__bench.video.currentTime,duration:window.__bench.video.duration,paused:window.__bench.video.paused,ended:window.__bench.video.ended,buffered:Array.from({length:window.__bench.video.buffered.length},(_,i)=>[window.__bench.video.buffered.start(i),window.__bench.video.buffered.end(i)]),events:window.__bench.events,errors:window.__bench.errors,levels:window.__bench.levels}));
console.log('CONTINUOUS',JSON.stringify(continuous));
await page.evaluate(async({base,assetId,apiKey})=>{window.__bench.stopFrames=true;window.__bench.hls?.destroy();if(window.__bench.sessionId){const r=await fetch(`${base}/api/assets/${assetId}/video/stream/${window.__bench.sessionId}`,{method:'DELETE',headers:{'x-api-key':apiKey}});window.__bench.deleteStatus=r.status;}},{base,assetId,apiKey});
await browser.close();

// Reports what the attached phone's Chrome actually grants, instead of trusting compatibility tables.
import { adb, connectPhoneChrome, reversePort } from './lib-device.mjs';
import http from 'node:http';

const PORT = 8123;
const server = http.createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>probe</title><canvas id=c></canvas>'); }).listen(PORT);
reversePort(PORT);
const { browser, context } = await connectPhoneChrome();
const page = await context.newPage();
await page.goto(`http://localhost:${PORT}/`);
const cdp = await context.newCDPSession(page);

const evalGesture = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) return { threw: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
};

console.log('env', await evalGesture(`({ua:navigator.userAgent,dm:navigator.deviceMemory,hc:navigator.hardwareConcurrency,dpr:devicePixelRatio,xr:!!navigator.xr,secure:isSecureContext,rvfc:'requestVideoFrameCallback' in HTMLVideoElement.prototype})`));
console.log('immersive-ar', await evalGesture(`navigator.xr.isSessionSupported('immersive-ar')`));
for (const f of ['hit-test', 'anchors', 'dom-overlay', 'light-estimation', 'depth-sensing', 'camera-access', 'image-tracking', 'plane-detection']) {
  const opts = f === 'dom-overlay' ? `{optionalFeatures:['dom-overlay'],domOverlay:{root:document.body}}`
    : f === 'depth-sensing' ? `{optionalFeatures:['depth-sensing'],depthSensing:{usagePreference:['cpu-optimized','gpu-optimized'],dataFormatPreference:['luminance-alpha']}}`
    : f === 'image-tracking' ? `{optionalFeatures:['image-tracking'],trackedImages:[{image:await createImageBitmap(document.getElementById('c')),widthInMeters:0.5}]}`
    : `{optionalFeatures:['${f}']}`;
  const out = await evalGesture(`(async()=>{try{const s=await navigator.xr.requestSession('immersive-ar',${opts});const e=[...(s.enabledFeatures||[])];await s.end();return {granted:e.includes('${f}'),enabled:e};}catch(err){return {error:String(err)}}})()`);
  console.log(f, JSON.stringify(out));
  await new Promise((r) => setTimeout(r, 800));
}
await page.close();
await browser.close();
server.close();
adb('reverse', '--remove', `tcp:${PORT}`);

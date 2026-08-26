// The rendered volume reaches far above the simulated dust. Which term does it?
import { chromium } from '@playwright/test';
const base = 'http://localhost:4173';
const OUT = '/tmp/claude-0/-home-user-volumetric-world/4dd64bb2-e10e-58d9-a2a1-5e76406c3d00/scratchpad';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(`${base}/?scene=puff&preset=test&test=1&norender=1&metrics=1`);
await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 180000 });
await page.evaluate(() => window.__vw.step(1 / 30, 90));
await page.evaluate(() => window.__vw.setView({ yawDeg: 25, pitchDeg: 14, dist: 15 }));

const extent = async (label) => {
  await page.evaluate(() => window.__vw.render());
  const r = await page.evaluate(() => {
    const cv = document.getElementById('shot'), ctx = cv.getContext('2d');
    const { width: w, height: h } = cv, d = ctx.getImageData(0, 0, w, h).data;
    let top = -1, bot = -1, px = 0;
    for (let y = 0; y < h; y++) { let any = false;
      for (let x = 0; x < w; x++) if (d[(y * w + x) * 4] >= 40) { any = true; px++; }
      if (any) { if (top < 0) top = y; bot = y; } }
    const n = (p) => +(1 - (p / h) * 2).toFixed(3);
    return top < 0 ? null : { ndc: [n(bot), n(top)], px };
  });
  console.log(`${label.padEnd(34)} ${JSON.stringify(r)}`);
};

console.log('packets in flight:', await page.evaluate(() => window.__vw.world.packets.packets.length));
await page.evaluate(() => window.__vw.setDebugMode(5));
await extent('baseline (islands + packets)');
await page.evaluate(() => { window.__vw.world.pass.packetCount.value = 0; });
await extent('packets disabled');
await page.evaluate(() => { window.__vw.world.pass.detailStrength.value = 0; });
await extent('packets off + detail off');
await page.evaluate(() => window.__vw.setDebugMode(7));
await page.evaluate(() => window.__vw.render());
await page.screenshot({ path: `${OUT}/smear-mode7.png` });
await page.evaluate(() => window.__vw.setDebugMode(0));
await page.evaluate(() => { window.__vw.world.pass.detailStrength.value = 0.75; });
await page.evaluate(() => window.__vw.render());
await page.screenshot({ path: `${OUT}/smear-mode0.png` });
console.log('saved smear-mode7.png (r=maxLoad g=samplesInside) and smear-mode0.png');
await browser.close();

// Is islandMeta (a TSL uniformArray) actually re-uploaded each frame?
// Move/resize the island box from JS and see whether the render follows.
import { chromium } from '@playwright/test';
const base = 'http://localhost:4173';
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

const shot = async (label) => {
  await page.evaluate(() => window.__vw.render());
  const s = await page.evaluate(() => {
    const cv = document.getElementById('shot'), ctx = cv.getContext('2d');
    const { width: w, height: h } = cv, d = ctx.getImageData(0, 0, w, h).data;
    let px = 0, top = -1, bot = -1;
    for (let y = 0; y < h; y++) { let any = false;
      for (let x = 0; x < w; x++) if (d[(y * w + x) * 4] >= 40) { any = true; px++; }
      if (any) { if (top < 0) top = y; bot = y; } }
    const n = (p) => +(1 - (p / h) * 2).toFixed(3);
    return { px, ndc: top < 0 ? null : [n(bot), n(top)] };
  });
  console.log(`${label.padEnd(40)} px=${String(s.px).padStart(6)}  ndcY=${JSON.stringify(s.ndc)}`);
  return s;
};
await page.evaluate(() => window.__vw.setDebugMode(5));
await shot('unmodified');
console.log('JS island:', await page.evaluate(() => {
  const i = window.__vw.world.scheduler.islands[0];
  return { origin: i.origin.map((v) => +v.toFixed(2)), sizeM: i.sizeM };
}));

await page.evaluate(() => { window.__vw.world.scheduler.islands[0].origin[0] += 40; });
await shot('after moving island origin.x += 40');
await page.evaluate(() => { window.__vw.world.scheduler.islands[0].origin[0] -= 40; });
await shot('restored');
await page.evaluate(() => { window.__vw.world.scheduler.islands[0].sizeM = 4; });
await shot('after sizeM 16 -> 4');
await browser.close();

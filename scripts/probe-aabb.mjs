// Hard invariant: dust can only exist inside its island's world AABB, so the
// rendered volume must land inside that AABB projected to screen. Independent
// of symmetry, lighting and COM estimation.
import { chromium } from '@playwright/test';
const base = 'http://localhost:4173';
const OUT = '/tmp/claude-0/-home-user-volumetric-world/4dd64bb2-e10e-58d9-a2a1-5e76406c3d00/scratchpad';
const scene = process.env.SCENE ?? 'vortex';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(`${base}/?scene=${scene}&preset=test&test=1&norender=1`);
await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 180000 });
await page.evaluate(() => window.__vw.step(1 / 30, 50));
await page.evaluate(() => window.__vw.setDebugMode(5));

for (const yaw of [0, 90, 180, 270]) {
  await page.evaluate((y) => window.__vw.setView({ yawDeg: y, pitchDeg: 16 }), yaw);
  await page.evaluate(() => window.__vw.render());
  const r = await page.evaluate(() => {
    const api = window.__vw;
    const isl = api.world.scheduler.islands.find((i) => i.active);
    const V = api.camera.position.constructor;
    let x0 = 9, x1 = -9, y0 = 9, y1 = -9;
    for (let c = 0; c < 8; c++) {
      const p = new V(
        isl.origin[0] + (c & 1 ? isl.sizeM : 0),
        isl.origin[1] + (c & 2 ? isl.sizeM : 0),
        isl.origin[2] + (c & 4 ? isl.sizeM : 0),
      ).project(api.camera);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    const cv = document.getElementById('shot');
    const ctx = cv.getContext('2d');
    const { width: w, height: h } = cv;
    const d = ctx.getImageData(0, 0, w, h).data;
    let bx0 = 9, bx1 = -9, by0 = 9, by1 = -9, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4] < 40) continue;
      const nx = (x / w) * 2 - 1, ny = 1 - (y / h) * 2;
      bx0 = Math.min(bx0, nx); bx1 = Math.max(bx1, nx);
      by0 = Math.min(by0, ny); by1 = Math.max(by1, ny); n++;
    }
    const f = (v) => +v.toFixed(2);
    return { aabb: [f(x0), f(y0), f(x1), f(y1)], drawn: n ? [f(bx0), f(by0), f(bx1), f(by1)] : null, px: n,
             islandOrigin: isl.origin.map(f), size: isl.sizeM };
  });
  const inside = r.drawn && r.drawn[0] >= r.aabb[0] - 0.06 && r.drawn[1] >= r.aabb[1] - 0.06 &&
                 r.drawn[2] <= r.aabb[2] + 0.06 && r.drawn[3] <= r.aabb[3] + 0.06;
  console.log(`yaw ${String(yaw).padStart(3)}  islandAABB->NDC ${JSON.stringify(r.aabb)}  volumeDrawn ${JSON.stringify(r.drawn)}  px=${r.px}  INSIDE=${inside}`);
  await page.screenshot({ path: `${OUT}/aabb-${scene}-${yaw}.png` });
}
await browser.close();

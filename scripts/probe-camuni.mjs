// Which stage ignores the camera? Compare debug views across two opposite yaws.
//  mode 1 = opaqueDist (depth texture + camPos)   mode 4 = march interval (camPos/rayDir vs island AABB)
//  mode 5 = accumulated density (full march)      mode 0 = final composite
import { chromium } from '@playwright/test';
const base = 'http://localhost:4173';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-angle=vulkan', '--disable-vulkan-surface', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(`${base}/?scene=puff&preset=test&test=1&norender=1`);
await page.waitForFunction(() => window.__vwReady === true, undefined, { timeout: 180000 });
await page.evaluate(() => window.__vw.step(1 / 30, 45));

const HASH = () => {
  const c = document.getElementById('shot');
  const ctx = c.getContext('2d');
  const { width: w, height: h } = c;
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = [];
  for (let by = 0; by < 8; by++) for (let bx = 0; bx < 8; bx++) {
    let s = 0, n = 0;
    for (let y = Math.floor(by * h / 8); y < Math.floor((by + 1) * h / 8); y += 2)
      for (let x = Math.floor(bx * w / 8); x < Math.floor((bx + 1) * w / 8); x += 2) {
        const i = (y * w + x) * 4; s += (d[i] + d[i + 1] + d[i + 2]) / 3; n++;
      }
    out.push(+(s / n).toFixed(2));
  }
  return out;
};
const diff = (a, b) => +(a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length).toFixed(3);

for (const mode of [0, 1, 4, 5]) {
  await page.evaluate((m) => window.__vw.setDebugMode(m), mode);
  const at = async (yaw) => {
    await page.evaluate((y) => window.__vw.setView({ yawDeg: y, pitchDeg: 16 }), yaw);
    await page.evaluate(() => window.__vw.render());
    await page.evaluate(() => window.__vw.render());
    return page.evaluate(HASH);
  };
  const a = await at(0), b = await at(180);
  console.log(`debugMode ${mode}: diff(yaw0, yaw180) = ${diff(a, b)}`);
}
// Does the shader see the camera at all? Read back the uniform the GPU was given.
console.log('uniform camPos after yaw180:', await page.evaluate(() => {
  const v = window.__vw.world.pass.camPos.value; return [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
}));
await browser.close();

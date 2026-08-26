import { expect, type Page } from '@playwright/test';
import type { WorldMetrics } from '../src/three/VolumetricWorld';

export interface OpenOptions {
  preset?: string;
  render?: boolean;
  seed?: number;
  extra?: Record<string, string>;
}

/** Load a scene in deterministic test mode and wait until the engine is ready. */
export async function openScene(page: Page, scene: string, opts: OpenOptions = {}): Promise<void> {
  const q = new URLSearchParams({
    scene,
    preset: opts.preset ?? 'test',
    test: '1',
    seed: String(opts.seed ?? 7),
  });
  if (!opts.render) q.set('norender', '1');
  for (const [k, v] of Object.entries(opts.extra ?? {})) q.set(k, v);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  (page as any).__vwErrors = errors;

  await page.goto(`/?${q.toString()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__vwReady || (window as any).__vwError, null, {
    timeout: 240_000,
  });
  const initError = await page.evaluate(() => (window as any).__vwError);
  expect(initError, 'engine should initialize WebGPU').toBeFalsy();
}

/** Advance the deterministic simulation by n fixed steps of dt seconds. */
export async function step(page: Page, n: number, dt = 1 / 30): Promise<void> {
  // Chunk the stepping so a single evaluate never stalls the protocol too long.
  const chunk = 20;
  for (let done = 0; done < n; done += chunk) {
    const count = Math.min(chunk, n - done);
    await page.evaluate(
      ([c, d]) => (window as any).__vw.step(d, c),
      [count, dt] as [number, number],
    );
  }
}

export async function metrics(page: Page): Promise<WorldMetrics> {
  return (await page.evaluate(() => (window as any).__vw.metrics())) as WorldMetrics;
}

export async function massInRegion(
  page: Page,
  min: [number, number, number],
  max: [number, number, number],
): Promise<number> {
  return (await page.evaluate(
    ([a, b]) => (window as any).__vw.massInRegion(a, b),
    [min, max] as [[number, number, number], [number, number, number]],
  )) as number;
}

export async function render(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__vw.render());
}

export function pageErrors(page: Page): string[] {
  return ((page as any).__vwErrors ?? []) as string[];
}

/** Center of mass + spread (std dev) of an island's coarse grid, in world space. */
export function gridStats(island: WorldMetrics['islands'][number]): {
  mass: number;
  com: [number, number, number];
  spreadXZ: number;
  maxY: number;
} {
  const c = 16;
  const cell = island.sizeM / c;
  let m = 0, mx = 0, my = 0, mz = 0;
  let maxY = -Infinity;
  for (let z = 0; z < c; z++) {
    for (let y = 0; y < c; y++) {
      for (let x = 0; x < c; x++) {
        const i = (x + y * c + z * c * c) * 4;
        const mm = island.coarse[i];
        if (mm <= 1e-6) continue;
        const wx = island.origin[0] + (x + 0.5) * cell;
        const wy = island.origin[1] + (y + 0.5) * cell;
        const wz = island.origin[2] + (z + 0.5) * cell;
        m += mm;
        mx += mm * wx;
        my += mm * wy;
        mz += mm * wz;
        if (mm > 0.05 && wy > maxY) maxY = wy;
      }
    }
  }
  if (m <= 1e-9) return { mass: 0, com: [0, 0, 0], spreadXZ: 0, maxY: 0 };
  const com: [number, number, number] = [mx / m, my / m, mz / m];
  let vxz = 0;
  for (let z = 0; z < c; z++) {
    for (let y = 0; y < c; y++) {
      for (let x = 0; x < c; x++) {
        const i = (x + y * c + z * c * c) * 4;
        const mm = island.coarse[i];
        if (mm <= 1e-6) continue;
        const wx = island.origin[0] + (x + 0.5) * cell;
        const wz = island.origin[2] + (z + 0.5) * cell;
        vxz += mm * ((wx - com[0]) ** 2 + (wz - com[2]) ** 2);
      }
    }
  }
  return { mass: m, com, spreadXZ: Math.sqrt(vxz / m), maxY };
}

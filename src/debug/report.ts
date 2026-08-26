/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import type { VolumetricWorld } from '../three/VolumetricWorld';
import type { Diag } from './diag';

/**
 * One-click debug report: everything needed to diagnose a remote machine —
 * adapter/limits, engine + scheduler state, GPU-readback metrics, frame-time
 * statistics, the captured error log, and a JPEG of the current frame —
 * bundled as a JSON blob that auto-downloads.
 */

/** Rolling per-frame timing samples recorded by the demo loop. */
export class PerfRing {
  private buf: { dt: number; updateMs: number; renderMs: number }[] = [];
  private cap = 360;

  push(sample: { dt: number; updateMs: number; renderMs: number }): void {
    this.buf.push(sample);
    if (this.buf.length > this.cap) this.buf.shift();
  }

  summary(): Record<string, unknown> {
    if (this.buf.length === 0) return { samples: 0 };
    const stat = (pick: (s: { dt: number; updateMs: number; renderMs: number }) => number) => {
      const v = this.buf.map(pick).sort((a, b) => a - b);
      const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
      return {
        avg: +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(2),
        p50: +at(0.5).toFixed(2),
        p95: +at(0.95).toFixed(2),
        max: +v[v.length - 1].toFixed(2),
      };
    };
    return {
      samples: this.buf.length,
      fps: +(1000 / Math.max(1e-3, this.buf.reduce((s, x) => s + x.dt, 0) / this.buf.length)).toFixed(1),
      frameMs: stat((s) => s.dt),
      simUpdateMs: stat((s) => s.updateMs),
      renderMs: stat((s) => s.renderMs),
      last120: this.buf.slice(-120).map((s) => [+s.dt.toFixed(1), +s.updateMs.toFixed(1), +s.renderMs.toFixed(1)]),
    };
  }
}

export async function buildDebugReport(
  world: VolumetricWorld,
  diag: Diag,
  extra: {
    sceneId: string;
    presetName: string;
    perf: PerfRing;
    frameDataUrl?: string;
    camera?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  let adapterDetail: Record<string, unknown> = {};
  try {
    const adapter = await (navigator as any).gpu?.requestAdapter();
    if (adapter) {
      const lim = adapter.limits;
      adapterDetail = {
        features: [...adapter.features.values()],
        limits: Object.fromEntries(
          [
            'maxTextureDimension2D', 'maxTextureDimension3D', 'maxSampledTexturesPerShaderStage',
            'maxStorageBuffersPerShaderStage', 'maxStorageTexturesPerShaderStage',
            'maxUniformBufferBindingSize', 'maxStorageBufferBindingSize', 'maxBufferSize',
            'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupsPerDimension',
          ].map((k) => [k, lim?.[k]]),
        ),
      };
    }
  } catch (e) {
    adapterDetail = { error: String(e) };
  }

  let metrics: unknown = null;
  try {
    const m = await world.metrics();
    metrics = {
      ...m,
      // Raw 16³ coarse grids are large; keep per-island summaries.
      islands: m.islands.map((i) => ({
        slot: i.slot, tier: i.tier, rateHz: i.rateHz, sizeM: i.sizeM,
        origin: i.origin.map((v) => +v.toFixed(2)),
        massKg: +i.massKg.toFixed(2),
        comWorld: i.comWorld.map((v) => +v.toFixed(2)),
      })),
    };
  } catch (e) {
    metrics = { error: String(e) };
  }

  const info: any = world.renderer.info;
  return {
    generatedAt: new Date().toISOString(),
    url: location.href,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    windowSize: [window.innerWidth, window.innerHeight],
    canvasSize: [world.renderer.domElement?.width, world.renderer.domElement?.height],
    threeRevision: THREE.REVISION,
    scene: extra.sceneId,
    camera: extra.camera ?? null,
    preset: { ...world.preset, presetKey: extra.presetName },
    gpu: { info: world.gpuInfo, softwareAdapter: world.softwareAdapter, ...adapterDetail },
    engine: {
      simTimeS: +world.simTime.toFixed(2),
      wind: world.wind,
      qualityScale: +world.scheduler.qualityScale.toFixed(3),
      gpuMsAverage: +world.scheduler.gpuMsAverage.toFixed(3),
      islands: world.scheduler.islands.map((i) => ({
        slot: i.slot, active: i.active, tier: i.tier, rateHz: i.rateHz,
        sizeM: i.sizeM, center: i.center.map((v) => +v.toFixed(1)),
        importance: +i.importance.toFixed(4), estMassKg: +i.estimatedMassKg.toFixed(1),
        retiring: i.retiring, stepCount: i.stepCount, renderFade: +i.renderFade.toFixed(2),
      })),
      packets: {
        count: world.packets.packets.length,
        massKg: +world.packets.totalMass().toFixed(1),
        sample: world.packets.packets.slice(0, 8).map((p) => ({
          pos: p.position.map((v) => +v.toFixed(1)),
          radii: p.radii.map((v) => +v.toFixed(2)),
          massKg: +p.massKg.toFixed(2),
          age: +p.ageSeconds.toFixed(1),
        })),
      },
    },
    metrics,
    rendererInfo: {
      renderCalls: info?.render?.calls,
      renderTimestampMs: info?.render?.timestamp,
      computeCalls: info?.compute?.calls,
      computeTimestampMs: info?.compute?.timestamp,
      memoryGeometries: info?.memory?.geometries,
      memoryTextures: info?.memory?.textures,
    },
    perf: extra.perf.summary(),
    log: diag.entries,
    frameJpeg: extra.frameDataUrl ?? null,
  };
}

export function downloadReport(report: Record<string, unknown>, sceneId: string): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vw-debug-${sceneId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

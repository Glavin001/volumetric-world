import type { QualityPreset } from './types';

/**
 * Pooled island slots are fixed-resolution cubes packed into one shared 3D
 * texture atlas; tiers vary world extent and simulation rate (so voxel size
 * still scales with importance while resources stay pooled and pre-allocated).
 */
export const PRESETS: Record<string, QualityPreset> = {
  /** Tiny grids for CI / software-rasterized WebGPU (SwiftShader). */
  test: {
    name: 'test',
    slotRes: 32,
    slots: 4,
    slotClasses: ['fine', 'fine', 'coarse', 'coarse'],
    raySteps: 40,
    lightSteps: 24,
    renderScale: 0.5,
    maxRenderPackets: 16,
    pressureIters: 28,
    lightRateHz: 10,
    temporal: false,
    tierSizeM: { small: 8, medium: 12, hero: 16 },
    tierRateHz: { small: 20, medium: 20, hero: 20 },
  },
  low: {
    name: 'low',
    slotRes: 48,
    slots: 4,
    slotClasses: ['fine', 'fine', 'coarse', 'coarse'],
    raySteps: 56,
    lightSteps: 32,
    renderScale: 0.5,
    maxRenderPackets: 16,
    pressureIters: 30,
    lightRateHz: 10,
    temporal: true,
    tierSizeM: { small: 9, medium: 14, hero: 20 },
    tierRateHz: { small: 20, medium: 15, hero: 15 },
  },
  medium: {
    name: 'medium',
    slotRes: 64,
    slots: 4,
    slotClasses: ['fine', 'fine', 'coarse', 'coarse'],
    raySteps: 72,
    lightSteps: 40,
    renderScale: 0.5,
    maxRenderPackets: 48,
    pressureIters: 34,
    lightRateHz: 12,
    temporal: true,
    tierSizeM: { small: 10, medium: 16, hero: 22 },
    tierRateHz: { small: 30, medium: 20, hero: 15 },
  },
  high: {
    name: 'high',
    slotRes: 96,
    slots: 4,
    slotClasses: ['fine', 'fine', 'coarse', 'coarse'],
    raySteps: 96,
    lightSteps: 56,
    renderScale: 0.5,
    maxRenderPackets: 96,
    pressureIters: 40,
    lightRateHz: 15,
    temporal: true,
    tierSizeM: { small: 10, medium: 18, hero: 26 },
    tierRateHz: { small: 30, medium: 20, hero: 20 },
  },
};

export function resolvePreset(p?: QualityPreset | string): QualityPreset {
  if (!p) return PRESETS.medium;
  if (typeof p === 'string') {
    const found = PRESETS[p];
    if (!found) throw new Error(`Unknown preset '${p}'`);
    return found;
  }
  return p;
}

import type { AerosolMaterial, Vec3 } from './types';
import { luminance } from './math';

/**
 * Source materials are authored separately from substance physics. When
 * several materials mix in one voxel we do NOT store a material id — voxels
 * carry additive optical moments (extinction RGB, scattering RGB, and a
 * scattering-weighted phase moment), so concrete and drywall blend naturally.
 */

function mat(m: AerosolMaterial): AerosolMaterial {
  return m;
}

export const MATERIALS: Record<string, AerosolMaterial> = {
  concrete: mat({
    id: 'concrete',
    // Mineral dust: bright, slightly warm-grey. ~0.7 m²/g mass extinction → 700 m²/kg.
    extinctionPerMassRgbM2PerKg: [680, 700, 720],
    singleScatteringAlbedoRgb: [0.91, 0.89, 0.86],
    phaseAnisotropyG: 0.62,
    fineMassFraction: 0.35,
    coarseMassFraction: 0.65,
    coarseSettlingSpeedMps: 0.6,
    loadingScale: 1.0,
    dissipationPerSecond: 0.012,
    detail: { baseScaleM: 1.6, octaveStrength: 0.85, curlStrength: 0.8 },
    artDirection: { emissionMultiplier: 1, opacityMultiplier: 1, turbulenceMultiplier: 1 },
  }),
  drywall: mat({
    id: 'drywall',
    extinctionPerMassRgbM2PerKg: [740, 745, 750],
    singleScatteringAlbedoRgb: [0.96, 0.955, 0.94],
    phaseAnisotropyG: 0.66,
    fineMassFraction: 0.55,
    coarseMassFraction: 0.45,
    coarseSettlingSpeedMps: 0.35,
    loadingScale: 0.85,
    dissipationPerSecond: 0.02,
    detail: { baseScaleM: 1.2, octaveStrength: 0.9, curlStrength: 0.9 },
    artDirection: { emissionMultiplier: 1, opacityMultiplier: 1, turbulenceMultiplier: 1 },
  }),
  asphalt: mat({
    id: 'asphalt',
    extinctionPerMassRgbM2PerKg: [620, 600, 580],
    singleScatteringAlbedoRgb: [0.55, 0.53, 0.5],
    phaseAnisotropyG: 0.5,
    fineMassFraction: 0.3,
    coarseMassFraction: 0.7,
    coarseSettlingSpeedMps: 0.9,
    loadingScale: 1.15,
    dissipationPerSecond: 0.015,
    detail: { baseScaleM: 1.8, octaveStrength: 0.75, curlStrength: 0.7 },
    artDirection: { emissionMultiplier: 1, opacityMultiplier: 1, turbulenceMultiplier: 1 },
  }),
  woodDust: mat({
    id: 'woodDust',
    extinctionPerMassRgbM2PerKg: [700, 660, 590],
    singleScatteringAlbedoRgb: [0.88, 0.8, 0.62],
    phaseAnisotropyG: 0.58,
    fineMassFraction: 0.45,
    coarseMassFraction: 0.55,
    coarseSettlingSpeedMps: 0.5,
    loadingScale: 0.7,
    dissipationPerSecond: 0.02,
    detail: { baseScaleM: 1.3, octaveStrength: 0.9, curlStrength: 0.85 },
    artDirection: { emissionMultiplier: 1, opacityMultiplier: 1, turbulenceMultiplier: 1 },
  }),
  /** Grey soot-tinged smoke, still handled by the cold-aerosol solver in V1. */
  smoke: mat({
    id: 'smoke',
    extinctionPerMassRgbM2PerKg: [900, 900, 900],
    singleScatteringAlbedoRgb: [0.45, 0.45, 0.47],
    phaseAnisotropyG: 0.45,
    fineMassFraction: 0.95,
    coarseMassFraction: 0.05,
    coarseSettlingSpeedMps: 0.05,
    loadingScale: -0.35, // hot smoke rises: negative loading = positive buoyancy stand-in
    dissipationPerSecond: 0.03,
    detail: { baseScaleM: 1.0, octaveStrength: 1.0, curlStrength: 1.0 },
    artDirection: { emissionMultiplier: 1, opacityMultiplier: 1, turbulenceMultiplier: 1 },
  }),
};

export function getMaterial(id: string): AerosolMaterial {
  const m = MATERIALS[id];
  if (!m) throw new Error(`Unknown material '${id}'`);
  return m;
}

export function registerMaterial(m: AerosolMaterial): void {
  MATERIALS[m.id] = m;
}

/** Per-voxel additive optical moments produced by a unit of fine mass (per kg/m³ of loading). */
export interface OpticalRates {
  /** σt per unit loading (m⁻¹ per kg/m³) per RGB channel. */
  extRgb: Vec3;
  /** σs per unit loading. */
  scatRgb: Vec3;
  /** g · luminance(σs) per unit loading (scattering-weighted phase moment). */
  phaseW: number;
}

export function opticalRates(m: AerosolMaterial): OpticalRates {
  const opacity = m.artDirection.opacityMultiplier;
  const extRgb: Vec3 = [
    m.extinctionPerMassRgbM2PerKg[0] * opacity,
    m.extinctionPerMassRgbM2PerKg[1] * opacity,
    m.extinctionPerMassRgbM2PerKg[2] * opacity,
  ];
  const scatRgb: Vec3 = [
    extRgb[0] * m.singleScatteringAlbedoRgb[0],
    extRgb[1] * m.singleScatteringAlbedoRgb[1],
    extRgb[2] * m.singleScatteringAlbedoRgb[2],
  ];
  return { extRgb, scatRgb, phaseW: m.phaseAnisotropyG * luminance(scatRgb) };
}

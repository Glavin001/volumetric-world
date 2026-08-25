/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import { storage, float, int, vec3, vec4, floor, fract, clamp, mix } from 'three/tsl';

/**
 * GPU field = storage buffer + lattice dimensions. Velocity uses a staggered
 * MAC layout (three scalar face fields); scalars are cell-centered. All
 * sampling helpers work in "lattice space" where sample n sits at coordinate n.
 */
export interface GpuField {
  attr: THREE.StorageBufferAttribute;
  node: any;
  nx: number;
  ny: number;
  nz: number;
  itemSize: 1 | 4;
  count: number;
}

export function makeField(nx: number, ny: number, nz: number, itemSize: 1 | 4, label: string): GpuField {
  const count = nx * ny * nz;
  const attr = new THREE.StorageBufferAttribute(new Float32Array(count * itemSize), itemSize);
  attr.name = label;
  const node = storage(attr, itemSize === 1 ? 'float' : 'vec4', count);
  node.setName?.(label);
  return { attr, node, nx, ny, nz, itemSize, count };
}

/** idx = x + nx*(y + ny*z) for int nodes. */
export function fieldIndex(f: GpuField, x: any, y: any, z: any): any {
  return x.add(int(f.nx).mul(y.add(int(f.ny).mul(z))));
}

/** Decompose a linear invocation index into int lattice coords. */
export function fieldCoord(f: GpuField, linear: any): { x: any; y: any; z: any } {
  const i = int(linear).toVar();
  const nxny = int(f.nx * f.ny);
  const z = i.div(nxny).toVar();
  const rem = i.sub(z.mul(nxny)).toVar();
  const y = rem.div(int(f.nx)).toVar();
  const x = rem.sub(y.mul(int(f.nx))).toVar();
  return { x, y, z };
}

/** Nearest read with clamped int coords. */
export function loadClamped(f: GpuField, x: any, y: any, z: any): any {
  const cx = clamp(x, int(0), int(f.nx - 1));
  const cy = clamp(y, int(0), int(f.ny - 1));
  const cz = clamp(z, int(0), int(f.nz - 1));
  return f.node.element(fieldIndex(f, cx, cy, cz));
}

/** Trilinear sample at continuous lattice coords (clamp-to-edge). */
export function sampleLinear(f: GpuField, p: any): any {
  const pc = clamp(
    p,
    vec3(0.0),
    vec3(float(f.nx - 1.001), float(f.ny - 1.001), float(f.nz - 1.001)),
  ).toVar();
  const i0 = floor(pc).toVar();
  const fr = fract(pc).toVar();
  const x0 = int(i0.x).toVar();
  const y0 = int(i0.y).toVar();
  const z0 = int(i0.z).toVar();
  const x1 = clamp(x0.add(int(1)), int(0), int(f.nx - 1)).toVar();
  const y1 = clamp(y0.add(int(1)), int(0), int(f.ny - 1)).toVar();
  const z1 = clamp(z0.add(int(1)), int(0), int(f.nz - 1)).toVar();

  const v000 = f.node.element(fieldIndex(f, x0, y0, z0));
  const v100 = f.node.element(fieldIndex(f, x1, y0, z0));
  const v010 = f.node.element(fieldIndex(f, x0, y1, z0));
  const v110 = f.node.element(fieldIndex(f, x1, y1, z0));
  const v001 = f.node.element(fieldIndex(f, x0, y0, z1));
  const v101 = f.node.element(fieldIndex(f, x1, y0, z1));
  const v011 = f.node.element(fieldIndex(f, x0, y1, z1));
  const v111 = f.node.element(fieldIndex(f, x1, y1, z1));

  const c00 = mix(v000, v100, fr.x);
  const c10 = mix(v010, v110, fr.x);
  const c01 = mix(v001, v101, fr.x);
  const c11 = mix(v011, v111, fr.x);
  const c0 = mix(c00, c10, fr.y);
  const c1 = mix(c01, c11, fr.y);
  return mix(c0, c1, fr.z);
}

/** Min/max of the 8 lattice neighbors around continuous coords (for MacCormack clamping). */
export function neighborhoodMinMax(f: GpuField, p: any): { lo: any; hi: any } {
  const pc = clamp(
    p,
    vec3(0.0),
    vec3(float(f.nx - 1.001), float(f.ny - 1.001), float(f.nz - 1.001)),
  ).toVar();
  const i0 = floor(pc).toVar();
  const x0 = int(i0.x).toVar();
  const y0 = int(i0.y).toVar();
  const z0 = int(i0.z).toVar();
  const x1 = clamp(x0.add(int(1)), int(0), int(f.nx - 1)).toVar();
  const y1 = clamp(y0.add(int(1)), int(0), int(f.ny - 1)).toVar();
  const z1 = clamp(z0.add(int(1)), int(0), int(f.nz - 1)).toVar();
  const a = f.node.element(fieldIndex(f, x0, y0, z0)).toVar();
  const lo = vec4(a).toVar();
  const hi = vec4(a).toVar();
  const consider = (v: any) => {
    lo.assign(lo.min(v));
    hi.assign(hi.max(v));
  };
  consider(f.node.element(fieldIndex(f, x1, y0, z0)));
  consider(f.node.element(fieldIndex(f, x0, y1, z0)));
  consider(f.node.element(fieldIndex(f, x1, y1, z0)));
  consider(f.node.element(fieldIndex(f, x0, y0, z1)));
  consider(f.node.element(fieldIndex(f, x1, y0, z1)));
  consider(f.node.element(fieldIndex(f, x0, y1, z1)));
  consider(f.node.element(fieldIndex(f, x1, y1, z1)));
  return { lo, hi };
}

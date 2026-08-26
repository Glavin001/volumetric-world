/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, array, float, int, ivec2, vec2, vec3, vec4,
  uniform, uniformArray, texture, texture3D, textureLoad, uv, storage,
  min, max, clamp, exp, sqrt, pow, mix, smoothstep, normalize, length, dot, fract, floor, sin,
} from 'three/tsl';
import type { VolumeAtlas } from '../webgpu/outputKernels';

export const MAX_ISLANDS = 4;
/** Screen-tile packet culling: tile size in half-res pixels and list capacity. */
export const TILE_PX = 24;
export const MAX_TILES = 4096;
export const MAX_PER_TILE = 16;
export const TILE_STRIDE = MAX_PER_TILE + 1; // [count, idx0..idx15]
/** Global shadow-caster list: the optically heaviest packets shadow everywhere. */
export const MAX_HEAVY = 8;
export const ISLE_STRIDE = 3; // m0 origin+size | m1 slotOffVox+active | m2 age+fade
export const PKT_STRIDE = 5; // r0 pos+fade | r1 radii+phaseG | r2 ext0+detailScale | r3 albedo+age | r4 vel+seed

function v4arr(n: number): THREE.Vector4[] {
  return Array.from({ length: n }, () => new THREE.Vector4());
}

/**
 * Physically based volumetric renderer: one half-resolution raymarch over the
 * island atlas + analytic far-field packets, with Beer–Lambert extinction,
 * dual-lobe HG phase, multiple-scattering octaves, per-island sun transmittance
 * caches, advective sub-step interpolation, sub-grid detail noise, temporal
 * history blending, and a depth-aware composite that also casts dust shadows
 * onto the opaque world.
 */
export class VolumetricPass {
  // Render targets
  sceneRT: THREE.RenderTarget;
  histRT: [THREE.RenderTarget, THREE.RenderTarget];
  /** Final composite target used in 'readback' present mode (headless CI). */
  outRT: THREE.RenderTarget | null = null;
  /** 'canvas' presents to the WebGPU canvas; 'readback' composites into a
   * readable target instead (SwiftShader headless crashes on presentation). */
  presentMode: 'canvas' | 'readback' = 'canvas';
  private frame = 0;

  // Uniforms
  camPos = uniform(new THREE.Vector3());
  camProjInv = uniform(new THREE.Matrix4());
  camWorld = uniform(new THREE.Matrix4());
  prevViewProj = uniform(new THREE.Matrix4());
  sunDir = uniform(new THREE.Vector3(0.35, 0.75, 0.25));
  sunColor = uniform(new THREE.Color(1.0, 0.96, 0.9));
  sunIntensity = uniform(28);
  skyColor = uniform(new THREE.Color(0.45, 0.62, 0.85));
  skyIntensity = uniform(1.6);
  groundBounce = uniform(new THREE.Color(0.25, 0.22, 0.2));
  exposure = uniform(0.62);
  raySteps = uniform(64);
  detailStrength = uniform(0.75);
  timeS = uniform(0);
  frameIdx = uniform(0);
  historyBlend = uniform(0.82);
  camDelta = uniform(0);
  fullSize = uniform(new THREE.Vector2(1, 1));
  halfSize = uniform(new THREE.Vector2(1, 1));
  dustShadowStrength = uniform(0.85);
  /** Extinction multiplier for self-shadowing only (film translucency trick). */
  shadowDensity = uniform(0.35);
  debugMode = uniform(0); // 0 off | 1 opaque distance | 2 density slice | 3 shadow slice

  islandCount = uniform(0);
  islandMeta = uniformArray(v4arr(MAX_ISLANDS * ISLE_STRIDE));
  packetCount = uniform(0);
  packets: any;

  // Per-screen-tile packet index lists (CPU-binned each frame) so a ray only
  // evaluates the packets that can touch its pixel, plus a tiny global list of
  // the heaviest packets used for sun shadows (a caster can be off-tile).
  tileData = new Uint32Array(MAX_TILES * TILE_STRIDE);
  tileAttr: THREE.StorageBufferAttribute;
  private tileNode: any;
  tilesX = uniform(1);
  tilesY = uniform(1);
  heavyIdx = uniformArray(new Array(MAX_HEAVY).fill(0));
  heavyCount = uniform(0);

  private raymarchMat: THREE.NodeMaterial;
  private compositeMat: THREE.NodeMaterial;
  private quad: any;
  private historyTexNode: any;
  private volTexNode: any;
  private sceneTexNode: any;
  private renderScale: number;

  /** Compile-time shader bisect level (dev): 0 full | 1 no packets | 2 no islands | 3 flat. */
  private buildLevel = 0;

  constructor(
    private renderer: THREE.WebGPURenderer,
    private atlas: VolumeAtlas,
    opts: { renderScale: number; maxRenderPackets: number; temporal: boolean },
  ) {
    this.renderScale = opts.renderScale;
    if (typeof location !== 'undefined') {
      this.buildLevel = Number(new URLSearchParams(location.search).get('mlevel') ?? 0);
    }
    this.packets = uniformArray(v4arr(opts.maxRenderPackets * PKT_STRIDE));
    this.tileAttr = new THREE.StorageBufferAttribute(this.tileData, 1);
    this.tileAttr.name = 'packetTiles';
    (this.tileAttr as any).usage = THREE.DynamicDrawUsage;
    this.tileNode = storage(this.tileAttr, 'uint', this.tileData.length);

    const w = 8, h = 8; // resized on first setSize
    this.sceneRT = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType });
    this.sceneRT.texture.name = 'sceneColor';
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.FloatType;
    this.sceneRT.depthTexture = depthTexture;

    const mkHist = (label: string) => {
      const rt = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType });
      rt.texture.name = label;
      rt.texture.generateMipmaps = false;
      return rt;
    };
    this.histRT = [mkHist('vol0'), mkHist('vol1')];

    this.sceneTexNode = texture(this.sceneRT.texture);
    this.historyTexNode = texture(this.histRT[1].texture);
    this.volTexNode = texture(this.histRT[0].texture);

    this.raymarchMat = new THREE.NodeMaterial();
    this.raymarchMat.name = 'volRaymarch';
    this.raymarchMat.fragmentNode = this.buildRaymarch(opts.temporal);
    this.raymarchMat.depthTest = false;
    this.raymarchMat.depthWrite = false;

    this.compositeMat = new THREE.NodeMaterial();
    this.compositeMat.name = 'volComposite';
    this.compositeMat.fragmentNode = this.buildComposite();
    this.compositeMat.depthTest = false;
    this.compositeMat.depthWrite = false;

    this.quad = new THREE.QuadMesh(this.raymarchMat);
  }

  setSize(w: number, h: number): void {
    this.sceneRT.setSize(w, h);
    const hw = Math.max(2, Math.round(w * this.renderScale));
    const hh = Math.max(2, Math.round(h * this.renderScale));
    this.histRT[0].setSize(hw, hh);
    this.histRT[1].setSize(hw, hh);
    (this.fullSize.value as THREE.Vector2).set(w, h);
    (this.halfSize.value as THREE.Vector2).set(hw, hh);
    (this.tilesX as any).value = Math.max(1, Math.ceil(hw / TILE_PX));
    (this.tilesY as any).value = Math.max(1, Math.ceil(hh / TILE_PX));
    this.outRT?.setSize(w, h);
  }

  ensureOutRT(): void {
    if (!this.outRT) {
      this.outRT = new THREE.RenderTarget(this.sceneRT.width, this.sceneRT.height, {
        type: THREE.UnsignedByteType,
      });
      this.outRT.texture.name = 'finalOut';
    }
  }

  enableReadbackPresent(): void {
    this.presentMode = 'readback';
    this.ensureOutRT();
  }

  /** Read the composite target and draw it into a 2D canvas (readback mode). */
  async blitToCanvas2D(ctx: CanvasRenderingContext2D): Promise<void> {
    if (!this.outRT) return;
    const w = this.outRT.width;
    const h = this.outRT.height;
    const pixels = (await (this.renderer as any).readRenderTargetPixelsAsync(
      this.outRT, 0, 0, w, h,
    )) as Uint8Array;
    // The returned buffer keeps WebGPU's 256-byte row alignment — unpad it.
    const rowBytes = w * 4;
    const paddedRow = Math.ceil(rowBytes / 256) * 256;
    const tight = new Uint8ClampedArray(rowBytes * h);
    for (let row = 0; row < h; row++) {
      tight.set(new Uint8Array(pixels.buffer as ArrayBuffer, pixels.byteOffset + row * paddedRow, rowBytes), row * rowBytes);
    }
    const img = new ImageData(tight, w, h);
    ctx.canvas.width = w;
    ctx.canvas.height = h;
    ctx.putImageData(img, 0, 0);
  }

  /** World position + opaque distance reconstruction (WebGPU depth convention). */
  private reconstruct(uvNode: any) {
    // Depth is point-sampled from the full-res depth attachment at the same uv
    // used for color sampling (texel = uv·size, no flip — same rasterization).
    const pxf = clamp(uvNode.mul(this.fullSize), vec2(0.0), this.fullSize.sub(1.0));
    const depth = float(textureLoad(this.sceneRT.depthTexture as THREE.DepthTexture, ivec2(pxf))).toVar();
    // WebGPU NDC: x,y in [-1,1], z in [0,1] equals the stored depth. The
    // fullscreen quad's v runs top-to-bottom (v=0 is the TOP row — verify with
    // debugMode=9), so NDC y must be flipped. Getting this wrong mirrors every
    // volumetric ray about the view axis: ground dust marches into the sky and
    // the volume swings opposite to the world as the camera moves.
    const ndc = vec4(uvNode.x.mul(2).sub(1), float(1).sub(uvNode.y.mul(2)), depth, 1.0);
    const viewP = this.camProjInv.mul(ndc).toVar();
    const view3 = viewP.xyz.div(viewP.w).toVar();
    const world = this.camWorld.mul(vec4(view3, 1.0)).xyz.toVar();
    return { world, depth };
  }

  /** Analytic optical depth of one packet along a ray (Gaussian line integral, half line). */
  private packetRayOD(base: any, p: any, dir: any) {
    const r0 = this.packets.element(base);
    const r1 = this.packets.element(base.add(int(1)));
    const r2 = this.packets.element(base.add(int(2)));
    const radii = max(r1.xyz, vec3(1e-3));
    const xp = p.sub(r0.xyz).div(radii).toVar();
    const dp = dir.div(radii).toVar();
    const a = max(dot(dp, dp), 1e-6).toVar();
    const b = dot(xp, dp).toVar();
    const c = dot(xp, xp).toVar();
    const peak = dot(r2.xyz, vec3(0.2126, 0.7152, 0.0722)).mul(r0.w);
    const expArg = c.sub(b.mul(b).div(a)).mul(-0.5);
    const halfLine = clamp(float(0.5).sub(b.mul(0.4).div(sqrt(a))), 0.0, 1.0);
    return peak.mul(exp(clamp(expArg, -20.0, 0.0))).mul(sqrt(float(6.2832).div(a))).mul(halfLine);
  }

  private hg(cosT: any, g: any) {
    const g2 = g.mul(g);
    const denom = pow(max(g2.add(1.0).sub(g.mul(cosT).mul(2.0)), 1e-3), 1.5);
    return g2.oneMinus().div(denom).mul(0.0796); // 1/(4π)
  }

  /** Compact trilinear value noise (sin-hash) — tiny WGSL footprint vs. MaterialX noise. */
  private valueNoise(p: any) {
    const ip = floor(p).toVar();
    const fp = fract(p).toVar();
    const f = fp.mul(fp).mul(fp.mul(-2).add(3)).toVar();
    const h = (o: any) =>
      fract(sin(dot(ip.add(o), vec3(127.1, 311.7, 74.7))).mul(43758.5453));
    const n000 = h(vec3(0, 0, 0));
    const n100 = h(vec3(1, 0, 0));
    const n010 = h(vec3(0, 1, 0));
    const n110 = h(vec3(1, 1, 0));
    const n001 = h(vec3(0, 0, 1));
    const n101 = h(vec3(1, 0, 1));
    const n011 = h(vec3(0, 1, 1));
    const n111 = h(vec3(1, 1, 1));
    const nx00 = mix(n000, n100, f.x);
    const nx10 = mix(n010, n110, f.x);
    const nx01 = mix(n001, n101, f.x);
    const nx11 = mix(n011, n111, f.x);
    return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z).mul(2).sub(1);
  }

  private fbm(p: any) {
    const n1 = this.valueNoise(p);
    // Swizzled second octave breaks up axis-aligned value-noise streaks.
    const n2 = this.valueNoise(p.yzx.mul(2.73).add(vec3(11.31, 7.7, 5.1))).mul(0.5);
    return n1.add(n2).mul(0.666); // ≈ [-1, 1]
  }

  /**
   * Shared sub-grid detail modulation for BOTH islands and packets: the same
   * fbm response and the same σt-driven edge erosion, so a plume keeps an
   * identical surface texture across the grid↔packet handoff.
   */
  private detailModulate(n01: any, sigLum: any) {
    // Smoothstep-shaped response: the raw fbm value produces binary
    // cauliflower lumps; easing it keeps billow structure but soft flanks.
    const nS = n01.mul(n01).mul(n01.mul(-2.0).add(3.0));
    const edge = smoothstep(1.2, 0.05, sigLum);
    return clamp(
      nS.mul(this.detailStrength).mul(1.5)
        .add(float(1.0).sub(this.detailStrength.mul(0.6)))
        .sub(edge.mul(this.detailStrength).mul(nS.oneMinus()).mul(0.9)),
      0.0,
      1.9,
    );
  }

  private buildRaymarch(temporal: boolean): any {
    const atlas = this.atlas;
    const atlasDims = vec3(atlas.dimX, atlas.dimY, atlas.dimZ);
    const N = float(atlas.slotRes);

    if (this.buildLevel >= 3) {
      return Fn(() => vec4(0.0, 0.0, 0.0, 1.0))();
    }
    return Fn(() => {
      const uvN = uv().toVar();
      const { world: opaqueWorld } = this.reconstruct(uvN);
      const opaqueDist = length(opaqueWorld.sub(this.camPos)).toVar();

      // Camera ray through this pixel (far-plane reconstruction shares conventions).
      const ndcFar = vec4(uvN.x.mul(2).sub(1), float(1).sub(uvN.y.mul(2)), 1.0, 1.0);
      const vpFar = this.camProjInv.mul(ndcFar).toVar();
      const farWorld = this.camWorld.mul(vec4(vpFar.xyz.div(vpFar.w), 1.0)).xyz;
      const rayDir = normalize(farWorld.sub(this.camPos)).toVar();

      // Per-volume ray segments instead of one union interval: a single
      // [min, max] over all volumes marched the empty gaps between them, so a
      // distant cloud stole samples from a near one. Up to 4 island segments
      // plus one packet-cluster segment; sorted, overlap-clipped, and given
      // steps proportional to length with a near-field bias.
      // This pixel's packet tile (count + indices into the packet array).
      const pixT = uvN.mul(this.halfSize).toVar();
      const tX = clamp(int(pixT.x.div(TILE_PX)), int(0), int(this.tilesX).sub(int(1))).toVar();
      const tY = clamp(int(pixT.y.div(TILE_PX)), int(0), int(this.tilesY).sub(int(1))).toVar();
      const tileBase = tY.mul(int(this.tilesX)).add(tX).mul(int(TILE_STRIDE)).toVar();
      const tileCnt = int(this.tileNode.element(tileBase)).toVar();

      const segs = array('vec4', 5).toVar();
      for (let s = 0; s < 5; s++) segs.element(int(s)).assign(vec4(1e9, 1e9, 0.0, 0.0));
      const segCount = int(0).toVar();
      const tEnter = float(1e9).toVar();
      const tExit = float(0).toVar();
      const anyVolume = float(0).toVar();
      for (let s = 0; s < MAX_ISLANDS; s++) {
        const m0 = this.islandMeta.element(int(s * ISLE_STRIDE));
        const m1 = this.islandMeta.element(int(s * ISLE_STRIDE + 1));
        If(m1.w.greaterThan(0.5), () => {
          const bmin = m0.xyz;
          const bmax = m0.xyz.add(m0.w);
          const inv = vec3(1.0).div(rayDir.add(vec3(1e-9))).toVar();
          const t0 = bmin.sub(this.camPos).mul(inv).toVar();
          const t1 = bmax.sub(this.camPos).mul(inv).toVar();
          const tsm = min(t0, t1);
          const tbg = max(t0, t1);
          const near = max(max(tsm.x, tsm.y), tsm.z).toVar();
          const far = min(min(tbg.x, tbg.y), tbg.z).toVar();
          If(far.greaterThan(max(near, 0.0)), () => {
            segs.element(segCount).assign(vec4(max(near, 0.02), far, 0.0, 0.0));
            segCount.addAssign(1);
            tEnter.assign(min(tEnter, max(near, 0.02)));
            tExit.assign(max(tExit, far));
            anyVolume.assign(1.0);
          });
        });
      }
      if (this.buildLevel < 1) {
        // The tile's packets contribute ONE cluster segment (interval union).
        const pNear = float(1e9).toVar();
        const pFar = float(0).toVar();
        Loop({ start: int(0), end: tileCnt, type: 'int', condition: '<' }, ({ i }: any) => {
          const base = int(this.tileNode.element(tileBase.add(i).add(int(1)))).mul(int(PKT_STRIDE));
          const r0 = this.packets.element(base);
          const r1 = this.packets.element(base.add(int(1)));
          const rad = max(max(r1.x, r1.y), r1.z).mul(2.6).toVar();
          const oc = r0.xyz.sub(this.camPos).toVar();
          const tMid = dot(oc, rayDir).toVar();
          const dPerp2 = dot(oc, oc).sub(tMid.mul(tMid)).toVar();
          If(dPerp2.lessThan(rad.mul(rad)), () => {
            const half = sqrt(max(rad.mul(rad).sub(dPerp2), 0.0));
            const near = max(tMid.sub(half), 0.02);
            const far = tMid.add(half);
            If(far.greaterThan(near), () => {
              pNear.assign(min(pNear, near));
              pFar.assign(max(pFar, far));
            });
          });
        });
        If(pFar.greaterThan(pNear), () => {
          segs.element(segCount).assign(vec4(pNear, pFar, 0.0, 0.0));
          segCount.addAssign(1);
          tEnter.assign(min(tEnter, pNear));
          tExit.assign(max(tExit, pFar));
          anyVolume.assign(1.0);
        });
      }

      const outCol = vec4(0.0, 0.0, 0.0, 1.0).toVar();

      If(anyVolume.greaterThan(0.5).and(tEnter.lessThan(opaqueDist)), () => {
        tExit.assign(min(tExit, opaqueDist));

        // Sort segments by near (bubble network, constant indices; the 1e9
        // sentinels sink inactive entries to the end).
        for (let a = 0; a < 4; a++) {
          for (let b = 0; b < 4 - a; b++) {
            const lo = segs.element(int(b));
            const hi = segs.element(int(b + 1));
            If(hi.x.lessThan(lo.x), () => {
              const tmp = vec4(lo).toVar();
              lo.assign(hi);
              hi.assign(tmp);
            });
          }
        }
        // Clip overlaps into a disjoint piecewise union, bounded by opaque
        // geometry, then allocate steps: proportional to length with a
        // near-field bias so a huge far span can't starve a nearby cloud.
        const prevFar = float(0.0).toVar();
        const wSum = float(0.0).toVar();
        for (let k = 0; k < 5; k++) {
          const sg = segs.element(int(k));
          If(sg.x.lessThan(1e8), () => {
            sg.x.assign(max(sg.x, prevFar));
            sg.y.assign(min(sg.y, opaqueDist));
            prevFar.assign(max(prevFar, sg.y));
            const len = max(sg.y.sub(sg.x), 0.0);
            sg.z.assign(len.div(sg.x.div(25.0).add(1.0))); // weight
            wSum.addAssign(sg.z);
          }).Else(() => {
            sg.z.assign(0.0);
          });
        }
        // segMeta per segment: (near, ds, cumulativeStepStart, 0).
        const segMeta = array('vec4', 5).toVar();
        const cAcc = float(0.0).toVar();
        for (let k = 0; k < 5; k++) {
          const sg = segs.element(int(k));
          const len = max(sg.y.sub(sg.x), 0.0).toVar();
          const stepsK = float(0.0).toVar();
          If(len.greaterThan(1e-4).and(wSum.greaterThan(1e-6)), () => {
            stepsK.assign(clamp(
              floor(this.raySteps.mul(sg.z.div(wSum)).add(0.5)),
              4.0,
              this.raySteps.mul(0.75),
            ));
          });
          segMeta.element(int(k)).assign(vec4(sg.x, len.div(max(stepsK, 1.0)), cAcc, 0.0));
          cAcc.addAssign(stepsK);
        }
        const steps = int(cAcc).toVar();

        // Interleaved-gradient jitter, animated per frame for temporal accumulation.
        const pix = uvN.mul(this.halfSize).toVar();
        const ign = fract(
          float(52.9829189).mul(fract(pix.x.mul(0.06711056).add(pix.y.mul(0.00583715)).add(this.frameIdx.mul(0.00623715)))),
        ).toVar();

        const T = float(1).toVar();
        const radiance = vec3(0.0).toVar();
        const cosT = dot(rayDir, this.sunDir).toVar();
        const tRepW = float(0).toVar();
        const tRepSum = float(0).toVar();
        const dbgAcc = float(0).toVar();
        const dbgMaxLoad = float(0).toVar();
        const dbgInside = float(0).toVar();

        Loop({ start: int(0), end: steps, type: 'int', condition: '<' }, ({ i }: any) => {
          // Map the global step index to its segment via the cumulative step
          // starts (ascending; empty segments have zero width so the later
          // assign wins and they are skipped).
          const fi = float(i).toVar();
          const segIdx = int(0).toVar();
          for (let k = 1; k < 5; k++) {
            If(fi.greaterThanEqual(segMeta.element(int(k)).z), () => {
              segIdx.assign(k);
            });
          }
          const sm = segMeta.element(segIdx).toVar();
          const ds = sm.y.toVar();
          const t = sm.x.add(ds.mul(fi.sub(sm.z).add(ign))).toVar();
          const p = this.camPos.add(rayDir.mul(t)).toVar();

          const sigT = vec3(0.0).toVar();
          const sigS = vec3(0.0).toVar();
          const gW = float(0).toVar();
          const sunTrans = float(1).toVar();

          // --- simulation islands (statically unrolled; atlas keeps bindings at 4 textures) ---
          for (let s = 0; s < (this.buildLevel < 2 ? MAX_ISLANDS : 0); s++) {
            const m0 = this.islandMeta.element(int(s * ISLE_STRIDE));
            const m1 = this.islandMeta.element(int(s * ISLE_STRIDE + 1));
            const m2 = this.islandMeta.element(int(s * ISLE_STRIDE + 2));
            If(m1.w.greaterThan(0.5), () => {
              const local = p.sub(m0.xyz).div(m0.w).toVar();
              const inside = local.x.greaterThan(0.0).and(local.y.greaterThan(0.0)).and(local.z.greaterThan(0.0))
                .and(local.x.lessThan(1.0)).and(local.y.lessThan(1.0)).and(local.z.lessThan(1.0));
              If(inside, () => {
                const uvw0 = m1.xyz.add(clamp(local, vec3(0.002), vec3(0.998)).mul(N)).div(atlasDims).toVar();
                // Advective interpolation between low-rate sim steps:
                // sample where this parcel was at the last field commit.
                const vel = texture3D(atlas.texVel, uvw0, int(0)).xyz;
                const p2 = p.sub(vel.mul(m2.x)).toVar();
                const local2 = clamp(p2.sub(m0.xyz).div(m0.w), vec3(0.002), vec3(0.998)).toVar();
                const uvw = m1.xyz.add(local2.mul(N)).div(atlasDims).toVar();
                const a = texture3D(atlas.texA, uvw, int(0)).toVar();
                dbgMaxLoad.assign(max(dbgMaxLoad, a.w));
                dbgInside.addAssign(1.0);
                If(a.w.greaterThan(1e-4), () => {
                  const b = texture3D(atlas.texB, uvw, int(0)).toVar();
                  // Sub-grid detail: advected-phase fbm modulation with edge erosion
                  // (skipped entirely when detail is disabled — software adapters).
                  const m = float(1.0).toVar();
                  If(this.detailStrength.greaterThan(0.01), () => {
                    // World-space noise at the material's detail scale (m2.w),
                    // with NO per-slot phase offset — the offset guaranteed a
                    // visible texture jump at every retire/promote handoff and
                    // across island boundaries.
                    const nPos = p2.div(max(m2.w, 0.3)).toVar();
                    const n01 = this.fbm(nPos).mul(0.5).add(0.5).toVar();
                    const sLum0 = dot(a.xyz, vec3(0.2126, 0.7152, 0.0722)).toVar();
                    m.assign(this.detailModulate(n01, sLum0));
                  });
                  const st = a.xyz.mul(m).mul(m2.y).toVar();
                  sigT.addAssign(st);
                  sigS.addAssign(st.mul(b.xyz));
                  gW.addAssign(b.w.mul(2.0).sub(1.0).mul(dot(st.mul(b.xyz), vec3(0.2126, 0.7152, 0.0722))));
                  const shTex = texture3D(atlas.texShadow, uvw0, int(0));
                  const sh = min(shTex.x.add(shTex.y.div(255.0)), 1.0); // 16-bit sqrt(T)
                  sunTrans.mulAssign(sh.mul(sh));
                });
              });
            });
          }

          // --- far-field volume packets (analytic anisotropic Gaussians) ---
          if (this.buildLevel < 1) Loop({ start: int(0), end: tileCnt, type: 'int', condition: '<' }, ({ i: j }: any) => {
            const base = int(this.tileNode.element(tileBase.add(j).add(int(1)))).mul(int(PKT_STRIDE));
            const r0 = this.packets.element(base).toVar();
            const r1 = this.packets.element(base.add(int(1))).toVar();
            const rel = p.sub(r0.xyz).div(max(r1.xyz, vec3(1e-3))).toVar();
            const q = dot(rel, rel).toVar();
            If(q.lessThan(10.0), () => {
              const r2 = this.packets.element(base.add(int(2))).toVar();
              const r3 = this.packets.element(base.add(int(3))).toVar();
              const r4 = this.packets.element(base.add(int(4))).toVar();
              const gaus = exp(q.mul(-0.5)).mul(r0.w).toVar();
              const m = float(1.0).toVar();
              If(this.detailStrength.greaterThan(0.01), () => {
                // Same world-space noise field as islands (no per-packet seed):
                // at spawn (age 0) this equals the island path's advected
                // position, so the texture is continuous through a handoff and
                // between neighbouring packets, then advects with the packet.
                const pd = p.sub(r4.xyz.mul(r3.w)).div(max(r2.w, 0.3)).toVar();
                const n01 = this.fbm(pd).mul(0.5).add(0.5);
                const sigLum = gaus.mul(dot(r2.xyz, vec3(0.2126, 0.7152, 0.0722)));
                m.assign(this.detailModulate(n01, sigLum));
              });
              const st = r2.xyz.mul(gaus).mul(m).toVar();
              sigT.addAssign(st);
              sigS.addAssign(st.mul(r3.xyz));
              gW.addAssign(r1.w.mul(dot(st.mul(r3.xyz), vec3(0.2126, 0.7152, 0.0722))));
            });

          // Packet sun shadows from the global heavy list: a caster can sit in
          // another tile entirely (sun rays don't follow screen tiles), and
          // the heaviest few packets dominate the occlusion anyway.
          if (this.buildLevel < 1) {
            for (let jj = 0; jj < MAX_HEAVY; jj++) {
              If(int(jj).lessThan(int(this.heavyCount)), () => {
                const hb = int(this.heavyIdx.element(int(jj))).mul(int(PKT_STRIDE));
                const od = this.packetRayOD(hb, p, this.sunDir);
                sunTrans.mulAssign(exp(od.negate().mul(this.shadowDensity.mul(2.3))));
              });
            }
          }
          });

          dbgAcc.addAssign(dot(sigT, vec3(1.0)).mul(ds));
          const sLum = max(dot(sigT, vec3(0.2126, 0.7152, 0.0722)), 1e-5).toVar();
          If(sLum.greaterThan(2e-4), () => {
            const scLum = max(dot(sigS, vec3(0.2126, 0.7152, 0.0722)), 1e-5);
            const g = clamp(gW.div(scLum), -0.9, 0.9).toVar();

            // Dual-lobe HG + 3 multiple-scattering octaves (Frostbite-style).
            // The 8-bit shadow cache can quantize deep-core transmittance to
            // exactly 0, which would kill every octave — floor it first.
            const sunT = max(sunTrans, 0.004).toVar();
            // Powder term (sun only): thin wisps back-scatter less than Beer
            // alone predicts, which keeps edges translucent instead of chalky.
            // Dense cores saturate to 1 so interior lighting is untouched.
            const powder = mix(exp(sLum.mul(-2.4)).oneMinus(), float(1.0), 0.35).toVar();
            const sun = vec3(0.0).toVar();
            const octA = [1.0, 0.55, 0.3];
            const octB = [1.0, 0.62, 0.38];
            const octC = [1.0, 0.5, 0.25];
            for (let o = 0; o < 3; o++) {
              const ph = this.hg(cosT, g.mul(octB[o])).mul(0.75).add(this.hg(cosT, float(-0.22)).mul(0.25));
              sun.addAssign(
                this.sunColor.mul(this.sunIntensity)
                  .mul(ph)
                  .mul(pow(sunT, float(octC[o])))
                  .mul(octA[o]),
              );
            }
            sun.mulAssign(powder);
            // Height-graded ambient: near the ground the cloud is lit mostly by
            // warm ground bounce; higher up the cool sky dome dominates.
            const ambOcc = mix(0.55, 1.0, sunT).toVar();
            const hFac = clamp(p.y.mul(0.09), 0.0, 1.0).toVar();
            const ambient = this.skyColor.mul(this.skyIntensity).mul(0.108).mul(ambOcc).mul(mix(0.6, 1.0, hFac))
              .add(this.groundBounce.mul(0.054).mul(ambOcc).mul(mix(1.45, 0.35, hFac)));

            const S = sigS.mul(sun.add(ambient)).toVar();
            // Very-low-frequency warm/cool hue drift so large plumes don't read
            // as one flat color (gated with detail: off on software adapters).
            If(this.detailStrength.greaterThan(0.01), () => {
              const tn = this.valueNoise(p.mul(0.05)).mul(0.5).add(0.5);
              S.mulAssign(mix(vec3(1.05, 1.0, 0.94), vec3(0.94, 0.985, 1.06), tn));
            });
            const Tstep = exp(sLum.negate().mul(ds)).toVar();
            const w = T.mul(Tstep.oneMinus()).toVar();
            radiance.addAssign(S.div(sLum).mul(w));
            tRepW.addAssign(w);
            tRepSum.addAssign(w.mul(t));
            T.mulAssign(Tstep);
            If(T.lessThan(0.004), () => {
              Break();
            });
          });
        });

        const cur = vec4(radiance, T).toVar();
        If(this.debugMode.equal(5), () => {
          cur.assign(vec4(vec3(clamp(dbgAcc.mul(0.1), 0.0, 1.0)), 1.0));
        });
        If(this.debugMode.equal(7), () => {
          cur.assign(vec4(
            clamp(dbgMaxLoad.mul(0.5), 0.0, 1.0),
            clamp(dbgInside.div(24.0), 0.0, 1.0),
            0.0,
            1.0,
          ));
        });

        if (temporal) {
          // Reproject via the representative scatter distance and blend history.
          const tRep = tRepSum.div(max(tRepW, 1e-5)).toVar();
          If(tRepW.greaterThan(1e-4), () => {
            const wp = this.camPos.add(rayDir.mul(tRep));
            const clip = this.prevViewProj.mul(vec4(wp, 1.0)).toVar();
            const pndc = clip.xyz.div(max(clip.w, 1e-5)).toVar();
            const puv = vec2(pndc.x.mul(0.5).add(0.5), float(0.5).sub(pndc.y.mul(0.5))).toVar();
            const validUv = puv.x.greaterThan(0.001).and(puv.x.lessThan(0.999))
              .and(puv.y.greaterThan(0.001)).and(puv.y.lessThan(0.999)).and(clip.w.greaterThan(0.0));
            If(validUv, () => {
              const hist = this.historyTexNode.sample(puv);
              const conf = this.historyBlend.mul(clamp(float(1.0).sub(this.camDelta.mul(2.0)), 0.3, 1.0));
              cur.assign(mix(cur, hist, conf));
            });
          });
        }

        outCol.assign(cur);
      });

      // Debug: opaque-distance visualization for convention checks.
      If(this.debugMode.equal(1), () => {
        const dd = clamp(opaqueDist.div(60.0), 0.0, 1.0);
        outCol.assign(vec4(dd, dd, dd, 1.0));
      });
      // Debug: GPU-side meta dump for slot0/slot1 (constant colors).
      If(this.debugMode.equal(8), () => {
        const a0 = this.islandMeta.element(int(0));
        const a1 = this.islandMeta.element(int(3));
        If(uvN.x.lessThan(0.5), () => {
          outCol.assign(vec4(a0.x.mul(-0.05), a0.z.mul(-0.05), a0.w.mul(0.05), 1.0));
        }).Else(() => {
          outCol.assign(vec4(a1.x.mul(-0.05), a1.z.mul(-0.05), a1.w.mul(0.05), 1.0));
        });
      });
      // Debug: raw quad uv (r=u, g=v) — pins the v orientation of the
      // fullscreen quad against the rasteriser, which the ray generation and
      // the depth reconstruction both depend on.
      If(this.debugMode.equal(9), () => {
        outCol.assign(vec4(uvN.x, uvN.y, 0.0, 1.0));
      });
      // Debug: raw atlas mid-slice (all slots side by side).
      If(this.debugMode.equal(6), () => {
        const a6 = texture3D(atlas.texA, vec3(uvN.x, uvN.y, 0.5), int(0));
        outCol.assign(vec4(clamp(a6.xyz.mul(0.05), vec3(0.0), vec3(1.0)).add(vec3(a6.w.mul(0.2), 0.0, 0.0)), 1.0));
      });
      // Debug: march interval diagnostics (r=segments/5, g=tEnter/100, b=span/30).
      If(this.debugMode.equal(4), () => {
        outCol.assign(vec4(
          float(segCount).div(5.0),
          clamp(tEnter.div(100.0), 0.0, 1.0),
          clamp(tExit.sub(tEnter).div(30.0), 0.0, 1.0),
          1.0,
        ));
      });

      return outCol;
    })();
  }

  private buildComposite(): any {
    const atlas = this.atlas;
    const atlasDims = vec3(atlas.dimX, atlas.dimY, atlas.dimZ);
    const N = float(atlas.slotRes);
    return Fn(() => {
      const uvN = uv().toVar();
      const scene = this.sceneTexNode.sample(uvN).toVar();
      const { world } = this.reconstruct(uvN);

      // Depth-aware upsample of the half-res volume: plain bilinear bleeds the
      // volume across opaque silhouettes (blocky halos on building edges).
      // Weight the four surrounding half-res texels by how close their opaque
      // distance is to this pixel's — neighbours across a depth edge drop out.
      const dCenter = length(world.sub(this.camPos)).toVar();
      const halfTexel = vec2(1.0).div(this.halfSize).toVar();
      const volAcc = vec4(0.0).toVar();
      const wAcc = float(0.0).toVar();
      const offs = [
        [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5],
      ];
      for (const [ox, oy] of offs) {
        const uvI = clamp(uvN.add(halfTexel.mul(vec2(ox, oy))), vec2(0.001), vec2(0.999)).toVar();
        const { world: worldI } = this.reconstruct(uvI);
        const dI = length(worldI.sub(this.camPos));
        const w = float(1.0).div(dI.sub(dCenter).abs().div(max(dCenter, 1.0)).mul(24.0).add(0.05)).toVar();
        volAcc.addAssign(this.volTexNode.sample(uvI).mul(w));
        wAcc.addAssign(w);
      }
      const vol = volAcc.div(max(wAcc, 1e-4)).toVar();

      // Dust shadows cast onto the opaque world (sun transmittance caches + packets).
      const shadowF = float(1).toVar();
      for (let s = 0; s < (this.buildLevel < 2 ? MAX_ISLANDS : 0); s++) {
        const m0 = this.islandMeta.element(int(s * ISLE_STRIDE));
        const m1 = this.islandMeta.element(int(s * ISLE_STRIDE + 1));
        If(m1.w.greaterThan(0.5), () => {
          const local = world.sub(m0.xyz).div(m0.w).toVar();
          const inside = local.x.greaterThan(-0.02).and(local.y.greaterThan(-0.02)).and(local.z.greaterThan(-0.02))
            .and(local.x.lessThan(1.02)).and(local.y.lessThan(1.02)).and(local.z.lessThan(1.02));
          If(inside, () => {
            const uvw = m1.xyz.add(clamp(local, vec3(0.002), vec3(0.998)).mul(N)).div(atlasDims);
            const shTex = texture3D(atlas.texShadow, uvw, int(0));
            const sh = min(shTex.x.add(shTex.y.div(255.0)), 1.0); // 16-bit sqrt(T)
            shadowF.mulAssign(sh.mul(sh));
          });
        });
      }
      // Ground shadows from the global heavy-packet list (sun rays don't
      // follow screen tiles, so the tile list can't be used for occlusion).
      if (this.buildLevel < 1) {
        for (let jj = 0; jj < MAX_HEAVY; jj++) {
          If(int(jj).lessThan(int(this.heavyCount)), () => {
            const hb = int(this.heavyIdx.element(int(jj))).mul(int(PKT_STRIDE));
            const od = this.packetRayOD(hb, world, this.sunDir);
            shadowF.mulAssign(exp(od.negate().mul(0.7)));
          });
        }
      }
      const shaded = scene.xyz.mul(mix(1.0, shadowF, this.dustShadowStrength)).toVar();

      const hdr = shaded.mul(vol.w).add(vol.xyz).toVar();

      // ACES-ish filmic tonemap + sRGB.
      const x = hdr.mul(this.exposure).toVar();
      const mapped = clamp(
        x.mul(x.mul(2.51).add(0.03)).div(x.mul(x.mul(2.43).add(0.59)).add(0.14)),
        vec3(0.0),
        vec3(1.0),
      ).toVar();
      const srgb = pow(mapped, vec3(1.0 / 2.2)).toVar();

      const outc = vec4(srgb, 1.0).toVar();
      If(this.debugMode.greaterThan(0.5), () => {
        outc.assign(vec4(vol.xyz, 1.0));
      });
      return outc;
    })();
  }

  /** Render the volumetric pass + composite for this frame (after sim compute). */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const r = this.renderer;
    const cur = this.frame % 2;
    const prev = 1 - cur;

    // Camera uniforms
    const cp = camera.getWorldPosition(new THREE.Vector3());
    const prevVP = (this.prevViewProj.value as THREE.Matrix4);
    const camDelta = (this.camPos.value as THREE.Vector3).distanceTo(cp);
    (this.camDelta as any).value = Math.min(camDelta * 4, 1);
    (this.camPos.value as THREE.Vector3).copy(cp);
    (this.camProjInv.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (this.camWorld.value as THREE.Matrix4).copy(camera.matrixWorld);

    // 1) opaque scene into HDR target with depth
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);

    // 2) half-res raymarch into current history target (reads previous history)
    (this.historyTexNode as any).value = this.histRT[prev].texture;
    this.quad.material = this.raymarchMat;
    r.setRenderTarget(this.histRT[cur]);
    this.quad.render(r);

    // 3) composite to screen (or to a readable target in headless CI)
    (this.volTexNode as any).value = this.histRT[cur].texture;
    this.quad.material = this.compositeMat;
    r.setRenderTarget(this.presentMode === 'readback' ? this.outRT : null);
    this.quad.render(r);
    r.setRenderTarget(null);

    // Save this frame's view-projection for next-frame reprojection.
    prevVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    (this.frameIdx as any).value = this.frame;
    this.frame++;
  }

  dispose(): void {
    this.sceneRT.dispose();
    this.histRT[0].dispose();
    this.histRT[1].dispose();
  }
}

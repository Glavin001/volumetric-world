import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import "./style.css";
import { VolumePacketSimulation } from "./simulation";
import type { DynamicBodySample } from "./types";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="ui">
    <div class="brand"><b>V/</b> VOLUMETRIC WORLD<small>PARTICIPATING MEDIA ENGINE</small></div>
    <div class="status"><i></i> SIMULATION ONLINE</div>
    <section class="title"><div class="eyebrow">COLD AEROSOL / FIELD 01</div><h1>Air has<br>memory.</h1><div class="subtitle">World-space dust responds to pressure, momentum and moving bodies—even beyond the camera.</div></section>
    <aside class="controls"><div class="row"><span>ACTIVE PACKETS</span><span class="metric" id="packets">000</span></div><div class="row"><span>SIMULATION RATE</span><span class="metric">20 HZ</span></div><div class="row"><span>FIELD MASS</span><span class="metric" id="mass">0 KG</span></div><div class="bar"><span></span></div><button id="collapse">TRIGGER COLLAPSE</button></aside>
    <div class="hint">DRAG TO ORBIT · SCROLL TO DOLLY</div>
  </div>`;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080a0a);
scene.fog = new THREE.FogExp2(0x151918, 0.018);
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 180);
camera.position.set(24, 13, 28);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.86;
document.querySelector("#app")!.prepend(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 4, 0); controls.enableDamping = true; controls.maxDistance = 65; controls.minDistance = 10;

scene.add(new THREE.HemisphereLight(0xd3e0df, 0x30251e, 1.6));
const sun = new THREE.DirectionalLight(0xffd1a4, 5.2); sun.position.set(-12, 22, 12); scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshStandardMaterial({ color: 0x1b201e, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; scene.add(ground);

const buildingMaterial = new THREE.MeshStandardMaterial({ color: 0x313432, roughness: .94, metalness: .05 });
for (const [x, y, z, sx, sy, sz] of [[-8, 4, -4, 7, 8, 7], [8, 6, -8, 9, 12, 6], [14, 3, 4, 5, 6, 8]] as number[][]) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), buildingMaterial); mesh.position.set(x, y, z); scene.add(mesh);
}
const rubbleMaterial = new THREE.MeshStandardMaterial({ color: 0x49423b, roughness: 1 });
for (let i = 0; i < 26; i++) {
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(.25 + Math.random() * .7, 0), rubbleMaterial);
  rock.scale.y = .35 + Math.random() * .6; rock.position.set(-4 + Math.random() * 10, .2, -1 + Math.random() * 8); rock.rotation.set(Math.random(), Math.random(), Math.random()); scene.add(rock);
}

const maxPackets = 256;
const geometry = new THREE.SphereGeometry(1, 18, 12);
const material = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.NormalBlending,
  uniforms: { time: { value: 0 }, sunDirection: { value: sun.position.clone().normalize() } },
  vertexShader: `varying vec3 vLocal; varying vec3 vWorld; void main(){ vLocal=position; vec4 w=instanceMatrix*vec4(position,1.); vWorld=w.xyz; gl_Position=projectionMatrix*modelViewMatrix*w; }`,
  fragmentShader: `uniform float time; uniform vec3 sunDirection; varying vec3 vLocal; varying vec3 vWorld;
    float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
    float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1)),f.x),f.y),f.z);}
    void main(){float d=length(vLocal); float edge=smoothstep(1.,.13,d); float n=noise(vWorld*.7+vec3(time*.035,0.,time*.02))*noise(vWorld*1.9-time*.015); float density=edge*smoothstep(.12,.76,n+.24)*(1.-d*.35); if(density<.015)discard; vec3 viewDir=normalize(cameraPosition-vWorld); float phase=pow(max(dot(viewDir,sunDirection),0.),5.)*.8+.22; vec3 dust=mix(vec3(.19,.18,.16),vec3(.78,.58,.40),phase); gl_FragColor=vec4(dust*density,density*.19); }`
});
const cloud = new THREE.InstancedMesh(geometry, material, maxPackets); cloud.frustumCulled = false; scene.add(cloud);
const hidden = new THREE.Object3D(); hidden.position.set(1000, 1000, 1000); for (let i=0;i<maxPackets;i++) cloud.setMatrixAt(i, hidden.matrix);

const simulation = new VolumePacketSimulation();
let eventId = 0;
function collapse(): void {
  simulation.emit({ eventId: ++eventId, simulationTimeS: performance.now()/1000, centerM: [-1.5, .1, 1.5], radiusM: 5.5, fineMassKg: 950, impulseMps: [1.4, 0, .2], seed: eventId * 19 }, 52);
}
document.querySelector("#collapse")!.addEventListener("click", collapse);
collapse();

const clock = new THREE.Clock(); const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion(); const scale = new THREE.Vector3(); const position = new THREE.Vector3();
function animate(): void {
  const dt = Math.min(clock.getDelta(), .05), t = clock.elapsedTime;
  const car: DynamicBodySample = { bodyId: 1, positionM: [Math.sin(t*.22)*14, 1, -2], previousPositionM: [Math.sin((t-dt)*.22)*14, 1, -2], velocityMps: [Math.cos(t*.22)*3.08,0,0], radiusM: 2.2, wakeScale: 1.6 };
  simulation.update(dt, [.75, 0, .12], [car]);
  const visible = Math.min(simulation.packets.length, maxPackets);
  for (let i=0;i<maxPackets;i++) {
    if (i < visible) { const p=simulation.packets[i]; position.fromArray(p.position); scale.fromArray(p.radii); matrix.compose(position,quaternion,scale); }
    else matrix.compose(hidden.position,quaternion,new THREE.Vector3(.001,.001,.001));
    cloud.setMatrixAt(i,matrix);
  }
  cloud.count=maxPackets; cloud.instanceMatrix.needsUpdate=true; material.uniforms.time.value=t;
  document.querySelector("#packets")!.textContent=String(simulation.packets.length).padStart(3,"0"); document.querySelector("#mass")!.textContent=`${Math.round(simulation.totalMassKg).toLocaleString()} KG`;
  controls.update(); renderer.render(scene,camera); requestAnimationFrame(animate);
}
animate();

addEventListener("resize",()=>{ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight); });

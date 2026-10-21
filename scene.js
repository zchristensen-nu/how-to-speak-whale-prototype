// three.js scene for the whale scroll (contract v3). See CONTRACT.md for the shot list and the sceneApi shape.
// One renderer, one scene. Shots are pure functions of (t, time) that pose objects and the camera; nothing
// allocates per frame (scratch vectors below). Assets (whale.glb, props.glb) replace primitives when they load;
// water.js (the ocean: sky, surface from above and below, light shafts) is imported dynamically and replaces a
// minimal flat fallback plane when it lands.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// Data-viz / scene colours from the contract (style.css declares the same values for 2D).
const COL = { whaleA: 0xffb547, whaleB: 0x5ad1e6, whaleC: 0xf2728c, echo: 0xcfd8dc };
const SURFACE_Y = -0.55; // whale centre when its back breaks the surface
const WHALE_LEN = 11;
const TAG_SCALE = 1.6; // the ~0.3 m CETI tag, enlarged a little so it reads at story distances
const DRONE_SCALE = 1.8;
const IOR = 1.333;

// AgX (three r160's AgXToneMapping, ported) so colour targets can be given as DISPLAY values: displayToLinear()
// finds the linear scene colour that AgX renders as a given sRGB hex.
const M3 = (c0, c1, c2) => new THREE.Matrix3().set(c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]); // GLSL column order
const AGX_TO2020 = M3([0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]);
const AGX_FROM2020 = AGX_TO2020.clone().invert();
const AGX_IN = M3([0.856627153315983, 0.137318972929847, 0.11189821299995], [0.0951212405381588, 0.761241990602591, 0.0767994186031903], [0.0482516061458583, 0.101439036467562, 0.811302368396859]);
const AGX_OUT = M3([1.1271005818144368, -0.1413297634984383, -0.14132976349843826], [-0.11060664309660323, 1.157823702216272, -0.11060664309660294], [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]);
function agx(v, out) {
  out.copy(v).applyMatrix3(AGX_TO2020).applyMatrix3(AGX_IN);
  const f = (x) => {
    x = (Math.log2(Math.max(x, 1e-10)) + 12.47393) / (4.026069 + 12.47393);
    x = Math.min(1, Math.max(0, x));
    const x2 = x * x, x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  };
  out.set(f(out.x), f(out.y), f(out.z)).applyMatrix3(AGX_OUT);
  out.set(Math.pow(Math.max(0, out.x), 2.2), Math.pow(Math.max(0, out.y), 2.2), Math.pow(Math.max(0, out.z), 2.2));
  return out.applyMatrix3(AGX_FROM2020);
}
function displayToLinear(hex) {
  const tgt = new THREE.Color(hex); // linear value of the display colour
  const T = new THREE.Vector3(tgt.r, tgt.g, tgt.b), x = T.clone(), y = new THREE.Vector3();
  for (let i = 0; i < 60; i++) {
    agx(x, y);
    x.set(x.x * Math.pow(T.x / Math.max(y.x, 1e-7), 0.7), x.y * Math.pow(T.y / Math.max(y.y, 1e-7), 0.7), x.z * Math.pow(T.z / Math.max(y.z, 1e-7), 0.7));
  }
  return new THREE.Color(x.x, x.y, x.z);
}

// Underwater colour by depth (metres), v4 grade: a darker, moodier navy (display targets, AgX-inverted).
const DEPTH_STOPS = [
  [0, displayToLinear(0x0c4466)],
  [15, displayToLinear(0x062d4a)],
  [40, displayToLinear(0x04213a)],
  [150, displayToLinear(0x021120)],
  [600, displayToLinear(0x010306)],
];
const UW_UP = displayToLinear(0x1a5a7e), UW_DOWN = displayToLinear(0x08344f);
function depthColor(d, out) {
  for (let i = 1; i < DEPTH_STOPS.length; i++) {
    const [d1, c1] = DEPTH_STOPS[i];
    const [d0, c0] = DEPTH_STOPS[i - 1];
    if (d <= d1) return out.lerpColors(c0, c1, (d - d0) / (d1 - d0));
  }
  return out.copy(DEPTH_STOPS[DEPTH_STOPS.length - 1][1]);
}

// Fallback swell (only used until water.js provides surfaceHeightAt).
const fallbackWave = (x, z, t) =>
  0.35 * Math.sin(x * 0.045 + t * 0.7) + 0.22 * Math.sin(z * 0.06 + t * 0.9 + x * 0.015) + 0.1 * Math.sin((x + z) * 0.12 + t * 1.6);

// Caustics: two layers of animated, domain-warped Voronoi edges (F2 - F1). Thin bright lines that meet in
// brighter nodes, the network you see dancing on a whale's back in clear water. `w` = line width (sharp near
// the surface, broader and dimmer with depth). Each layer is 9 cell lookups; three channels are sampled with
// a tiny offset for the faint chromatic fringe real caustics have.
const CAUSTIC_GLSL = `
vec2 cHash(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
float cEdge(vec2 x, float t){
  vec2 n = floor(x), f = fract(x);
  float f1 = 8.0, f2 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = cHash(n + g);
    o = 0.5 + 0.42 * sin(t + 6.2831 * o);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
  }
  return sqrt(f2) - sqrt(f1);
}
float cLayer(vec2 p, float t, float w){
  p += 0.45 * vec2(sin(p.y * 1.3 + t * 0.9), cos(p.x * 1.1 - t * 0.7)) + 0.18 * vec2(sin(p.y * 3.1 - t * 1.3), cos(p.x * 2.7 + t));
  float e = cEdge(p, t);
  return 1.0 - smoothstep(0.0, w, e);
}
float causticN(vec2 p, float t, float w){
  float a = cLayer(p, t, w);
  vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p * 0.73 + vec2(3.1, 7.7);
  float b = cLayer(q, t * 1.21 + 2.0, w * 0.9);
  return max(a, b) * 0.7 + a * b * 1.8;
}
vec3 causticRGB(vec2 p, float t, float w){
  vec2 o = vec2(0.005, 0.003);
  return vec3(causticN(p - o, t, w), causticN(p, t, w), causticN(p + o, t, w));
}`;

const SKY_GLSL = `
uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 low; uniform vec3 sunDir; uniform vec3 sunCol;
vec3 skyCol(vec3 d){
  float h = d.y;
  vec3 c = mix(horizon, mid, smoothstep(0.0, 0.25, h));
  c = mix(c, top, smoothstep(0.25, 0.9, h));
  c = mix(c, low, smoothstep(0.0, -0.06, h));
  float s = max(dot(d, sunDir), 0.0);
  c += sunCol * (pow(s, 8.0) * 0.35 + pow(s, 600.0) * 4.0);
  return c;
}`;

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const shaftTexture = () => canvasTexture(64, 256, (g, w, h) => {
  const hz = g.createLinearGradient(0, 0, w, 0);
  hz.addColorStop(0, 'rgba(255,255,255,0)');
  hz.addColorStop(0.5, 'rgba(255,255,255,1)');
  hz.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hz; g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'destination-in';
  const vt = g.createLinearGradient(0, 0, 0, h);
  vt.addColorStop(0, 'rgba(255,255,255,0)');      // feathered at the surface end too (no hard flat tops)
  vt.addColorStop(0.14, 'rgba(255,255,255,0.9)');
  vt.addColorStop(0.3, 'rgba(255,255,255,0.7)');
  vt.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = vt; g.fillRect(0, 0, w, h);
});
const glowTexture = () => canvasTexture(64, 64, (g, w, h) => {
  const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.3, 'rgba(255,255,255,0.35)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, w, h);
});

// Caustics on any MeshStandardMaterial (whales), projected along the refracted sun ray onto the surface so the
// pattern slides across the body as it moves. Fades with depth, only on faces that see the light.
const causticU = {
  uCTime: { value: 0 }, uCAmt: { value: 0 }, uCRefr: { value: V(0, -1, 0) }, uCCol: { value: new THREE.Color(0.75, 0.92, 1.0) },
};
function patchCaustics(mat) {
  if (!mat || mat.userData.caustic) return;
  mat.userData.caustic = true;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, causticU);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCW; varying vec3 vCN;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vCW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vCN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uCTime; uniform float uCAmt; uniform vec3 uCRefr; uniform vec3 uCCol; varying vec3 vCW; varying vec3 vCN;\n${CAUSTIC_GLSL}`)
      .replace('#include <opaque_fragment>', `
  {
    float dep = max(0.0, -vCW.y);
    float lit = max(dot(normalize(vCN), -uCRefr), 0.0);
    float cK = uCAmt * exp(-dep / 13.0) * smoothstep(0.05, -0.25, vCW.y) * smoothstep(0.0, 0.35, lit);
    if (cK > 0.002) {
      vec2 sp = vCW.xz - uCRefr.xz * (vCW.y / uCRefr.y);       // where this point's light entered the sea
      float w = mix(0.07, 0.32, clamp(dep / 30.0, 0.0, 1.0));   // sharp near the surface, soft deeper
      vec3 c = causticRGB(sp * 1.3, uCTime, w);
      // Caustics redistribute the sun: troughs a little darker, the bright network several times brighter.
      outgoingLight = outgoingLight * (1.0 - 0.3 * min(cK, 1.0)) + diffuseColor.rgb * uCCol * c * cK * (0.5 + lit);
    }
  }
#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'whale-caustic-v3';
  mat.needsUpdate = true;
}

function makePlaceholderWhale(mat) {
  const g = new THREE.Group();
  const add = (geo, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
  add(new THREE.BoxGeometry(3.0, 3.2, 3.9), 0, 0.15, 3.4);
  add(new THREE.BoxGeometry(0.7, 0.4, 3.0), 0, -1.55, 3.3);
  add(new THREE.CylinderGeometry(1.55, 0.55, 5.6, 8).rotateX(Math.PI / 2), 0, 0, -1.2);
  add(new THREE.BoxGeometry(0.7, 0.5, 1.4), 0, 1.35, -1.6);
  const finL = add(new THREE.BoxGeometry(1.2, 0.12, 0.6), 1.7, -0.8, 1.6); finL.rotation.z = -0.4;
  const finR = add(new THREE.BoxGeometry(1.2, 0.12, 0.6), -1.7, -0.8, 1.6); finR.rotation.z = 0.4;
  const tail = new THREE.Group();
  tail.position.set(0, 0, -3.9);
  g.add(tail);
  add(new THREE.CylinderGeometry(0.55, 0.25, 1.7, 6).rotateX(Math.PI / 2), 0, 0, -0.8, tail);
  const fl = add(new THREE.BoxGeometry(2.2, 0.14, 1.1), 1.05, 0, -1.9, tail); fl.rotation.y = 0.35;
  const fr = add(new THREE.BoxGeometry(2.2, 0.14, 1.1), -1.05, 0, -1.9, tail); fr.rotation.y = -0.35;
  return { group: g, tail };
}

// Echolocation "torch": a soft-edged additive cone (falloff across the silhouette and along the length,
// click pulses travelling outward). Two nested cones per whale: a bright core and a wide faint haze.
function makeBeamCone(color, H, R, strength, soft) {
  const geo = new THREE.CylinderGeometry(R, 0.12, H, 36, 8, true);
  geo.translate(0, -H / 2, 0);
  geo.rotateX(-Math.PI / 2); // narrow end at origin, extends along +Z
  const mat = new THREE.ShaderMaterial({
    uniforms: { col: { value: new THREE.Color(color) }, op: { value: 0 }, H: { value: H }, uTime: { value: 0 }, uOff: { value: 0 }, k: { value: strength }, soft: { value: soft } },
    vertexShader: `
      uniform float H; varying float vLr; varying vec3 vN; varying vec3 vV;
      void main(){
        vLr = position.z / H;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 col; uniform float op; uniform float uTime; uniform float uOff; uniform float k; uniform float soft;
      varying float vLr; varying vec3 vN; varying vec3 vV;
      void main(){
        // vL can dip a hair below 0 at the apex: pow() of a negative is NaN, and on WebKit/Metal one NaN pixel
        // smeared by the bloom blur blacks out the whole frame. Clamp before any pow().
        float vL = clamp(vLr, 0.0, 1.0);
        // |N.V| peaks along the cone's projected axis: a high power gives a hard bright core line, a low power
        // the soft falloff to the cone's edge.
        float edge = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
        float body = pow(edge, soft) * 1.8 + pow(edge, 2.0) * 0.22;
        float along = mix(1.0, 0.12, pow(vL, 0.8)) * smoothstep(0.0, 0.035, vL) * (1.0 - smoothstep(0.85, 1.0, vL)); // starts at the melon: ~1.7 m soft ramp
        float ph = fract(uTime * 2.0 + uOff);                 // one click every 0.5 s, shared by all three whales
        float pd = (vL - ph) * 40.0; float pulse = exp(-pd * pd) * (1.0 - 0.6 * vL); // (x*x, not pow: pow of a negative base is NaN) // a thin travelling click front
        float a = op * k * body * mix(0.35, 1.0, smoothstep(0.0, 0.25, vL)) * (along * 0.75 + 1.2 * pulse * smoothstep(0.0, 0.035, vL));
        gl_FragColor = vec4(col * a, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 6;
  mesh.frustumCulled = false;
  return { mesh, mat };
}

// The blow: one bushy puff of fine mist thrown forward and to the whale's left at ~45°, from the blowhole at the
// front-left of the head. GPU particles: every particle's path is a closed-form function of the blow's age
// (drag-decelerated launch, slow drift, droplets falling), so the CPU only sets a handful of uniforms.
// Mist sprites are soft and lobed; droplets are tiny sparkles. Brightness follows forward scattering, so the
// puff glows when the sun is behind it. Below the sea surface the same trigger releases a burst of bubbles.
function makeBlow() {
  const N_MIST = 520, N_DROP = 420, N = N_MIST + N_DROP;
  const geo = new THREE.BufferGeometry();
  const seed = new Float32Array(N * 4), kind = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < 4; k++) seed[i * 4 + k] = Math.random();
    kind[i] = i < N_MIST ? 0 : 1;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geo.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
  const uniforms = {
    uOrigin: { value: V() }, uDir: { value: V(0, 1, 0) }, uSide: { value: V(1, 0, 0) }, uWind: { value: V(0.9, 0, -0.4) },
    uCam: { value: V() }, uSun: { value: V(0, 1, 0) }, uAge: { value: -1 }, uAmt: { value: 1 }, uPx: { value: 800 },
    uSunCol: { value: new THREE.Color(1.0, 0.86, 0.7) }, uAmb: { value: new THREE.Color(0.62, 0.68, 0.76) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      uniform vec3 uOrigin, uDir, uSide, uWind, uCam, uSun; uniform float uAge, uAmt, uPx;
      attribute vec4 aSeed; attribute float aKind;
      varying float vA; varying float vKind; varying float vFwd; varying float vRot; varying float vDense; varying vec3 vSunV;
      void main(){
        vSunV = (viewMatrix * vec4(uSun, 0.0)).xyz;
        bool mist = aKind < 0.5;
        float te = pow(aSeed.x, mist ? 1.3 : 1.2) * (mist ? 0.7 : 0.5);   // the exhalation lasts ~0.7 s
        float a = uAge - te;
        float life = mist ? mix(0.9, 1.9, aSeed.y) : mix(0.7, 1.4, aSeed.y);   // dissipates quickly
        vec3 p = uOrigin; float size = 0.0; vA = 0.0; vDense = 0.0;
        if (a > 0.0 && a < life) {
          float u = a / life;
          float ang = aSeed.z * 6.2831;
          vec3 up2 = normalize(cross(uDir, uSide));
          vec3 rad = cos(ang) * uSide + sin(ang) * up2;
          float spr = (mist ? 0.16 : 0.3) * sqrt(aSeed.w);
          vec3 dir = normalize(uDir + spr * rad);
          float sp = mist ? mix(6.0, 10.5, fract(aSeed.y * 7.13)) : mix(8.0, 14.0, fract(aSeed.w * 5.31));
          float k = mist ? 2.2 : 1.1;
          float sd = sp * (1.0 - exp(-k * a)) / k;            // distance travelled from the blowhole (3-5 m max)
          p += dir * sd;
          if (mist) {
            // fan out into a bushy cone, with ragged turbulent billows that grow with age
            p += rad * sd * 0.2 * fract(aSeed.w * 3.7);
            p += 0.35 * a * vec3(sin(a * 3.1 + aSeed.y * 31.0), 0.6 * sin(a * 2.3 + aSeed.z * 17.0), cos(a * 2.7 + aSeed.w * 23.0));
            p += uWind * a * (0.5 + aSeed.w);
            p.y += 0.25 * a;
          } else {
            p += uWind * a * 0.3;
            p.y -= 3.6 * a * a;
          }
          float core = exp(-sd / 1.3);                         // dense, bright near the blowhole
          size = mist ? (0.16 + 0.32 * sd + 0.3 * a) * mix(0.7, 1.3, aSeed.w) : mix(0.02, 0.045, aSeed.z);
          float fin = smoothstep(0.0, mist ? 0.08 : 0.03, a);
          float fout = mist ? pow(1.0 - u, 2.2) : 1.0 - u;
          vA = fin * fout * uAmt * smoothstep(-0.05, 0.25, p.y);
          vDense = mist ? clamp(core * 1.2 + (1.0 - u) * 0.3, 0.0, 1.0) : 1.0 - u;
        }
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float d = max(-mv.z, 0.01);
        vA *= smoothstep(0.6, 3.0, d);
        vFwd = max(dot(normalize(p - uCam), uSun), 0.0);
        float px = size * uPx / d;
        if (!mist) { vA *= clamp(px / 1.2, 0.35, 1.0); px = max(px, 1.6); }
        gl_PointSize = vA > 0.001 ? min(px, 512.0) : 0.0;
        vKind = aKind; vRot = aSeed.z * 6.2831;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uSunCol, uAmb;
      float vh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(vh(i), vh(i + vec2(1, 0)), f.x), mix(vh(i + vec2(0, 1)), vh(i + vec2(1, 1)), f.x), f.y); }
      varying float vA; varying float vKind; varying float vFwd; varying float vRot; varying float vDense; varying vec3 vSunV;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c) * 2.0;
        if (r > 1.0) discard;
        float a; vec3 col;
        float back = (pow(vFwd, 6.0) * 1.1 + pow(vFwd, 30.0) * 1.0) * (0.35 + 0.65 * vDense);  // forward (Mie-like) scattering
        if (vKind < 0.5) {
          float th = atan(c.y, c.x);
          float lob = 0.78 + 0.16 * sin(th * 5.0 + vRot * 3.0) + 0.08 * sin(th * 11.0 - vRot * 5.0);
          float rr = r / lob;
          // Clumpy interior: two octaves of value noise per sprite, so overlapping puffs build a bushy texture.
          vec2 q = c * 3.2 + vec2(vRot * 3.7, vRot * 1.9);
          float nz = 0.65 * vnoise(q) + 0.35 * vnoise(q * 2.3 + 5.1);
          a = exp(-rr * rr * 2.4) * (1.0 - smoothstep(0.82, 1.0, r)) * (0.26 + 0.5 * vDense) * smoothstep(0.08, 0.55, nz + 0.35 * vDense);
          // Treat each puff as a soft sphere: lit lobes toward the sun, blue-grey shade away from it, so the
          // blow has body against a pale sky instead of reading as flat white smoke.
          vec3 n = normalize(vec3(c.x * 2.0, -c.y * 2.0, sqrt(max(0.0, 1.0 - min(rr, 1.0)))));
          float dif = clamp(dot(n, normalize(vSunV)) * 0.6 + 0.4, 0.0, 1.0);
          float self = mix(1.0, 0.55, vDense);                // the dense young core shades itself
          float rimG = smoothstep(0.3, 0.9, r) * back * 1.8;   // backlit rim: light skimming through the puff's thin edge
          col = uAmb * mix(0.55, 1.2, dif) * self + mix(uSunCol, vec3(1.0), 0.4) * (dif * 0.4 + back + rimG) + vec3(0.35) * vDense * vDense;
        } else {
          a = smoothstep(1.0, 0.15, r) * 0.9;
          col = uAmb + uSunCol * (back * 3.5 + 0.7);   // droplets catch the sun
        }
        gl_FragColor = vec4(col, a * vA);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, fog: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 8;

  // Bubbles for an exhalation seen from below.
  const NB = 90;
  const bgeo = new THREE.BufferGeometry();
  const bs = new Float32Array(NB * 4);
  for (let i = 0; i < bs.length; i++) bs[i] = Math.random();
  bgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NB * 3), 3));
  bgeo.setAttribute('aSeed', new THREE.BufferAttribute(bs, 4));
  const bmat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      uniform vec3 uOrigin, uDir, uSide; uniform float uAge, uAmt, uPx; attribute vec4 aSeed; varying float vA;
      void main(){
        float te = aSeed.x * 0.7; float a = uAge - te; float life = mix(1.6, 3.0, aSeed.y);
        vec3 p = uOrigin; vA = 0.0; float size = 0.0;
        if (a > 0.0 && a < life) {
          float ang = aSeed.z * 6.2831;
          vec3 up2 = normalize(cross(uDir, uSide));
          vec3 off = (cos(ang) * uSide + sin(ang) * up2) * 0.6 * aSeed.w;
          p += off * (1.0 - exp(-2.0 * a)) + vec3(0.0, mix(1.2, 2.6, aSeed.w) * a, 0.0);
          p.x += 0.12 * sin(a * 9.0 + aSeed.y * 20.0); p.z += 0.12 * cos(a * 8.0 + aSeed.z * 20.0);
          size = mix(0.04, 0.22, aSeed.w * aSeed.w);
          vA = smoothstep(0.0, 0.05, a) * (1.0 - a / life) * uAmt * smoothstep(0.02, -0.2, p.y);
        }
        vec4 mv = viewMatrix * vec4(p, 1.0); float d = max(-mv.z, 0.01);
        gl_PointSize = vA > 0.001 ? clamp(size * uPx / d, 1.5, 128.0) : 0.0;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA;
      void main(){
        float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
        float rim = smoothstep(0.55, 0.92, r) * (1.0 - smoothstep(0.92, 1.0, r));
        float hi = smoothstep(0.35, 0.0, length(gl_PointCoord - vec2(0.36, 0.33)));
        float a = (rim * 0.8 + hi * 0.9 + 0.08) * vA;
        gl_FragColor = vec4(vec3(0.55, 0.68, 0.75) * (0.8 + 0.5 * hi), a * 0.6);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, fog: false,
  });
  const bubbles = new THREE.Points(bgeo, bmat);
  bubbles.frustumCulled = false;
  bubbles.renderOrder = 8;
  const group = new THREE.Group();
  group.add(points, bubbles);
  return { group, uniforms, points, bubbles };
}

export function initScene(canvas) {
  const smallScreen = () => Math.min(window.innerWidth, window.innerHeight) < 600;
  const dprCap = () => Math.min(window.devicePixelRatio || 1, smallScreen() ? 1.5 : 2);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.info.autoReset = false; // one frame = refraction + main (+ bloom) passes; reset once per update
  renderer.setPixelRatio(dprCap());
  renderer.toneMapping = THREE.AgXToneMapping; // ACES pushed the blues toward violet
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x9fb3c4, 0.00012);
  scene.background = new THREE.Color(0x01060a);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 9000);
  scene.add(camera);

  // Sun direction: water.js owns it once it loads (ocean.sunDirection); until then a low morning sun ahead of the
  // open shot's camera, so the whale and the blow are backlit.
  const sunDir = V(0.3, 0.16, -1).normalize();
  const refr = V(0, -1, 0);
  function updateRefraction() {
    // Snell: the sun ray (pointing down into the sea) bends toward the vertical.
    tR.copy(sunDir).negate();
    const cosi = -tR.y; // against the up normal
    const eta = 1 / IOR;
    const k = 1 - eta * eta * (1 - cosi * cosi);
    refr.copy(tR).multiplyScalar(eta).add(tR.set(0, 1, 0).multiplyScalar(eta * cosi - Math.sqrt(Math.max(0, k)))).normalize();
    causticU.uCRefr.value.copy(refr);
  }
  const tR = V();

  // Lights: hemisphere (sky/sea), the key along the sun (refracted below the surface), a soft fill from the
  // viewer's side so dark skin keeps its form, and a cold rim that grows with depth.
  const hemi = new THREE.HemisphereLight(0xc4d8e6, 0x0b2a38, 1.0);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffd2a8, 2.0);
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0xa8c8dc, 0.9);
  fill.position.set(120, 260, 400);
  scene.add(fill, fill.target);
  const rim = new THREE.DirectionalLight(0x8fc4ff, 0);
  scene.add(rim, rim.target);

  // Fallback sky + flat sea (until water.js lands, or if it fails).
  const skyUniforms = () => ({
    top: { value: new THREE.Color(0x1f4f8c) }, mid: { value: new THREE.Color(0x6c96c4) },
    horizon: { value: new THREE.Color(0xf1c49b) }, low: { value: new THREE.Color(0x0a2a60) },
    sunDir: { value: sunDir }, sunCol: { value: new THREE.Color(0xffd9b0) },
  });
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms(),
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `${SKY_GLSL}
      varying vec3 vDir;
      void main(){
        gl_FragColor = vec4(skyCol(normalize(vDir)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(4500, 32, 16), skyMat);
  sky.renderOrder = -10;
  scene.add(sky);

  const fbSeaU = {
    uCam: { value: V() }, uUnder: { value: 0 }, uFog: { value: new THREE.Color() }, uFogD: { value: 0.02 },
    ...skyUniforms(),
  };
  const fbSea = new THREE.Mesh(new THREE.PlaneGeometry(16000, 16000).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    uniforms: fbSeaU,
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `${SKY_GLSL}
      uniform vec3 uCam; uniform float uUnder; uniform vec3 uFog; uniform float uFogD; varying vec3 vW;
      void main(){
        vec3 toC = uCam - vW; float dist = length(toC); vec3 Vd = toC / dist; vec3 col;
        if (uUnder < 0.5) {
          float F = 0.02 + 0.98 * pow(1.0 - max(Vd.y, 0.0), 5.0);
          vec3 R = reflect(-Vd, vec3(0.0, 1.0, 0.0));
          col = mix(vec3(0.01, 0.05, 0.18), skyCol(R), F);
        } else {
          float cosT = max(-Vd.y, 0.0);
          col = mix(uFog * 1.6, vec3(0.75, 0.9, 1.0) * 1.4, smoothstep(0.62, 0.72, cosT));
          col = mix(col, uFog, 1.0 - exp(-dist * uFogD));
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide, fog: false,
  }));
  fbSea.renderOrder = 1;
  scene.add(fbSea);

  // Environment maps: the fallback sky (until the ocean provides one) and an underwater light field (a bright
  // Snell's window overhead, ultramarine around, dark below) for whales below the surface.
  let skyEnv = null, underEnv = null;
  function pmremFrom(mat) {
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), mat));
    const pmrem = new THREE.PMREMGenerator(renderer);
    const tex = pmrem.fromScene(envScene, 0.02).texture;
    pmrem.dispose();
    return tex;
  }
  try {
    const envMat = skyMat.clone();
    envMat.uniforms = skyUniforms();
    skyEnv = pmremFrom(envMat);
    const uw = new THREE.ShaderMaterial({
      uniforms: {
        uLow: { value: UW_DOWN.clone().multiplyScalar(0.4) }, uMid: { value: DEPTH_STOPS[0][1].clone() },
        uHigh: { value: UW_UP.clone() }, uWin: { value: new THREE.Color(0xd8f0ff) },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 uLow, uMid, uHigh, uWin; varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          vec3 c = mix(uMid, uLow, smoothstep(0.0, -0.7, d.y));
          c = mix(c, uHigh, smoothstep(0.1, 0.62, d.y));
          c += uWin * 2.5 * smoothstep(0.6, 0.7, d.y);
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: THREE.BackSide,
    });
    underEnv = pmremFrom(uw);
    scene.environment = skyEnv;
  } catch (err) {
    console.info('[whale-scroll] env map unavailable', err && err.message);
  }

  // Underwater volume backdrop: a camera-centred dome whose colour follows the depth, brighter toward the surface,
  // darker below. Shares the fog colour at the horizon, so distant whales dissolve into it.
  const domeU = { uFog: { value: new THREE.Color() }, uUp: { value: new THREE.Color() }, uDown: { value: new THREE.Color() } };
  const dome = new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16), new THREE.ShaderMaterial({
    uniforms: domeU,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uFog, uUp, uDown; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        vec3 c = mix(uFog, uDown, smoothstep(0.0, -0.75, d.y));
        c = mix(c, uUp, smoothstep(0.0, 0.9, d.y));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  }));
  dome.renderOrder = -9;
  scene.add(dome);

  // Fallback god rays (water.js draws its own shafts once it loads).
  const shaftTex = shaftTexture();
  const shafts = new THREE.Group();
  const shaftSeeds = [];
  for (let i = 0; i < 28; i++) {
    const mat = new THREE.MeshBasicMaterial({ map: shaftTex, color: 0xbfe0ff, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide, toneMapped: false });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    const w = 0.8 + Math.random() * 3.5, h = 60 + Math.random() * 80;
    m.scale.set(w, h, 1);
    m.position.y = -h / 2;
    shaftSeeds.push({ x: (Math.random() - 0.5) * 140, z: (Math.random() - 0.5) * 140, ph: Math.random() * 6, k: 0.5 + Math.random() * 0.5 });
    m.renderOrder = 4;
    shafts.add(m);
  }
  scene.add(shafts);

  // Marine snow: static positions, wrapped around the camera in the vertex shader (no CPU loop).
  const SNOW_N = 2200, SNOW_BOX = 70;
  const snowGeo = new THREE.BufferGeometry();
  {
    const p = new Float32Array(SNOW_N * 3), s = new Float32Array(SNOW_N);
    for (let i = 0; i < p.length; i++) p[i] = Math.random() * SNOW_BOX;
    for (let i = 0; i < SNOW_N; i++) s[i] = Math.random();
    snowGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    snowGeo.setAttribute('aSeed', new THREE.BufferAttribute(s, 1));
  }
  const snowMat = new THREE.ShaderMaterial({
    uniforms: { uCam: { value: V() }, uTime: { value: 0 }, uBox: { value: SNOW_BOX }, uOp: { value: 0.6 }, uPx: { value: 1 }, uCol: { value: new THREE.Color(0xd6eaf0) } },
    vertexShader: `
      uniform vec3 uCam; uniform float uTime; uniform float uBox; uniform float uPx; attribute float aSeed; varying float vA;
      void main(){
        vec3 p = position;
        p.y -= uTime * (0.15 + 0.2 * aSeed);
        p.x += sin(uTime * 0.12 + aSeed * 40.0) * 0.4;
        vec3 rel = mod(p - uCam, uBox) - uBox * 0.5;
        vec3 w = uCam + rel;
        vec4 mv = viewMatrix * vec4(w, 1.0);
        float d = -mv.z;
        gl_PointSize = uPx * (0.6 + aSeed * 1.4) * clamp(60.0 / max(d, 0.5), 0.6, 9.0);
        vA = smoothstep(uBox * 0.5, uBox * 0.25, length(rel)) * smoothstep(0.3, 2.0, d) * (0.4 + 0.6 * aSeed) * smoothstep(-0.2, -1.0, w.y);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uOp; uniform vec3 uCol; varying float vA;
      void main(){
        float r = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.1, r) * vA * uOp;
        gl_FragColor = vec4(uCol, a);
      }`,
    transparent: true, depthWrite: false, fog: false,
  });
  if (smallScreen()) snowGeo.setDrawRange(0, 1100); // phone tier: half the marine snow
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.frustumCulled = false;
  snow.renderOrder = 3;
  scene.add(snow);

  // Fade/dim veil attached to the camera.
  const veilMat = new THREE.MeshBasicMaterial({ color: 0x01060a, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
  // (v7: 200 m square at 0.5 m, far wider than any frustum. The old 10 m veil hung off the full-stage math camera
  //  and, with the v6 off-axis view offset, covered only part of the view: the dark rectangle in analyze.)
  const veil = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), veilMat);
  veil.frustumCulled = false;
  veil.position.z = -0.5;
  veil.renderOrder = 999;
  // v7 perf: `camera` is the math camera (projection over the whole stage: framing, project(), overlays);
  // `renderCam` has the same pose but renders only the visible frame window, into a canvas sized to that window.
  const renderCam = new THREE.PerspectiveCamera(50, 1, 0.1, 9000);
  scene.add(renderCam);
  renderCam.add(veil);

  const anchors = {};
  const managed = [];
  const glow = glowTexture();

  // Props: primitive fallbacks inside holder groups; props.glb swaps the contents.
  const propMat = (c, e = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: 0.2, emissive: c, emissiveIntensity: e, flatShading: true });
  const sprite = (color, s, op = 1) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    sp.scale.setScalar(s);
    return sp;
  };
  function holder(name) {
    const h = new THREE.Group();
    h.name = name;
    h.body = new THREE.Group();
    h.add(h.body);
    scene.add(h);
    managed.push(h);
    return h;
  }

  const drone = holder('drone');
  drone.rotors = [];
  {
    const white = propMat(0xe8eef2, 0.05), dark = propMat(0x22303a);
    drone.body.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.5), white));
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.05, 0.07), dark);
      arm.position.set(Math.cos(a) * 0.35, 0, Math.sin(a) * 0.35);
      arm.rotation.y = -a;
      drone.body.add(arm);
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.02, 12), new THREE.MeshBasicMaterial({ color: 0xcfd8dc, transparent: true, opacity: 0.35 }));
      rotor.position.set(Math.cos(a) * 0.68, 0.07, Math.sin(a) * 0.68);
      drone.body.add(rotor);
      drone.rotors.push(rotor);
    }
    const led = sprite(0xff6040, 0.18);
    led.position.y = -0.1;
    drone.add(led);
    drone.scale.setScalar(DRONE_SCALE); // ~1 m quadcopter, scaled up a little to read at story distances
  }
  anchors.drone = drone;
  let droneUnder = 0.206; // distance from the drone origin to the bottom of its gimbal (props.glb DroneMesh min y)

  // Tag: origin = the suction cups' contact plane, body along +Y, cups facing -Y, long axis along +Z.
  const tag = holder('tag');
  {
    const orange = propMat(0xff7a1a, 0.35);
    tag.body.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.12, 10), orange).translateY(0.09));
    tag.body.add(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.03, 14), propMat(0x22303a)).translateY(0.015));
    tag.scale.setScalar(TAG_SCALE);
  }
  anchors.tag = tag;
  // whaleB carries a second biologger (the conclusion's "two whales ... with biologgers attached"); it wears it
  // from its first appearance (listen) on, so the tag never pops on.
  const tagB = holder('tagB');
  tag.body.children.forEach((m) => tagB.body.add(m.clone()));
  tagB.scale.setScalar(TAG_SCALE);
  anchors.tagB = tagB;
  let tagHeight = 0.258; // props.glb TagMesh max y (cup plane at y = 0)

  // (v7: the listening buoy + hydrophone line are gone; Zach read them as "a boat with fishing line".)

  const glider = holder('glider');
  {
    const y = propMat(0xf2c94c, 0.12);
    glider.body.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 1.6, 4, 10).rotateX(Math.PI / 2), y));
    glider.body.add(new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.04, 0.35), propMat(0x2a3640)));
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.4, 0.3), propMat(0x2a3640));
    fin.position.set(0, 0.2, -0.9);
    glider.body.add(fin);
    glider.scale.setScalar(1.4);
  }
  anchors.glider = glider;

  const boat = holder('boat');
  {
    const hull = propMat(0xe9edf0, 0.02), trim = propMat(0x22303a), tube = propMat(0x3b4650);
    const h = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.0, 6.2), hull); h.position.set(0, 0, -0.6); boat.body.add(h);
    const bow = new THREE.Mesh(new THREE.ConeGeometry(1.7, 2.4, 4).rotateX(Math.PI / 2).rotateZ(Math.PI / 4), hull);
    bow.scale.set(1, 0.42, 1); bow.position.set(0, 0, 3.6); boat.body.add(bow);
    [-1.25, 1.25].forEach((x) => { const t = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 6.6, 8).rotateX(Math.PI / 2), tube); t.position.set(x, 0.2, -0.3); boat.body.add(t); });
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 1.4), trim); cab.position.set(0, 1.0, -0.4); boat.body.add(cab);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.0, 5), trim); mast.position.set(0, 2.4, -0.4); boat.body.add(mast);
    boat.body.position.y = -0.1;
  }

  const blow = makeBlow();
  scene.add(blow.group); managed.push(blow.group);

  // Squid: one InstancedMesh + a Points halo layer (per-instance glow, tinted by the beam).
  const SQUID_N = 110;
  const squidN = smallScreen() ? 64 : SQUID_N; // phone tier: fewer squid (instances + halos) simulated and drawn
  function primitiveSquidGeo() {
    const parts = [new THREE.ConeGeometry(0.22, 1.0, 6).translate(0, 0.35, 0)];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const t = new THREE.CylinderGeometry(0.025, 0.008, 0.8, 3);
      t.rotateX(Math.sin(a) * 0.25); t.rotateZ(Math.cos(a) * 0.25);
      t.translate(Math.cos(a) * 0.1, -0.5, Math.sin(a) * 0.1);
      parts.push(t);
    }
    const g = mergeGeometries(parts.map((p) => { p.deleteAttribute('uv'); return p.toNonIndexed(); }));
    g.rotateX(Math.PI / 2); // mantle forward (+Z)
    return g;
  }
  const squidMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true }); // fogged, tinted per instance
  let squidMesh = new THREE.InstancedMesh(primitiveSquidGeo(), squidMat, SQUID_N);
  squidMesh.frustumCulled = false;
  squidMesh.count = squidN;
  const squidGroup = new THREE.Group();
  squidGroup.add(squidMesh);
  scene.add(squidGroup); managed.push(squidGroup);
  const squidList = [];
  for (let i = 0; i < SQUID_N; i++) {
    squidList.push({
      beam: i % 3, d0: Math.random() * 44, phi: (Math.random() - 0.5) * 0.8, dv: (Math.random() - 0.5) * 2.4,
      base: V((Math.random() - 0.5) * 70, -30 + Math.random() * 42, Math.random() * 90),
      q: new THREE.Quaternion().setFromEuler(new THREE.Euler((Math.random() - 0.5) * 0.8, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6)),
      ph: Math.random() * 6, glow: 0, r: 0, g: 0, b: 0,
    });
  }
  const haloGeo = new THREE.BufferGeometry();
  haloGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SQUID_N * 3), 3).setUsage(THREE.DynamicDrawUsage));
  haloGeo.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(SQUID_N * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const haloMat = new THREE.ShaderMaterial({
    uniforms: { uPx: { value: 1 } },
    vertexShader: `attribute vec3 aCol; uniform float uPx; varying vec3 vC;
      void main(){ vC = aCol; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = uPx * 520.0 / max(-mv.z, 1.0); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vC; void main(){ float r = length(gl_PointCoord - 0.5); float a = pow(smoothstep(0.5, 0.0, r), 2.2); gl_FragColor = vec4(vC * a, a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
  });
  haloGeo.setDrawRange(0, squidN);
  const halos = new THREE.Points(haloGeo, haloMat);
  halos.frustumCulled = false;
  halos.renderOrder = 7;
  squidGroup.add(halos);

  // Whales
  const whaleMats = new Set();
  const placeholderMat = new THREE.MeshStandardMaterial({ color: 0x4a5866, roughness: 0.75, flatShading: true });
  patchCaustics(placeholderMat);
  whaleMats.add(placeholderMat);
  const whales = {};
  const beams = [];
  function addWhale(name, scale = 1) {
    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    const hold = new THREE.Group();
    root.add(hold);
    const ph = makePlaceholderWhale(placeholderMat);
    hold.add(ph.group);
    const anchor = new THREE.Object3D();
    anchor.position.set(0, 0.6, 2.5);
    root.add(anchor);
    root.scale.setScalar(scale);
    scene.add(root);
    managed.push(root);
    const w = { name, root, holder: hold, model: ph.group, tail: ph.tail, mixer: null, actions: {}, phase: Math.random() * 6, anchor, skinned: null };
    whales[name] = w;
    anchors[name] = anchor;
    return w;
  }
  const BEAM_H = 48;
  ['whaleA', 'whaleB', 'whaleC'].forEach((n, i) => {
    const w = addWhale(n);
    // Head anchor at the melon, where the clicks come from (overlays draw coda rings here).
    const head = new THREE.Object3D();
    head.position.set(0, 0.6, 4.6);
    w.root.add(head);
    w.headAnchor = head;
    anchors[`${n}Head`] = head;
    const pivot = new THREE.Group();
    pivot.position.set(0, 0.2, 5.45); // apex at the front of the melon (the snout tip is z = +5.5)
    w.root.add(pivot);
    w.beamPivot = pivot;
    // Echolocation is the neutral --echo colour, not the whales' data-viz colours. Narrow (~4 degree) cone with a hard core;
    // a faint wider sheath gives the soft edge.
    const tint = new THREE.Color(COL.echo);
    const core = makeBeamCone(tint, BEAM_H, 3.2, 0.36, 10.0);
    const haze = makeBeamCone(tint, BEAM_H * 0.9, 6.0, 0.035, 3.0);
    pivot.add(core.mesh, haze.mesh);
    beams.push({ pivot, core, haze, whale: w, i, tint, halfAngle: Math.atan(3.2 / BEAM_H), pos: V(), dir: V() });
  });
  addWhale('calf', 0.4);
  // Persistent identities: the social unit seen top-down in `patterns` is the same cast (whaleA = the tagged whale,
  // whaleB, the calf, Peach = whaleC) plus three extras. overlays address the seven as whale0..6; whale2 is the
  // network's highlighted node (amber), i.e. the tagged whale we followed on its dive.
  for (let i = 4; i < 7; i++) addWhale(`whale${i}`);
  const ROSTER = ['whaleB', 'calf', 'whaleA', 'whaleC', 'whale4', 'whale5', 'whale6'];
  ROSTER.forEach((n, i) => { anchors[`whale${i}`] = whales[n].anchor; });
  // Haze where beams cross (one soft sprite per beam pair).
  const overlapHaze = [0, 1, 2].map(() => { const s = sprite(0xdff4ff, 14, 0); s.renderOrder = 6; scene.add(s); return s; });

  // Blowhole + blow direction in whale-root space (whale faces +Z, its left is +X). Refined from the model.
  const blowLocal = { origin: V(0.45, 1.25, 5.0), dir: V(0.45, 0.62, 0.64).normalize() };

  // Tag site on whaleA: five rest-pose surface samples (centre + the footprint's front/back/left/right), each a
  // triangle + barycentric weights. Every frame they are skinned on the CPU (15 vertices), giving the exact
  // contact point and skin normal under the current animation pose.
  const tagSite = { samples: null, bone: null, gapMax: 0, lift: 0 };

  let dirty = true; // reduced-motion re-render trigger
  const loader = new GLTFLoader();

  function buildTagSite(sm) {
    const geo = sm.geometry;
    const pos = geo.attributes.position;
    const idx = geo.index;
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const len = bb.max.z - bb.min.z;
    const zc = bb.max.z - 0.4 * len; // ~40% of the body length back from the snout
    const hl = (0.2 * TAG_SCALE) / (WHALE_LEN / len); // half the cup footprint, in model units
    const hw = (0.075 * TAG_SCALE) / (WHALE_LEN / len);
    const pts = [[0, zc], [0, zc + hl], [0, zc - hl], [hw, zc], [-hw, zc]];
    const ray = new THREE.Ray();
    const a = V(), b = V(), c = V(), hit = V(), bc = V();
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const samples = [];
    for (const [x, z] of pts) {
      ray.origin.set(x, bb.max.y + 2, z);
      ray.direction.set(0, -1, 0);
      let best = null;
      for (let f = 0; f < triCount; f++) {
        const i0 = idx ? idx.getX(f * 3) : f * 3, i1 = idx ? idx.getX(f * 3 + 1) : f * 3 + 1, i2 = idx ? idx.getX(f * 3 + 2) : f * 3 + 2;
        a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
        if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
        if (best && hit.y <= best.y) continue;
        THREE.Triangle.getBarycoord(hit, a, b, c, bc);
        best = { y: hit.y, i: [i0, i1, i2], w: [bc.x, bc.y, bc.z] };
      }
      if (!best) return null;
      samples.push(best);
    }
    // The bone that dominates the centre sample's vertices is the tag's parent.
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    const score = new Map();
    samples[0].i.forEach((vi) => {
      for (let k = 0; k < 4; k++) {
        const bi = si.getComponent(vi, k), wt = sw.getComponent(vi, k);
        score.set(bi, (score.get(bi) || 0) + wt);
      }
    });
    let boneIdx = 0, bestW = -1;
    score.forEach((wt, bi) => { if (wt > bestW) { bestW = wt; boneIdx = bi; } });
    return { samples, boneIdx, bone: sm.skeleton.bones[boneIdx], boneName: sm.skeleton.bones[boneIdx].name, zc, len };
  }

  loader.load('assets/whale.glb', (gltf) => {
    try {
      const src = gltf.scene;
      let skinned = null;
      src.traverse((o) => { if (o.isMesh && !skinned) skinned = o; });
      const box = new THREE.Box3();
      if (skinned) { skinned.geometry.computeBoundingBox(); box.copy(skinned.geometry.boundingBox); }
      const size = box.getSize(V());
      const ctr = box.isEmpty() ? V() : box.getCenter(V());
      const s = size.z > 3 && size.z < 40 ? WHALE_LEN / size.z : 1;
      // Blowhole: front-left of the head, just behind the snout's top edge.
      if (!box.isEmpty()) {
        blowLocal.origin.set((size.x * 0.12) * s, (box.max.y - ctr.y - 0.05 * size.y) * s, (box.max.z - ctr.z - 0.04 * size.z) * s);
      }
      src.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          if (!m || !m.isMeshStandardMaterial) return;
          // v3 whale has an ORM roughness map: leave roughness alone; the wet sheen comes from envMapIntensity.
          m.metalness = Math.min(0.05, m.metalness);
          if (!m.map && !m.vertexColors && m.color.getHex() === 0xffffff) m.color.set(0x4c5a68);
          patchCaustics(m);
          whaleMats.add(m);
        });
      });
      const clips = {};
      gltf.animations.forEach((c) => { clips[c.name.toLowerCase()] = c; });
      Object.values(whales).forEach((w) => {
        const m = skeletonClone(src);
        m.position.copy(ctr).multiplyScalar(-1);
        let sm = null;
        m.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; if (o.isSkinnedMesh && !sm) sm = o; } });
        const wrap = new THREE.Group();
        wrap.scale.setScalar(s);
        wrap.add(m);
        w.holder.remove(w.model);
        w.holder.add(wrap);
        w.model = wrap;
        w.tail = null;
        w.skinned = sm;
        w.bHead = m.getObjectByName('Spine0'); w.bTail = m.getObjectByName('Spine7'); w.bTail1 = m.getObjectByName('Spine6');
        if (w.headAnchor) { // ride the head bone so the anchor follows the swim/fluke animation
          const hb = m.getObjectByName('Spine0') || m.getObjectByName('Spine1');
          if (hb) { w.root.updateMatrixWorld(true); hb.attach(w.headAnchor); if (w.beamPivot) { hb.attach(w.beamPivot); w.beamPivot.userData.q0 = w.beamPivot.quaternion.clone(); } }
        }
        if (gltf.animations.length) {
          w.mixer = new THREE.AnimationMixer(m);
          const mk = (k) => (clips[k] ? w.mixer.clipAction(clips[k]) : null);
          w.actions = { swim: mk('swim'), glide: mk('glide'), fluke: mk('fluke') };
          const { swim, glide, fluke } = w.actions;
          if (swim) { swim.play(); swim.time = w.phase % swim.getClip().duration; }
          if (glide) { glide.play(); glide.setEffectiveWeight(0); }
          if (fluke) { fluke.setLoop(THREE.LoopOnce, 1); fluke.clampWhenFinished = true; fluke.play(); fluke.paused = true; fluke.setEffectiveWeight(0); }
        }
      });
      const sm = whales.whaleA.skinned;
      if (sm) {
        const site = buildTagSite(sm);
        if (site) { Object.assign(tagSite, site); api.tagBone = site.boneName; }
      }
      api.whaleModel = 'glb';
      dirty = true;
    } catch (err) {
      console.warn('[whale-scroll] whale.glb setup failed, keeping placeholder', err);
    }
  }, undefined, () => console.info('[whale-scroll] whale.glb not loaded; using placeholder whale'));

  // props.glb: clone named nodes into the holders. Missing nodes keep their primitives.
  function takeNode(root, name) {
    const n = root.getObjectByName(name);
    if (!n) return null;
    const c = n.clone(true);
    c.position.set(0, 0, 0);
    c.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; } });
    return c;
  }
  function swapBody(h, node, scale) {
    if (!node) return false;
    h.remove(h.body);
    h.body = node;
    h.add(node);
    if (scale) h.scale.setScalar(scale);
    return true;
  }
  loader.load('assets/props.glb', (gltf) => {
    try {
      const src = gltf.scene;
      src.updateMatrixWorld(true);
      const d = takeNode(src, 'Drone');
      if (swapBody(drone, d, DRONE_SCALE)) {
        drone.rotors = [0, 1, 2, 3].map((i) => d.getObjectByName(`Rotor${i}`)).filter(Boolean);
        d.updateMatrixWorld(true);
        const bb = new THREE.Box3();
        d.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); bb.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrix)); } });
        if (!bb.isEmpty()) droneUnder = -bb.min.y;
      }
      const tg = takeNode(src, 'Tag');
      if (tg) swapBody(tagB, tg.clone(true), TAG_SCALE);
      if (swapBody(tag, tg, TAG_SCALE)) {
        const bb = new THREE.Box3();
        tg.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); bb.union(o.geometry.boundingBox); } });
        if (!bb.isEmpty()) tagHeight = bb.max.y;
      }
      swapBody(glider, takeNode(src, 'Glider'), 1.4);
      swapBody(boat, takeNode(src, 'Boat'), 1);
      const sq = src.getObjectByName('Squid');
      if (sq) {
        const geos = [];
        const inv = new THREE.Matrix4().copy(sq.matrixWorld).invert();
        sq.traverse((o) => {
          if (!o.isMesh) return;
          const g = o.geometry.clone();
          g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
          Object.keys(g.attributes).forEach((k) => { if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); });
          geos.push(g.index ? g.toNonIndexed() : g);
        });
        const merged = geos.length ? mergeGeometries(geos) : null;
        if (merged) {
          merged.computeBoundingBox();
          const sz = merged.boundingBox.getSize(V());
          const k = 1.6 / Math.max(sz.x, sz.y, sz.z, 0.01); // ~1.5 m squid, a touch larger to read
          merged.scale(k, k, k);
          squidGroup.remove(squidMesh);
          squidMesh = new THREE.InstancedMesh(merged, squidMat, SQUID_N);
          squidMesh.frustumCulled = false;
          squidMesh.count = squidN;
          squidGroup.add(squidMesh);
        }
      }
      api.propsModel = 'glb';
      dirty = true;
    } catch (err) {
      console.warn('[whale-scroll] props.glb setup failed, keeping primitives', err);
    }
  }, undefined, () => console.info('[whale-scroll] props.glb not loaded; using primitive props'));

  // The ocean (water.js). Optional: imported dynamically; the fallback sky + flat plane stay until it works.
  let ocean = null;
  import('./water.js').then((mod) => {
    if (typeof mod.createOcean !== 'function') throw new Error('water.js has no createOcean');
    const o = mod.createOcean({ renderer, scene, camera: renderCam, quality: smallScreen() ? 'low' : 'high' });
    if (!o) throw new Error('createOcean returned nothing');
    ocean = o;
    if (ocean.params && 'refractionScale' in ocean.params) ocean.params.refractionScale = 0.5; // v7 perf: half-res refraction everywhere
    sky.visible = false;
    fbSea.visible = false;
    if (ocean.sunDirection && ocean.sunDirection.isVector3) sunDir.copy(ocean.sunDirection).normalize();
    // v4 grade handshake: if water.js still carries its v3 (ultramarine, ACES-tuned) defaults, feed it the navy
    // targets; once water ships its own re-grade this leaves it alone.
    if (ocean.underwaterColor && ocean.underwaterColor.getHexString() === new THREE.Color('#2b3caf').getHexString()) {
      ocean.underwaterColor.copy(DEPTH_STOPS[0][1]);
      if (ocean.deepColor) ocean.deepColor.copy(DEPTH_STOPS[3][1]);
      api.oceanGrade = 'scene-v4';
    } else api.oceanGrade = 'water';
    api.oceanModel = 'water.js';
    dirty = true;
  }).catch((err) => {
    console.info('[whale-scroll] water.js unavailable; using the flat fallback sea:', err && err.message);
  });
  const surfaceAt = (x, z, time) => {
    if (ocean && ocean.surfaceHeightAt) { try { return ocean.surfaceHeightAt(x, z, time); } catch (e) { /* fall through */ } }
    return fallbackWave(x, z, time);
  };

  // Animation weights cross-fade (no pose pops): glide <-> swim eases over ~0.5 s of clock time; the fluke clip is
  // scrubbed by scroll and faded in/out with `flukeW`. A whale's mixer advances at most once per rendered frame
  // (a boundary blend evaluates two shots), and clip times are never reset, so cycles run on across shots.
  let frameId = 0, snapAnim = false;
  function animateWhale(w, dt, time, { fluke = null, flukeW = null, speed = 1, glide = false } = {}) {
    const adv = w.animFrame === frameId ? 0 : dt;
    w.animFrame = frameId;
    const gT = glide ? 1 : 0;
    if (w.gW == null || snapAnim) w.gW = gT;
    else if (adv > 0) w.gW += (gT - w.gW) * Math.min(1, adv * 3);
    const fw = fluke == null ? 0 : (flukeW == null ? 1 : clamp(flukeW));
    if (w.mixer) {
      const { swim, glide: gl, fluke: fk } = w.actions;
      const useGl = gl ? w.gW : 0;
      if (fk) {
        fk.paused = true;
        fk.setEffectiveWeight(fw);
        if (fw > 0) fk.time = clamp(fluke) * fk.getClip().duration;
      }
      const rest = fk ? 1 - fw : 1;
      if (swim) swim.setEffectiveWeight(rest * (1 - useGl));
      if (gl) gl.setEffectiveWeight(rest * useGl);
      w.mixer.update(adv * speed);
    } else if (w.tail) {
      const f = fluke != null ? clamp(fluke) * fw : 0;
      w.tail.rotation.x = Math.sin(time * 2.4 * speed + w.phase) * 0.28 * (1 - f) - 0.9 * Math.sin(Math.PI * f);
    }
  }
  // Nudge one whale's swim cycle toward another's (sync without a restart): a few % speed change per frame.
  function phaseLock(w, ref, k) {
    const s = w.actions.swim, r = ref.actions.swim;
    if (!s || !r || !w.mixer) return;
    const D = s.getClip().duration;
    let d = ((r.time - s.time) % D + 1.5 * D) % D - 0.5 * D; // shortest signed phase difference
    s.time = (s.time + d * clamp(k) + D) % D;
  }
  function poseWhale(w, x, y, z, yaw = 0, pitch = 0, roll = 0) {
    w.root.position.set(x, y, z);
    w.root.rotation.set(pitch, yaw, roll);
    w.root.visible = true;
  }

  // Camera framing
  // Desktop (>= 840 px, cards in a left column): the frame centre is pushed right so the target sits at ~64% x.
  // Narrow (cards bottom-centred): the target sits at ~36% y, and the camera pulls back to fit width.
  let fitK = 1;
  const size = { w: 1, h: 1 };
  const _cp = V();
  function setCam(pos, target, minClear = 2.0, fitAmt = 1) {
    _cp.copy(pos).sub(target).multiplyScalar(1 + (fitK - 1) * fitAmt).add(target);
    if (pos.y < 0) _cp.y = Math.min(_cp.y, -minClear);
    else _cp.y = Math.max(_cp.y, minClear);
    camera.position.copy(_cp);
    camera.lookAt(target);
  }

  let composer = null, bloom = null, useBloom = false;
  function setupComposer(w, h, stageW = w) {
    useBloom = stageW >= 768 && !smallScreen();
    if (!useBloom) return;
    try {
      if (!composer) {
        const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 }); // MSAA: no stair-stepping on silhouettes
        composer = new EffectComposer(renderer, rt);
        composer.addPass(new RenderPass(scene, renderCam));
        bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.4, 0.5, 0.9);
        composer.addPass(bloom);
        composer.addPass(new OutputPass());
      }
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    } catch (err) {
      console.info('[whale-scroll] bloom unavailable', err && err.message);
      composer = null; useBloom = false;
    }
  }

  // The frame's composition centre sits on the subject safe zone (state.safe, smoothed) via an off-axis view
  // offset; without a safe zone, the v4 rule (desktop: 64% x; narrow: 36% y).
  // v6 stage: the canvas is full-viewport and CSS clips it to the visible frame (state.frame, 0..1 of the
  // canvas, animated from full-bleed in the hero to the inset frame in the scenes). The camera is built for the
  // FRAME: its aspect and fov are the frame's, and an off-axis view offset puts the projection centre at the
  // composition centre (the subject safe zone's centre, inside the frame) while the projection still spans the
  // whole canvas, so canvas pixels (project(), overlays) stay exact and the frame looks like a camera of its own.
  const view = { cx: -1, cy: -1, tx: 0.5, ty: 0.5 };    // composition centre, 0..1 of the canvas (smoothed)
  const frameBox = { x0: 0, y0: 0, x1: 1, y1: 1 };      // visible window, 0..1 of the canvas (follows state.frame exactly)
  function applyViewOffset() {
    const W = size.w, H = size.h;
    const fw = Math.max(1, (frameBox.x1 - frameBox.x0) * W), fh = Math.max(1, (frameBox.y1 - frameBox.y0) * H);
    camera.aspect = fw / fh;
    camera.fov = lerp(56, 48, ss(0.62, 1.0, camera.aspect)); // continuous in aspect: no fov pop as the frame changes
    fitK = camera.aspect < 1.25 ? Math.min(1.75, 1.25 / camera.aspect) : 1;
    // A virtual fw x fh image whose principal point lands on stage px (cx*W, cy*H); the stage is a W x H window of it.
    camera.setViewOffset(fw, fh, fw / 2 - view.cx * W, fh / 2 - view.cy * H, W, H);
    camera.updateProjectionMatrix();
    // The render camera draws just the frame's window of that same image.
    renderCam.fov = camera.fov; renderCam.aspect = camera.aspect; renderCam.near = camera.near; renderCam.far = camera.far;
    renderCam.setViewOffset(fw, fh, fw / 2 - view.cx * W + frameBox.x0 * W, fh / 2 - view.cy * H + frameBox.y0 * H, fw, fh);
    renderCam.updateProjectionMatrix();
    const px = renderer.getPixelRatio();
    haloMat.uniforms.uPx.value = px * (fh / 800);
    blow.uniforms.uPx.value = (fh * px) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }
  // Default composition centre (no safe zone): the v4 rule, inside the frame.
  function defaultView() {
    const fwPx = (frameBox.x1 - frameBox.x0) * size.w, wide = fwPx >= 840;
    view.tx = lerp(frameBox.x0, frameBox.x1, wide ? 0.64 : 0.5);
    view.ty = lerp(frameBox.y0, frameBox.y1, wide ? 0.5 : 0.36);
  }
  // Sizing (v7 perf). The stage (#stage, full viewport) gives the math size; the canvas element is positioned
  // and sized to the visible frame window (full-bleed in the hero), so no hidden pixel is ever shaded. Its
  // drawing buffer uses an effective pixel ratio = min(DPR cap, sqrt(budget / frame CSS area)) x an adaptive
  // quality step (0.75 .. 1, from the median frame time); buffers are reallocated at most once per ~1 s except
  // for a frame-size switch (hero <-> scene, which happens while the intro prose covers the stage).
  const buf = { w: 0, h: 0, pr: 0 };   // frame CSS size + pixel ratio of the current drawing buffer
  const PIX_BUDGET = smallScreen() ? 1.2e6 : 3.5e6;
  let quality = 1, lastRealloc = -1e9;
  const ft = new Float32Array(90); let ftN = 0, ftAt = 0;
  const ftSort = new Float32Array(90);
  function stageSize() {
    const st = canvas.parentElement;
    return [(st && st.clientWidth) || window.innerWidth, (st && st.clientHeight) || window.innerHeight];
  }
  function targetPR(fw, fh) {
    return Math.max(0.5, Math.min(dprCap(), Math.sqrt(PIX_BUDGET / Math.max(1, fw * fh))) * quality);
  }
  function placeCanvas(W, H) {
    const l = frameBox.x0 * W, t = frameBox.y0 * H, fw = (frameBox.x1 - frameBox.x0) * W, fh = (frameBox.y1 - frameBox.y0) * H;
    const cs = canvas.style;
    cs.left = `${l.toFixed(1)}px`; cs.top = `${t.toFixed(1)}px`; cs.right = 'auto'; cs.bottom = 'auto';
    cs.width = `${fw.toFixed(1)}px`; cs.height = `${fh.toFixed(1)}px`;
    return [Math.max(1, Math.round(fw)), Math.max(1, Math.round(fh))];
  }
  function updateView(W, H) {
    size.w = W; size.h = H;
    if (view.cx < 0) { defaultView(); view.cx = view.tx; view.cy = view.ty; }
    applyViewOffset();
    dirty = true;
  }
  function reallocBuffers() {
    const [W, H] = stageSize();
    const [fw, fh] = placeCanvas(W, H);
    const pr = targetPR(fw, fh);
    renderer.setPixelRatio(pr);
    renderer.setSize(fw, fh, false);
    buf.w = fw; buf.h = fh; buf.pr = pr;
    lastRealloc = performance.now();
    snowMat.uniforms.uPx.value = pr;
    // marine snow scales with the pixel budget actually spent
    snowGeo.setDrawRange(0, Math.round((smallScreen() ? 1100 : SNOW_N) * clamp((fw * fh * pr * pr) / 3.5e6, 0.4, 1)));
    setupComposer(fw, fh, W);
    updateView(W, H);
  }
  function resize() { reallocBuffers(); }
  function syncSize() {
    const [W, H] = stageSize();
    if (W !== size.w || H !== size.h) updateView(W, H);
    const fw = Math.max(1, Math.round((frameBox.x1 - frameBox.x0) * W)), fh = Math.max(1, Math.round((frameBox.y1 - frameBox.y0) * H));
    const nowMs = performance.now();
    if (fw !== buf.w || fh !== buf.h) { reallocBuffers(); return; } // frame switch / resize: re-place at once
    if (nowMs - lastRealloc > 1000 && Math.abs(targetPR(fw, fh) - buf.pr) > 0.02) reallocBuffers();
  }
  // Adaptive quality: median frame time over ~1 s; > 18 ms steps the ratio down (to 0.75x), < 12 ms back up.
  function trackFrame(dt) {
    if (!(dt > 0) || dt > 0.25) return;
    ft[ftN % ft.length] = dt * 1000; ftN++;
    const nowMs = performance.now();
    if (nowMs - ftAt < 1100 || ftN < 30) return;
    ftAt = nowMs;
    const n = Math.min(ftN, ft.length);
    for (let i = 0; i < n; i++) ftSort[i] = ft[i];
    const med = ftSort.subarray(0, n).sort()[n >> 1];
    api.stats.medianMs = Math.round(med * 10) / 10;
    let q = quality;
    if (med > 18 && quality > 0.75) q = Math.max(0.75, quality - 0.125);
    else if (med < 12 && quality < 1) q = Math.min(1, quality + 0.125);
    if (q !== quality && nowMs - lastRealloc > 1000) { quality = q; ftN = 0; reallocBuffers(); }
  }
  window.addEventListener('resize', () => {
    // The per-frame syncSize() does the work (debounced buffers); a DPR change (zoom, monitor) forces a realloc.
    if (Math.abs(dprCap() - renderer.getPixelRatio()) > 1e-3) buf.w = 0;
    secAt = -1; closeKeysAt = -1; dirty = true;
  });
  resize();

  // Scratch
  const tA = V(), tB = V(), tC = V(), tD = V(), tE = V(), tF = V(), right = V();
  const sC = V(), sF = V(), sB = V(), sL = V(), sRt = V(), sN = V(), sX = V(), sZ = V(), sV = V();
  const tQ = new THREE.Quaternion(), tQ2 = new THREE.Quaternion();
  const tM = new THREE.Matrix4(), tM2 = new THREE.Matrix4();
  const tS = V(1, 1, 1);
  const tCol = new THREE.Color();
  const lerpV = (a, b, t, out) => out.copy(a).lerp(b, t);
  const contact = { pos: V(), quat: new THREE.Quaternion(), normal: V(0, 1, 0), ok: false };

  // patterns layout [x, z, yaw] per ROSTER slot. A and B start where listen/analyze leave them (A heading +x, B -x)
  // and pass each other; the calf trails B; Peach (whaleC) is off to one side, so it can drift in later.
  const PATTERN_BASE = [
    [12, 7, -1.6], [16, 11, -1.45], [-4, -6, 1.6], [30, -20, -2.5], [-27, 16, 0.9], [-22, -24, 0.3], [25, 24, -2.2],
  ];

  // Per-shot clocks: seconds since the shot became current (drives the surfacing + blow, which are timed events,
  // not scroll-scrubbed). `state.since` / `state.blowAge` override them for deterministic harness stills.
  let curShot = '', shotT0 = 0, since = 0, openSurfaced = false;
  let blowT0 = -1e9, blowWhale = null, blowAgeOverride = null, prevT = 0;
  const now = { time: 0 };
  function fireBlow(w) { blowT0 = now.time; blowWhale = w; }
  function blowAge() { return blowAgeOverride != null ? blowAgeOverride : now.time - blowT0; }

  function spinRotors(time) {
    for (let i = 0; i < drone.rotors.length; i++) drone.rotors[i].rotation.y = time * 48 * (i % 2 ? -1 : 1);
  }
  function placeBoat(x, z, yaw, time) {
    boat.visible = true;
    const h0 = surfaceAt(x, z, time);
    const hF = surfaceAt(x + Math.sin(yaw) * 3, z + Math.cos(yaw) * 3, time);
    const hS = surfaceAt(x + Math.cos(yaw) * 1.2, z - Math.sin(yaw) * 1.2, time);
    boat.position.set(x, h0, z);
    boat.rotation.set(Math.atan2(h0 - hF, 3) * 0.8, yaw, Math.atan2(hS - h0, 1.2) * 0.8);
  }

  // Skin the tag site and write the contact pose (exact point on the posed surface + its normal).
  const _sv = V();
  function skinSample(sm, smp, out) {
    const pos = sm.geometry.attributes.position;
    out.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      _sv.fromBufferAttribute(pos, smp.i[k]);
      sm.applyBoneTransform(smp.i[k], _sv);
      out.addScaledVector(_sv, smp.w[k]);
    }
    return sm.localToWorld(out);
  }
  function updateContact(w) {
    const sm = w.skinned;
    w.root.updateMatrixWorld(true);
    if (sm && tagSite.samples) {
      const S = tagSite.samples;
      skinSample(sm, S[0], sC); skinSample(sm, S[1], sF); skinSample(sm, S[2], sB); skinSample(sm, S[3], sL); skinSample(sm, S[4], sRt);
      sZ.subVectors(sF, sB).normalize();
      sX.subVectors(sL, sRt).normalize();
      sN.crossVectors(sZ, sX).normalize();
      // Lift the flat cup base by however far the surface bulges above the tangent plane inside the footprint.
      let lift = 0, gap = 0;
      for (const P of [sF, sB, sL, sRt]) { const h = sV.subVectors(P, sC).dot(sN); lift = Math.max(lift, h); gap = Math.min(gap, h); }
      tagSite.lift = lift; tagSite.gapMax = lift - gap;
      contact.pos.copy(sC).addScaledVector(sN, lift);
      sZ.addScaledVector(sN, -sZ.dot(sN)).normalize();
      sX.crossVectors(sN, sZ);
      tM.makeBasis(sX, sN, sZ);
      contact.quat.setFromRotationMatrix(tM);
      contact.normal.copy(sN);
      contact.ok = true;
    } else {
      // Placeholder whale: the top of the body box.
      contact.pos.copy(w.root.localToWorld(sC.set(0, 1.62, 0.6)));
      w.root.getWorldQuaternion(contact.quat);
      contact.normal.set(0, 1, 0).applyQuaternion(contact.quat);
      contact.ok = false;
    }
  }
  // Seat the tag at the contact pose. Once released it is parented to the whale's spine bone (so it rides the
  // skeleton between updates); the local offset is re-derived from the skinned surface every frame.
  function seatTag(w, tg = tag) {
    const bone = w.skinned && tagSite.samples ? w.skinned.skeleton.bones[tagSite.boneIdx] : null;
    tg.visible = true;
    if (bone) {
      if (tg.parent !== bone) bone.add(tg);
      bone.updateWorldMatrix(true, false);
      tM.compose(contact.pos, contact.quat, tS.set(TAG_SCALE, TAG_SCALE, TAG_SCALE));
      tM2.copy(bone.matrixWorld).invert().multiply(tM);
      tM2.decompose(tg.position, tg.quaternion, tg.scale);
      tS.set(1, 1, 1);
    } else {
      if (tg.parent !== scene) scene.add(tg);
      tg.position.copy(contact.pos);
      tg.quaternion.copy(contact.quat);
      tg.scale.setScalar(TAG_SCALE);
    }
  }
  function tagWhale(w, tg) { updateContact(w); seatTag(w, tg); }
  function freeTag() {
    if (tag.parent !== scene) scene.add(tag);
    tag.scale.setScalar(TAG_SCALE);
  }

  function updateBlow(w, amount = 1) {
    const age = blowAge();
    if (blowWhale !== w || age < 0 || age > 5 || amount <= 0.001) return;
    amount *= 1 - ss(1.2, 2.2, -w.root.position.y - 0.55); // a submerged head doesn't blow
    blow.group.visible = true;
    w.root.updateMatrixWorld();
    const u = blow.uniforms;
    w.root.localToWorld(u.uOrigin.value.copy(blowLocal.origin));
    if (camera.position.y < 0) u.uOrigin.value.y = Math.min(u.uOrigin.value.y, -0.35); // seen from below: the exhalation's bubbles
    w.root.getWorldQuaternion(tQ);
    u.uDir.value.copy(blowLocal.dir).applyQuaternion(tQ);
    // Keep the puff from diving under the sea when the whale pitches: never below ~25° above the horizon.
    if (u.uDir.value.y < 0.42) { u.uDir.value.y = 0.42; u.uDir.value.normalize(); }
    u.uSide.value.set(1, 0, 0).applyQuaternion(tQ);
    u.uAge.value = age;
    u.uAmt.value = amount;
    u.uCam.value.copy(camera.position);
    u.uSun.value.copy(sunDir);
    if (ocean && ocean.sunColor) u.uSunCol.value.copy(ocean.sunColor);
  }

  // open: dawn vista. The whale surfaces in front of the boat (a timed event, once per page load), blows once,
  // then logs at the surface; scroll moves the camera from the horizon down to the whale.
  // The low sun sits just off-frame right: its glitter path runs in behind the whale and the blow is lit from
  // behind, without the glare swallowing the subject.
  // Hero. At t=0 (the page's first viewport) the camera sits ~27 m off the whale's flank, side-lit by the low sun
  // from frame-left (the glitter path is off-frame), whaleA logging in the upper middle/right above the centred hed,
  // ~30% of the frame wide; it blows within half a second of load. Scrolling, the camera rises into a drone-like
  // view (~35 degrees down) over the whale, its body visible under the waves (water.js refraction).
  const O_V = V(0.9, 0, 0.42).normalize();              // view azimuth, ~perpendicular to the sun
  const O_R = V(-O_V.z, 0, O_V.x);                       // screen-right
  const O_P0 = V().addScaledVector(O_V, -26).setY(7), O_P1 = V().addScaledVector(O_V, -21).setY(9.5), O_P2 = V().addScaledVector(O_V, -16).setY(11.5);
  const O_T0 = V(0, -3, 0), O_T1 = V(0, -0.6, 0);
  const O_YAW = Math.atan2(O_R.x * 0.95 - O_V.x * 0.3, O_R.z * 0.95 - O_V.z * 0.3); // head screen-right, a touch toward camera
  const openPts = [V(), V(), V(), V()];
  const BLOW_AT = 0.35;                                  // seconds after the hero starts
  let absorbDefault = null;
  function shotOpen(t, time, dt, view) {
    const A = whales.whaleA;
    if (blowWhale !== A && since >= BLOW_AT && blowT0 < 0) fireBlow(A); // on load
    else if (blowWhale === A && blowAgeOverride == null && blowAge() > 9) fireBlow(A); // logging whales breathe every ~10 s
    const bob = surfaceAt(0, 0, time) * 0.5;
    poseWhale(A, 0, SURFACE_Y + 0.3 + bob, 0, O_YAW, -0.02, surfaceAt(2, 0, time) * 0.02);
    animateWhale(A, dt, time, { glide: true, speed: 0.6 });
    placeBoat(O_V.x * 20 - O_R.x * 15, O_V.z * 20 - O_R.z * 15, 0.5, time); // beyond the whale, frame-left of it
    const e = ease(t);
    lerpV(O_P0, O_P1, ss(0, 0.6, t), tA).lerp(O_P2, ss(0.6, 1, t));
    lerpV(O_T0, O_T1, ss(0, 0.8, t), tB);
    tA.addScaledVector(O_R, Math.sin(time * 0.1) * 0.5 * (1 - e));
    setCam(tA, tB, 1.6, 0.35);
    if (!view) {
      // The research boat is part of the composition too: keep its bow, stern and cabin top inside the safe zone
      // (below the overlay app bar, above the hed).
      const yb = boat.rotation.y, fx = Math.sin(yb), fz = Math.cos(yb);
      openPts[0].set(boat.position.x + fx * 4.5, boat.position.y + 3.2, boat.position.z + fz * 4.5);
      openPts[1].set(boat.position.x - fx * 4.0, boat.position.y + 3.2, boat.position.z - fz * 4.0);
      openPts[2].set(boat.position.x, boat.position.y - 0.4, boat.position.z);
      // and the blow's puff (~3 m out from the blowhole along the blow direction) stays in frame too
      A.root.updateMatrixWorld();
      openPts[3].copy(blowLocal.dir).multiplyScalar(3.2).add(blowLocal.origin);
      A.root.localToWorld(openPts[3]);
      frameWhales([A], 'open', openPts, 4);
    }
    updateBlow(A, 1);
    if (view === 'blow') {
      tB.copy(blow.uniforms.uOrigin.value); tB.y += 2.6;
      tA.copy(camera.position).sub(tB).setY(0).normalize().multiplyScalar(17).add(tB); tA.y = 2.2;
      camera.position.copy(tA); camera.lookAt(tB);
    }
    return { depth: 0, dim: 0 };
  }

  // Keep focal whales out of the cards and overlays. v5: the region comes from `state.safe` (0..1 of the canvas,
  // computed by main.js from the active layout, breakpoint and card rect). Without it, the v4 rules: desktop
  // (>= 840 px) cards fill the left column, so whales stay right of 0.42W + 24 px (and, in observe, left of the
  // dive chart's right ~360 px band); narrow screens centre the cards at the bottom, so whales stay in the top
  // 55% (42% on phones); the hero's hed is centred at the bottom, so its whale stays in the upper half.
  // Implemented as a small camera dolly + pan in screen space after framing.
  const _zq = V(), _zr = V(), _zu = V(), _zf = V(), _zc = V();
  const zonePts = [];
  for (let i = 0; i < 72; i++) zonePts.push(V());
  const FILL = { open: 0.4, observe: 0.45, listen: 0.5, patterns: 0.62, close: 0.55 };
  const FILL_PHONE = { listen: 0.72, close: 0.78 }; // phone tier: the pair / trio fill more of the short stage // min subject fill of the safe zone
  const DEBUG_FRAME = typeof location !== 'undefined' && /debugframe/.test(location.search) ? [] : null;
  const headerEl = typeof document !== 'undefined' ? document.querySelector('.site-header') : null;
  let safe = null; // state.safe for the current frame (smoothed copy)
  const safeSm = { x0: 0, y0: 0, x1: 1, y1: 1, set(o) { this.x0 = o.x0; this.y0 = o.y0; this.x1 = o.x1; this.y1 = o.y1; return this; } };
  const blendR = { depth: 0, dim: 0 };
  function frameWhales(list, mode, extra = null, extraN = 0) {
    if (DEBUG_FRAME) DEBUG_FRAME.length = 0;
    const W = size.w, H = size.h, wide = W >= 840;
    let x0, x1, y0, y1;
    if (mode === 'open') { x0 = wide ? 0.34 * W : 24; x1 = W - 24; y0 = 0.1 * H; y1 = 0.5 * H; }
    else if (wide) { x0 = 0.42 * W + 24; x1 = mode === 'observe' ? W - 384 : W - 24; y0 = 0.08 * H; y1 = 0.92 * H; }
    else { x0 = 24; x1 = W - 24; y0 = 0.06 * H; y1 = (W < 600 ? 0.42 : 0.55) * H; } // phones: the centred cards run tall
    if (safe) {
      // The safe zone is the visible stage less margins: always honour it (a short stacked stage at 1024x768 is
      // a thin band; falling back to the full-canvas rule there put whales above the frame's top edge).
      const pad = Math.min(16, 0.02 * W);
      x0 = safe.x0 * W + pad; x1 = safe.x1 * W - pad; y0 = safe.y0 * H + pad * 0.5; y1 = safe.y1 * H - pad * 0.5;
      if (mode === 'observe' && wide && x1 - x0 > 700) x1 -= Math.min(360, 0.3 * (x1 - x0)); // the dive chart's band
      if (x1 - x0 < 60) { const c = (x0 + x1) / 2; x0 = c - 30; x1 = c + 30; }
      if (y1 - y0 < 60) { const c = (y0 + y1) / 2; y0 = c - 30; y1 = c + 30; }
    }
    if (mode === 'open' && headerEl) {
      // Belt and braces: never under the (overlay) site header, whatever the safe zone says.
      const hb = headerEl.getBoundingClientRect().bottom - canvas.getBoundingClientRect().top;
      if (hb > 0) y0 = Math.max(y0, hb + 0.03 * H);
    }
    let n = 0;
    _zc.set(0, 0, 0);
    for (const w of list) {
      w.root.updateMatrixWorld();
      const sc = w.root.scale.x;
      if (w.bHead && w.bTail && w.bTail1 && n + 7 <= zonePts.length) {
        // The posed skeleton: snout, fluke root, fluke tip (beyond the last bone), the flukes' span either side,
        // and the back, so a fluke-up or a pitched dive stays wholly inside the zone.
        w.bHead.getWorldPosition(zonePts[n++]);
        const tr = zonePts[n++]; w.bTail.getWorldPosition(tr);
        w.bTail1.getWorldPosition(_zq);
        _zf.subVectors(tr, _zq).normalize();
        zonePts[n++].copy(tr).addScaledVector(_zf, 2.6 * sc);
        _zr.set(1, 0, 0).applyQuaternion(w.root.quaternion);
        zonePts[n++].copy(tr).addScaledVector(_zf, 1.6 * sc).addScaledVector(_zr, 2.1 * sc);
        zonePts[n++].copy(tr).addScaledVector(_zf, 1.6 * sc).addScaledVector(_zr, -2.1 * sc);
        _zu.set(0, 1, 0).applyQuaternion(w.root.quaternion);
        zonePts[n++].copy(w.root.position).addScaledVector(_zu, 1.9 * sc);
        zonePts[n++].copy(w.root.position).addScaledVector(_zu, -1.9 * sc);
      } else {
        const k = 5 * sc, kb = (mode === 'observe' ? 3.5 : 5) * sc;
        _zf.set(0, 0, 1).applyQuaternion(w.root.quaternion);
        zonePts[n++].copy(w.root.position).addScaledVector(_zf, k);
        zonePts[n++].copy(w.root.position).addScaledVector(_zf, -kb);
      }
      _zc.add(w.root.position);
    }
    _zc.multiplyScalar(1 / list.length);
    for (let i = 0; i < extraN && n < zonePts.length; i++) zonePts[n++].copy(extra[i]);
    const under = camera.position.y < 0;
    for (let it = 0; it < 14; it++) {
      camera.updateMatrixWorld();
      _zr.setFromMatrixColumn(camera.matrixWorld, 0);
      _zu.setFromMatrixColumn(camera.matrixWorld, 1);
      let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9, ppm = 0;
      for (let i = 0; i < n; i++) {
        _zq.copy(zonePts[i]).project(camera);
        const x = ((_zq.x + 1) / 2) * W, y = ((1 - _zq.y) / 2) * H;
        mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y);
        _zq.copy(zonePts[i]).add(_zr).project(camera);
        ppm += Math.abs(((_zq.x + 1) / 2) * W - x);
      }
      ppm = Math.max(1e-3, ppm / n);
      const k = Math.max((mxx - mnx) / (x1 - x0), (mxy - mny) / (y1 - y0));
      if (DEBUG_FRAME) DEBUG_FRAME[it] = [mode, it, Math.round(x0), Math.round(x1), Math.round(y0), Math.round(y1), Math.round(mnx), Math.round(mxx), Math.round(mny), Math.round(mxy), +k.toFixed(2)];
      if (k > 1.001) { // too big for the zone: dolly back
        camera.getWorldDirection(_zf);
        camera.position.addScaledVector(_zf, -camera.position.distanceTo(_zc) * (k - 1) * 1.05);
        continue;
      }
      // Too small (a big or oddly shaped stage): dolly in toward a minimum fill of the zone, never closer than
      // 12 m to the subject, so whales never read as specks on a 2560 px stage.
      const kMin = (!useBloom && FILL_PHONE[mode]) || FILL[mode] || 0.5;
      if (k < kMin && it < 4) {
        camera.getWorldDirection(_zf);
        const dist = camera.position.distanceTo(_zc);
        const step = Math.min(dist * (1 - k / kMin), dist * 0.45, Math.max(0, dist - 12));
        if (step > 1e-3) { camera.position.addScaledVector(_zf, step * 0.85); continue; }
      }
      let dx = 0, dy = 0;
      if (mnx < x0) dx = x0 - mnx; else if (mxx > x1) dx = x1 - mxx;
      if (mny < y0) dy = y0 - mny; else if (mxy > y1) dy = y1 - mxy;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break;
      camera.position.addScaledVector(_zr, -dx / ppm).addScaledVector(_zu, dy / ppm);
    }
    if (under) camera.position.y = Math.min(camera.position.y, -1.2);
    else camera.position.y = Math.max(camera.position.y, 1.2);
    camera.updateMatrixWorld();
  }

  // observe: drone flies the tag down to whaleA's back (0-0.24), releases it on the skin, climbs away; whale
  // flukes (0.3-0.48); camera slips under and follows the dive to ~700 m looking slightly up, so the surface and
  // the boat recede overhead.
  const OB_YAW = 0.6;
  const OB_FWD = V(Math.sin(OB_YAW), 0, Math.cos(OB_YAW));
  const OB_SIDE = V(Math.cos(OB_YAW), 0, -Math.sin(OB_YAW));
  // Tagging: from the whale's left, a little ahead (head screen-left, the drone dropping in from above).
  // Fluke: swing round behind the whale, so the raised flukes show their full span against the sky.
  const OB_OFF0 = V().addScaledVector(OB_SIDE, 15).addScaledVector(OB_FWD, 4).setY(5.2);
  const OB_OFF1 = V().addScaledVector(OB_SIDE, 14).addScaledVector(OB_FWD, -16).setY(3.0); // three-quarter rear: the arch and the fluke span both read
  const UP = V(0, 1, 0);
  const qCarry = new THREE.Quaternion().setFromAxisAngle(UP, OB_YAW);
  const T_REL = 0.24;
  function shotObserve(t, time, dt, view) {
    const w = whales.whaleA;
    const dive = ss(0.44, 0.84, t);
    const depth = 700 * dive;
    const travel = depth * 0.2 + 22 * ss(0.36, 0.6, t);
    // Fluke-up: the back arches and the body rolls a little as the head goes down, so the flukes lift on a
    // curve rather than standing up like a periscope; the dive steepens once under.
    const pitch = 0.82 * ss(0.27, 0.47, t) + 0.28 * ss(0.47, 0.56, t) - 0.55 * ss(0.74, 0.9, t);
    const roll = 0.28 * Math.sin(Math.PI * ss(0.26, 0.5, t));
    const bob = surfaceAt(OB_FWD.x * travel, OB_FWD.z * travel, time) * 0.4 * (1 - ss(0.3, 0.45, t));
    poseWhale(w, OB_FWD.x * travel, SURFACE_Y + bob - depth, OB_FWD.z * travel, OB_YAW, pitch, roll);
    const fl = ss(0.3, 0.48, t);
    // The fluke clip fades in at its first frame and out at its last, so neither end pops against the swim cycle.
    animateWhale(w, dt, time, { fluke: fl, flukeW: ss(0.27, 0.305, t) * (1 - ss(0.475, 0.53, t)), speed: t > 0.5 ? 1 : 0.6, glide: t < 0.3 });
    updateContact(w);
    placeBoat(-30, -30, 1.4, time);

    // Drone + tag. Hang = drone origin to the tag's cup plane while carried (tag top under the gimbal).
    const hang = droneUnder * DRONE_SCALE + tagHeight * TAG_SCALE + 0.03;
    drone.visible = t < 0.62;
    drone.rotation.set(0, OB_YAW + Math.sin(time * 0.4) * 0.06 * (t < 0.17 ? 1 : 0), 0);
    spinRotors(time);
    if (t < T_REL) {
      const k2 = ease(ss(0.15, T_REL - 0.005, t)); // final descent: the tag lands exactly on the contact point
      tE.copy(contact.pos).addScaledVector(UP, 3.2);                // hover point (tag cup plane)
      if (t < 0.15) {
        tF.set(-12, 34, -16).add(contact.pos);                       // arrival from the boat side
        lerpV(tF, tE, ease(t / 0.15), tD);
        tD.y += Math.sin(time * 2.6) * 0.06;
      } else {
        lerpV(tE, contact.pos, k2, tD);
      }
      freeTag();
      tag.visible = true;
      tag.position.copy(tD);
      tag.quaternion.copy(qCarry).slerp(contact.quat, k2);
      drone.position.copy(tD).addScaledVector(UP, hang);
    } else {
      seatTag(w);
      const k = ease(clamp((t - 0.27) / 0.3));
      drone.position.copy(contact.pos).addScaledVector(UP, hang + 0.6 * ss(T_REL, 0.27, t));
      drone.position.x += 8 * k; drone.position.y += 46 * k; drone.position.z -= 10 * k;
    }

    const wp = w.root.position;
    // Camera offsets (world), blended by phase.
    lerpV(OB_OFF0, OB_OFF1, ss(0.24, 0.4, t), tA);
    tE.copy(OB_SIDE).multiplyScalar(34); tE.y = -14; tE.addScaledVector(OB_FWD, -4); // under-and-beside
    tA.lerp(tE, ss(0.42, 0.56, t));
    tB.copy(wp);
    const flk = ss(0.26, 0.38, t) * (1 - ss(0.44, 0.52, t));       // aim at the rising flukes
    tB.addScaledVector(OB_FWD, -4.5 * flk); tB.y += 2.2 * flk;
    tB.y += lerp(1.2, 8, ss(0.42, 0.56, t)); // look a little above the whale once under, to keep the ceiling in frame
    tB.addScaledVector(OB_FWD, -6 * ss(0.42, 0.56, t)); // screen-right is -fwd here: keeps the whale clear of the depth gauge
    if (t < 0.3) tB.lerp(contact.pos, 0.35 * (1 - ss(0.24, 0.3, t))); // favour the tagging moment
    tA.add(tB);
    setCam(tA, tB);
    if (!view) frameWhales([w], 'observe');
    if (view === 'tag') tagCloseUp(w);
    return { depth: Math.max(0, -wp.y), dim: 0 };
  }

  // Harness close-up (`&view=tag`): grazing view along the skin across the tag, to check cup contact.
  function tagCloseUp(w) {
    tA.copy(contact.pos);
    w.root.getWorldQuaternion(tQ);
    tC.set(1, 0, 0).applyQuaternion(tQ);
    tD.copy(contact.normal);
    tB.copy(tA).addScaledVector(tC, 1.9).addScaledVector(tD, 0.18);
    camera.position.copy(tB);
    camera.up.copy(tD);
    camera.lookAt(tA.addScaledVector(tD, 0.12));
    camera.up.set(0, 1, 0);
  }

  // listen / annotate / analyze: two whales just under the surface drift from ~45 m apart to within a body length.
  // In listen, whaleB rises to breathe in view (its exhalation shows as a burst of bubbles from below) then
  // settles back.
  let listenBlown = false;
  function listenLayout(e, time, dt, rise = 0) {
    const A = whales.whaleA, B = whales.whaleB, calf = whales.calf;
    // Narrow frames squeeze the pair's gap (continuous in aspect) so phones see whales, not slivers.
    const mid = 5 - 3.5 * e, sep = lerp(0.62, 1, ss(0.75, 1.3, camera.aspect));
    const ax = mid + (-12 + 7 * e - mid) * sep, bx = mid + (22 - 14 * e - mid) * sep;
    poseWhale(A, ax, -6.5 + Math.sin(time * 0.5) * 0.3, -4, Math.PI / 2, 0.02);
    poseWhale(B, bx, lerp(-4.2 + Math.sin(time * 0.5 + 1) * 0.3, SURFACE_Y - 0.8 + surfaceAt(bx, 4, time) * 0.3, rise), 4, -Math.PI / 2, -0.02 - 0.12 * Math.sin(Math.PI * clamp(rise * 1.2)) * (1 - rise));
    // The calf swims below and slightly behind B (its own silhouette, never doubled over B's).
    poseWhale(calf, bx + 2.2, -7.6 + 2.2 * rise + Math.sin(time * 0.7) * 0.2, 5.5, -Math.PI / 2, 0);
    animateWhale(A, dt, time, { speed: 0.7 });
    animateWhale(B, dt, time, rise > 0.9 ? { glide: true, speed: 0.6 } : { speed: 0.7 });
    animateWhale(calf, dt, time, { speed: 1.3 });
    // whaleA carries the tag from observe on; whaleB wears its own from its first appearance.
    tagWhale(A, tag);
    tagWhale(B, tagB);
  }
  // The camera tracks the pair's midpoint and eases in as they close the gap.
  const L_T = V(), L_P = V(), AN_P = V(4, -4.5, 44), AZ_P = V(18, -7.5, 40); // close enough to stay clear of the ~35 m haze
  function listenCam(e) {
    const mid = 5 - 3.5 * e;
    L_T.set(mid, -4.6, 0);
    L_P.set(mid + 1, -2.3, lerp(50, 34, e));
  }
  function shotListen(t, time, dt, view) {
    const rise = ss(0.3, 0.5, t) * (1 - ss(0.78, 0.95, t));
    if (!listenBlown && t >= 0.44 && t < 0.8) { fireBlow(whales.whaleB); listenBlown = true; } // exhales as it breaks the surface
    listenLayout(ease(t), time, dt, rise);
    listenCam(ease(t));
    glider.visible = true;
    glider.position.set(lerp(-90, 90, t), -16 + Math.sin(t * 6) * 1.2, -38);
    glider.rotation.set(0, Math.PI / 2, -0.06);
    setCam(L_P, L_T);
    if (!view) frameWhales([whales.whaleA, whales.whaleB], 'listen');
    updateBlow(whales.whaleB, 1);
    if (view === 'whale') { // harness: caustics close-up on whaleA's back
      tB.copy(whales.whaleA.root.position); tB.y += 0.5;
      camera.position.copy(tB).add(tA.set(-3, 3.2, 9)); camera.lookAt(tB);
    }
    return { depth: Math.max(0, -whales.whaleA.root.position.y), dim: 0.1 };
  }
  function shotAnnotate(t, time, dt) {
    listenLayout(1, time, dt);
    listenCam(1);
    // Slow drift, one shared clock with analyze; it ramps in from listen's still camera so neither boundary pops.
    const dr = ss(0, 0.3, t);
    lerpV(L_P, AN_P, ease(t), tA); tA.x += Math.sin(time * 0.06) * 5 * dr; tA.y += Math.sin(time * 0.045) * 1.2 * dr;
    setCam(tA, L_T);
    frameWhales([whales.whaleA, whales.whaleB], 'listen');
    return { depth: Math.max(0, -whales.whaleA.root.position.y), dim: lerp(0.1, 0.32, ss(0, 0.35, t)) };
  }
  function shotAnalyze(t, time, dt) {
    listenLayout(1, time, dt);
    listenCam(1);
    lerpV(AN_P, AZ_P, ease(t), tA); tA.x += Math.sin(time * 0.06) * 5; tA.y += Math.sin(time * 0.045) * 1.2;
    setCam(tA, L_T);
    frameWhales([whales.whaleA, whales.whaleB], 'listen');
    return { depth: Math.max(0, -whales.whaleA.root.position.y), dim: 0.32 };
  }

  let patternWhales = null;
  // v6 QA: the unit is seen from BELOW, silhouetted against the bright surface (Snell's window), not from the air.
  // Same plan view for the network overlay, and neither neighbouring boundary has to take the camera through the
  // waterline (which flashed sky with no whales in frame). Tilted ~70 degrees up (never exactly vertical).
  const P_P0 = V(0, -58, 26), P_P1 = V(0, -50, 18), P_T = V(0, 0, 0);
  function patternPose(i, t, time, dt) {
    const [x, z, yaw] = PATTERN_BASE[i];
    const w = whales[ROSTER[i]];
    const drift = t * 14 + Math.sin(time * 0.2 + i) * 1.5;
    const yy = yaw + Math.sin(time * 0.15 + i) * 0.1;
    const px = x + Math.sin(yy) * drift, pz = z + Math.cos(yy) * drift;
    // Logging at the surface: backs ride the swell clear of the water (phones' water has no see-through refraction,
    // so a whale even slightly under would vanish from the top-down view).
    poseWhale(w, px, SURFACE_Y + 0.3 + surfaceAt(px, pz, time) * 0.9, pz, yy, 0);
    animateWhale(w, dt, time, { glide: true, speed: 0.5 });
    return w;
  }
  function shotPatterns(t, time, dt) {
    if (!patternWhales) patternWhales = ROSTER.map((n) => whales[n]);
    for (let i = 0; i < ROSTER.length; i++) patternPose(i, t, time, dt);
    tagWhale(whales.whaleA, tag);
    tagWhale(whales.whaleB, tagB);
    setCam(lerpV(P_P0, P_P1, ease(t), tA), P_T);
    frameWhales(patternWhales, 'patterns');
    return { depth: 0, dim: 0.35 };
  }

  // close (contract v5 beats, keyed to the section's five cards; K[i] = the t at which card i's centre crosses the
  // viewport centre, read from the DOM; defaults for the harness):
  //   opener .. K0   whaleA + whaleB, both tagged, dive side by side in perfect sync (yo-yo: down ...
  //   K0 .. M01      ... and back up), while Peach (whaleC) drifts in from the distance and joins them
  //   M01 .. M12     "the three of them diving together going up and down in very close proximity": down, up
  //   M12 .. K3      the three descend into ink-black, the light dying with depth ("proximity networks ...")
  //   K2/K3 .. K3    eyesight fails: click-driven torch beams come on from the three heads
  //   K3 .. K4 .. 1  beams sweep, squid light up where the beams find them, neighbours' beams overlap; hold
  const closeK = [0.16, 0.34, 0.52, 0.7, 0.88];
  let closeSec = null, closeSteps = null, closeKeysAt = -1;
  const ZT_N = 256, ZT = new Float32Array(ZT_N + 1);
  let ztKey = '';
  function refreshCloseKeys(time) {
    if (closeKeysAt >= 0 && time - closeKeysAt < 0.5 && time >= closeKeysAt) return;
    closeKeysAt = time;
    if (closeSec === null) {
      closeSec = (typeof document !== 'undefined' && document.querySelector('.whale-scene[data-shot="close"]')) || false;
      closeSteps = closeSec ? closeSec.querySelectorAll('.whale-step') : null;
    }
    const ns = closeSteps ? closeSteps.length : 0;
    if (closeSec && ns >= 4) {
      const r = closeSec.getBoundingClientRect(), vh = window.innerHeight || 1, span = r.height - vh;
      if (span > 10) {
        const kAt = (i) => { const q = closeSteps[i].getBoundingClientRect(); return clamp((q.top - r.top + q.height / 2 - vh / 2) / span, 0.04, 0.97); };
        if (ns >= 5) for (let i = 0; i < 5; i++) closeK[i] = kAt(i);
        else { closeK[0] = kAt(0); closeK[2] = kAt(1); closeK[3] = kAt(2); closeK[4] = kAt(3); closeK[1] = (closeK[0] + closeK[2]) / 2; }
      }
    }
    const key = closeK.join();
    if (key !== ztKey) { ztKey = key; buildCloseZ(); }
  }
  const C_PMAX = 0.85; // steepest pitch (rad); the group swims forward fast enough that its heading never exceeds it
  function closeDepth(t) {
    const [k0, k1, , k3] = closeK, m01 = (k0 + k1) / 2, m12 = (k1 + closeK[2]) / 2;
    if (t < k0) return lerp(12, 44, ease(t / k0));
    if (t < m01) return lerp(44, 18, ease((t - k0) / (m01 - k0)));
    if (t < k1) return lerp(18, 40, ease((t - m01) / (k1 - m01)));
    if (t < m12) return lerp(40, 24, ease((t - k1) / (m12 - k1)));
    if (t < k3) return lerp(24, 380, ease((t - m12) / (k3 - m12)));
    return 380 + 60 * (t - k3) / (1 - k3);
  }
  const closeDD = (t) => (closeDepth(Math.min(1, t + 0.002)) - closeDepth(Math.max(0, t - 0.002))) / (Math.min(1, t + 0.002) - Math.max(0, t - 0.002));
  function buildCloseZ() {
    ZT[0] = 0;
    for (let i = 1; i <= ZT_N; i++) {
      const tm = (i - 0.5) / ZT_N;
      const vmin = lerp(140, 340, ss(closeK[3] - 0.06, closeK[3] + 0.04, tm)); // the deep hold cruises flatter
      ZT[i] = ZT[i - 1] + Math.max(vmin, Math.abs(closeDD(tm)) / Math.tan(C_PMAX)) / ZT_N;
    }
    // Heading pitch (v7): the path's raw slope flips fast at every turn of the yo-yo and dipped to level at K3
    // (the descent's ease-out meeting the slow cruise). Tabulate it, smooth it (3 box passes, +-0.02 t) and
    // rate-limit it both ways (<= 2.2 deg per 1/256 t), so the whales turn slowly and never level-out-and-snap.
    for (let i = 0; i <= ZT_N; i++) {
      const tm = i / ZT_N, a = Math.max(0, tm - 0.002), b = Math.min(1, tm + 0.002);
      const dz = (closeZ(b) - closeZ(a)) / (b - a);
      PT[i] = clamp(Math.atan2(closeDD(tm), Math.max(dz, 1)), -0.62, C_PMAX);
    }
    const R = 5;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i <= ZT_N; i++) {
        let acc = 0, n = 0;
        for (let j = Math.max(0, i - R); j <= Math.min(ZT_N, i + R); j++) { acc += PT[j]; n++; }
        PT2[i] = acc / n;
      }
      PT.set(PT2);
    }
    // From the end of the descent on, the heading only ever eases from the dive's pitch to the cruise's (never
    // under it and back): no "level out, then point down again".
    const cruise = PT[ZT_N], i0 = Math.max(1, Math.floor((closeK[3] - 0.12) * ZT_N));
    for (let i = i0; i <= ZT_N; i++) PT[i] = clamp(PT[i], Math.min(cruise, PT[i - 1]), PT[i - 1]);
    const rate = THREE.MathUtils.degToRad(2.2);
    for (let i = 1; i <= ZT_N; i++) PT[i] = clamp(PT[i], PT[i - 1] - rate, PT[i - 1] + rate);
    for (let i = ZT_N - 1; i >= 0; i--) PT[i] = clamp(PT[i], PT[i + 1] - rate, PT[i + 1] + rate);
  }
  const PT = new Float32Array(ZT_N + 1), PT2 = new Float32Array(ZT_N + 1);
  const closePitch = (t) => { const f = clamp(t) * ZT_N, i = Math.min(ZT_N - 1, Math.floor(f)); return lerp(PT[i], PT[i + 1], f - i); };
  const closeZ = (t) => { const f = clamp(t) * ZT_N, i = Math.min(ZT_N - 1, Math.floor(f)); return lerp(ZT[i], ZT[i + 1], f - i); };
  buildCloseZ();
  const C_OFF = { whaleA: [-8, -3.2, -1.5], whaleB: [0, 0, 1], whaleC: [8, 3.2, -1.5] }; // stepped in height: pitched dives never stack into one silhouette
  const C_PAIR = { whaleA: [-5, -2, -0.5], whaleB: [5, 2, 0.5] }; // the tagged pair, before Peach arrives
  const C_FAR = [26, -4, 78];                                             // Peach, emerging from the haze ahead (not across the frame edge)
  // Camera offsets from the group: low front-left for the shallow yo-yo, high left for the beams (seen along
  // their length, not end-on, where a cone reads as a blob).
  const C_CAM_YO = V(-40, 12, 15), C_CAM_DARK = V(-46, 30, 14), C_CAM_HOLD = V(-50, 33, 10);
  const closeCast = [whales.whaleA, whales.whaleB, whales.whaleC];
  const BIAS = [0.22, 0, -0.22]; // A's and C's beams converge on B's
  const closePair = [whales.whaleA, whales.whaleB];
  const UNIT_REST = [1, 4, 5, 6]; // ROSTER slots that stay at the surface: the calf and the three extras
  const _be = new THREE.Euler();
  const beamPts = [];
  for (let i = 0; i < 8; i++) beamPts.push(V());
  function shotClose(t, time, dt) {
    refreshCloseKeys(time);
    const [k0, k1, k2, k3, k4] = closeK, m01 = (k0 + k1) / 2, m12 = (k1 + k2) / 2;
    const D = closeDepth(t), gz = closeZ(t);
    const pitch = closePitch(t);
    const join = ease(ss(k0 * 0.55, m01, t));         // Peach's approach
    const bob = Math.sin(time * 0.5) * 0.25;           // one shared bob: in sync
    for (let i = 0; i < 3; i++) {
      const w = closeCast[i], n = w.name;
      const o = C_OFF[n];
      let ox, oy, oz;
      if (n === 'whaleC') { ox = lerp(C_FAR[0], o[0], join); oy = lerp(C_FAR[1], o[1], join); oz = lerp(C_FAR[2], o[2], join); }
      else { const pr = C_PAIR[n]; ox = lerp(pr[0], o[0], join); oy = lerp(pr[1], o[1], join); oz = lerp(pr[2], o[2], join); }
      // Peach swims a slightly flatter line while it closes the gap, then matches the pair's heading.
      const pw = n === 'whaleC' ? lerp(0.15, pitch, ss(m01 - 0.06, m01 + 0.02, t)) : pitch;
      poseWhale(w, ox, -D + oy + bob, gz + oz, n === 'whaleC' ? -0.35 * (1 - join) : 0, pw + Math.sin(time * 0.4) * 0.02);
      animateWhale(w, dt, time, { speed: 0.9 });
    }
    // In sync: B (and Peach, once it has joined) ease their swim cycles onto A's; no clip restarts.
    phaseLock(whales.whaleB, whales.whaleA, 0.06);
    phaseLock(whales.whaleC, whales.whaleA, 0.06 * ss(m01 - 0.05, m01 + 0.05, t));
    if (whales.whaleB.mixer) whales.whaleB.mixer.update(0);
    if (whales.whaleC.mixer) whales.whaleC.mixer.update(0);
    tagWhale(whales.whaleA, tag);
    tagWhale(whales.whaleB, tagB);
    // The rest of the unit (from patterns) logs at the surface overhead until the dive leaves it behind.
    if (D < 140) for (let j = 0; j < UNIT_REST.length; j++) patternPose(UNIT_REST[j], 1, time, dt);

    // Beams are fully on by the time the ink-black card (beat 4) is being read, not only at its centre.
    const beamOp = ss(k2 + 0.15 * (k3 - k2), k2 + 0.65 * (k3 - k2), t);
    const beamGain = useBloom ? 1 : 1.6; // no bloom on the phone tier: brighter additive cores instead
    for (let k = 0; k < beams.length; k++) {
      const b = beams[k];
      b.whale.root.updateMatrixWorld();
      b.core.mesh.visible = b.haze.mesh.visible = beamOp > 0.002;
      // Step-scan: each click (2 per second, all whales in sync) nudges the beam to its next heading.
      const ck = time * 2, stepT = Math.floor(ck) + ss(0, 0.3, ck - Math.floor(ck));
      _be.set(0.12 + Math.sin(stepT * 0.31 + k * 1.7) * 0.12, BIAS[k] + Math.sin(stepT * 0.37 + k * 2.1) * 0.3, 0);
      // The pivot rides the head bone: the sweep is applied on top of its rest orientation (whale-forward), not
      // in the bone's own axes.
      if (b.pivot.userData.q0) b.pivot.quaternion.copy(b.pivot.userData.q0).multiply(tQ2.setFromEuler(_be));
      else b.pivot.rotation.copy(_be);
      b.core.mat.uniforms.op.value = beamOp * beamGain; b.core.mat.uniforms.uTime.value = time;
      b.haze.mat.uniforms.op.value = beamOp * beamGain; b.haze.mat.uniforms.uTime.value = time;
      b.pivot.updateMatrixWorld();
      b.pivot.getWorldPosition(b.pos);
      b.pivot.getWorldQuaternion(tQ);
      b.dir.set(0, 0, 1).applyQuaternion(tQ);
    }
    // Volumetric haze where pairs of beams overlap: sample along beam i, test inside cone j.
    for (let p = 0; p < 3; p++) {
      const bi = beams[p], bj = beams[(p + 1) % 3];
      let best = 0;
      for (let s = 1; s <= 8; s++) {
        const along = (s / 9) * BEAM_H;
        tA.copy(bi.pos).addScaledVector(bi.dir, along);
        tB.copy(tA).sub(bj.pos);
        const aj = tB.dot(bj.dir);
        if (aj <= 0 || aj > BEAM_H) continue;
        const rad = Math.sqrt(Math.max(0, tB.lengthSq() - aj * aj));
        const rj = aj * Math.tan(bj.halfAngle) * 1.3;
        const ov = (1 - rad / rj) * (1 - along / BEAM_H) * (1 - aj / BEAM_H);
        if (ov > best) { best = ov; tF.copy(tA); }
      }
      const s = overlapHaze[p];
      s.visible = false; // v3c: no soft haze blobs where beams cross
      if (s.visible) { s.position.copy(tF); s.material.opacity = 0.1 * best * beamOp; s.material.color.copy(bi.tint).lerp(bj.tint, 0.5); }
    }

    // Squid in the group's frame, drifting back past the whales (wrap along z), in the beams' scan fan.
    squidGroup.visible = beamOp > 0.002;
    const fanPitch = whales.whaleA.root.rotation.x + 0.12;
    const pos = halos.geometry.attributes.position.array, colA = halos.geometry.attributes.aCol.array;
    for (let k = 0; k < squidN; k++) {
      const s = squidList[k];
      // Squid live in each beam's scan fan (so the narrow cones keep finding a few), drifting back past the head.
      const bb = beams[s.beam];
      const dd = 6 + ((((s.d0 - time * 2.2) % 44) + 44) % 44);
      const yaw = BIAS[s.beam] + s.phi, pt = fanPitch + s.dv * Math.tan(bb.halfAngle);
      tA.set(Math.sin(yaw) * Math.cos(pt), -Math.sin(pt), Math.cos(yaw) * Math.cos(pt)).multiplyScalar(dd).add(bb.pos);
      tA.x += Math.sin(time * 0.3 + s.ph) * 0.4; tA.y += Math.sin(time * 0.4 + s.ph) * 0.3;
      let lit = 0, r = 0, g = 0, bl = 0;
      for (let j = 0; j < beams.length; j++) {
        const b = beams[j];
        tB.copy(tA).sub(b.pos);
        const along = tB.dot(b.dir);
        if (along <= 0 || along > BEAM_H) continue;
        const ang = Math.acos(clamp(along / Math.max(1e-3, tB.length()), -1, 1));
        const inside = 1 - ss(b.halfAngle * 0.8, b.halfAngle * 1.25, ang);
        if (inside <= 0) continue;
        const v = inside * (1.2 - along / BEAM_H);
        lit += v; r += b.tint.r * v; g += b.tint.g * v; bl += b.tint.b * v;
      }
      const target = clamp(lit) * beamOp;
      s.glow += (target - s.glow) * Math.min(1, (dt || 0.016) * 8);
      if (!dt) s.glow = target;
      if (lit > 0) { s.r = r / lit; s.g = g / lit; s.b = bl / lit; }
      const gl = s.glow;
      // Only squid inside a beam exist for the viewer: emissive x cone membership; the rest are collapsed away.
      const sc = gl > 0.03 ? 1 : 0;
      tM.compose(tA, s.q, tE.set(sc, sc, sc));
      squidMesh.setMatrixAt(k, tM);
      const sg = useBloom ? 1 : 1.8; // phone tier (no bloom): squid read brighter
      tCol.setRGB(0.25 * gl * sg, 0.75 * gl * sg, 0.7 * gl * sg); // faint blue-green bioluminescence where the beam finds them
      squidMesh.setColorAt(k, tCol);
      pos[k * 3] = tA.x; pos[k * 3 + 1] = tA.y; pos[k * 3 + 2] = tA.z;
      colA[k * 3] = 0.06 * gl; colA[k * 3 + 1] = 0.22 * gl; colA[k * 3 + 2] = 0.2 * gl; // halos unboosted (big soft sprites saturate)
    }
    let lc = 0; for (let k = 0; k < squidN; k++) if (squidList[k].glow > 0.3) lc++;
    api.litSquid = lc;
    squidMesh.instanceMatrix.needsUpdate = true;
    if (squidMesh.instanceColor) squidMesh.instanceColor.needsUpdate = true;
    halos.geometry.attributes.position.needsUpdate = true;
    halos.geometry.attributes.aCol.needsUpdate = true;

    // Camera: in the shallow yo-yo it follows only half of the vertical motion, so the dive and the climb read
    // on screen; from the deep dive on it tracks the group fully.
    const track = ss(m12 - 0.02, m12 + 0.1, t);
    const Dc = lerp(28 + 0.5 * (D - 28), D, track);
    tB.set(0, -Dc, gz + 6 * beamOp);
    // Swing up to the high side view during the descent, before the beams come on (never see a cone end-on).
    lerpV(C_CAM_YO, C_CAM_DARK, ease(ss(m12, k2 + 0.4 * (k3 - k2), t)), tA).lerp(C_CAM_HOLD, ease(ss(k3, k4, t)));
    tA.add(tB);
    setCam(tA, tB);
    // Keep the beams on screen too (phones park the cards low, so the frame is short): sample each beam's
    // centre and far end into the framing set once they are on.
    let nb = 0;
    // Peach joins the framed set gradually (its points slide from B's to its own), so the camera never jumps.
    {
      const wc = ss(0.15, 0.6, join), B = whales.whaleB.root, C = whales.whaleC.root;
      _zf.set(0, 0, 1).applyQuaternion(C.quaternion);
      beamPts[nb++].copy(B.position).lerp(C.position, wc).addScaledVector(_zf, 5);
      beamPts[nb++].copy(B.position).lerp(C.position, wc).addScaledVector(_zf, -5);
    }
    // The beam samples slide out from the heads as the beams come on (continuous: no framing jump).
    const bw = ss(0.05, 0.9, beamOp);
    if (bw > 0) for (let k = 0; k < beams.length; k++) {
      const b = beams[k];
      // the beam's rest heading (not its click-by-click sweep, which would jiggle the framing in time)
      tQ.copy(b.whale.root.quaternion).multiply(tQ2.setFromEuler(_be.set(0.12, BIAS[k], 0)));
      tD.set(0, 0, 1).applyQuaternion(tQ);
      beamPts[nb++].copy(b.pos).addScaledVector(tD, BEAM_H * (useBloom ? 0.35 : 0.22) * bw);
      beamPts[nb++].copy(b.pos).addScaledVector(tD, BEAM_H * (useBloom ? 0.6 : 0.32) * bw);
    }
    frameWhales(closePair, 'close', beamPts, nb);
    return { depth: Math.max(0, D), dim: 0 };
  }

  const SHOTS = { open: shotOpen, observe: shotObserve, listen: shotListen, annotate: shotAnnotate, analyze: shotAnalyze, patterns: shotPatterns, close: shotClose };

  const warm = new THREE.Color(0xffc690), white = new THREE.Color(0xfff4e8);
  function updateEnvironment(time, aerialW, closeW, clearW = 0) {
    const cp = camera.position;
    const under = cp.y < 0;
    const d = Math.max(0, -cp.y);
    const absU = ocean && ocean.params && ocean.params.uniforms && ocean.params.uniforms.uAbsorb;
    if (absU && absU.value && absU.value.isVector3) {
      if (!absorbDefault) absorbDefault = absU.value.clone();
      absU.value.copy(absorbDefault).multiplyScalar(lerp(1, 0.7, aerialW)); // clearer water for the aerial shots
    }
    if (ocean && ocean.update) { renderCam.updateMatrixWorld(); ocean.update(time, renderCam); }
    if (ocean && ocean.sunDirection && ocean.sunDirection.isVector3) sunDir.copy(ocean.sunDirection).normalize();
    updateRefraction();

    sky.position.copy(cp);
    sky.visible = !ocean && !under;
    fbSea.visible = !ocean;
    fbSeaU.uCam.value.copy(cp);
    fbSeaU.uUnder.value = under ? 1 : 0;
    dome.position.copy(cp);
    dome.visible = under && !ocean; // water.js draws its own underwater backdrop

    const focus = whales.whaleA.root.visible ? whales.whaleA.root.position : cp;
    sun.target.position.copy(focus);
    rim.target.position.copy(focus);

    if (!under) {
      scene.background.set(0x8fb0cf);
      if (ocean && ocean.fogColor) scene.fog.color.copy(ocean.fogColor); else scene.fog.color.set(0xc9d3dc);
      scene.fog.density = 0.00011;
      if (ocean && ocean.environment) scene.environment = ocean.environment;
      else scene.environment = skyEnv;
      // Key: the sun, warm when low.
      const elev = clamp(sunDir.y * 3);
      if (ocean && ocean.sunColor) sun.color.copy(ocean.sunColor); else sun.color.copy(warm).lerp(white, elev);
      sun.intensity = 2.2;
      sun.position.copy(focus).addScaledVector(sunDir, 100);
      hemi.color.set(0xb9d2ee); hemi.groundColor.set(0x16356e); hemi.intensity = 1.25;
      fill.intensity = 1.5; fill.color.set(0xc4d6ea);
      fill.position.copy(cp).add(tA.set(0, 40, 0)); fill.target.position.copy(focus);
      rim.intensity = 0;
      causticU.uCAmt.value = 1.2; // seen through water.js's refraction; strong values made a pale ghost of the body
      causticU.uCCol.value.setRGB(0.95, 0.95, 0.85);
      whaleMats.forEach((m) => { m.envMapIntensity = 0.85; }); // wet sheen without washing the skin out
      renderer.toneMappingExposure = 1.0;
    } else {
      depthColor(d, tCol);
      const k = Math.exp(-d / 70); // light left at this depth
      if (ocean && ocean.fogColor) tCol.copy(ocean.fogColor); // match water.js's underwater backdrop exactly
      scene.background.copy(tCol);
      scene.fog.color.copy(tCol);
      // ~35 m visibility near the surface, thinning deeper; eased off when the subject itself is far from the
      // camera (listen frames a pair 30+ m apart), so the subject never drowns in the haze.
      const focusD = camera.position.distanceTo(focus);
      scene.fog.density = lerp(0.026, 0.011, ss(40, 320, d)) * clamp(26 / Math.max(focusD, 1), 0.5, 1) * (1 - 0.6 * clearW); // patterns: see the whole unit
      domeU.uFog.value.copy(tCol);
      domeU.uUp.value.copy(tCol).lerp(UW_UP, k).multiplyScalar(1 + 0.4 * k);
      domeU.uDown.value.copy(tCol).lerp(UW_DOWN, k * 0.5).multiplyScalar(0.7);
      fbSeaU.uFog.value.copy(tCol);
      fbSeaU.uFogD.value = scene.fog.density;
      scene.environment = (ocean && ocean.underwaterEnvironment) || underEnv || skyEnv;
      // Key: the refracted sun from overhead, blue-white, dying with depth.
      sun.color.setRGB(0.86, 0.92, 0.96); // near-neutral: the water colour comes from fog, not tinted skin
      sun.intensity = 3.2 * k;
      sun.position.copy(focus).addScaledVector(refr, -100);
      hemi.color.setRGB(0.6, 0.68, 0.76); hemi.groundColor.setRGB(0.12, 0.14, 0.16);
      hemi.intensity = 0.15 + 1.1 * k;
      // Fill from above the viewer so dark skin keeps its form; rim from behind/above for silhouettes in the dark.
      fill.color.setRGB(0.66, 0.7, 0.76);
      fill.intensity = 0.25 + 0.35 * k + 0.75 * (1 - k);
      fill.position.copy(cp); fill.position.y += 30;
      camera.getWorldDirection(tD); fill.target.position.copy(cp).addScaledVector(tD, 40);
      rim.color.setRGB(0.62, 0.74, 0.86);
      rim.intensity = lerp(0.4 + 1.6 * (1 - k), 2.4, closeW);
      camera.getWorldDirection(tD);
      rim.position.copy(focus).addScaledVector(tD, 60).add(tE.set(0, 50, 0));
      causticU.uCAmt.value = 7.0 * Math.exp(-d / 60);
      causticU.uCCol.value.setRGB(0.85, 0.95, 1.0);
      whaleMats.forEach((m) => { m.envMapIntensity = 0.12 + 0.3 * k; }); // the blue underwater env was turning whales navy
      renderer.toneMappingExposure = lerp(1.0, 1.3, ss(40, 500, d));
    }
    causticU.uCTime.value = time * 0.55;

    // (faded through the conclusion's descent: a single hard shaft there read as a searchlight)
    const shaftAmt = under && !(ocean && (ocean.lightShafts || ocean.shafts)) ? (1 - ss(10, 140, d)) * (1 - closeW * (0.55 + 0.45 * ss(20, 70, d))) : 0;
    shafts.visible = shaftAmt > 0.01;
    if (shafts.visible) {
      const R = 70;
      for (let i = 0; i < shafts.children.length; i++) {
        const m = shafts.children[i];
        const s = shaftSeeds[i];
        const x = cp.x + ((((s.x - cp.x) % (2 * R)) + 3 * R) % (2 * R)) - R;
        const z = cp.z + ((((s.z - cp.z) % (2 * R)) + 3 * R) % (2 * R)) - R;
        // Axial billboard along the refracted sun ray, hanging from the surface, turned to face the camera.
        const h = m.scale.y;
        tA.set(x + Math.sin(time * 0.2 + s.ph) * 2, 0, z).addScaledVector(refr, h * 0.5);
        m.position.copy(tA);
        sZ.copy(refr).negate();                                   // shaft's long axis (local +Y), toward the surface
        sV.subVectors(cp, tA);
        sX.crossVectors(sZ, sV).normalize();
        sN.crossVectors(sX, sZ);
        tM.makeBasis(sX, sZ, sN);
        m.quaternion.setFromRotationMatrix(tM);
        const near = ss(16, 40, sV.crossVectors(tE.subVectors(cp, tA), sZ).length()); // no giant hard-edged shafts across the lens
        m.material.opacity = 0.085 * near * shaftAmt * s.k * (0.6 + 0.4 * Math.sin(time * 0.7 + s.ph * 3));
      }
    }
    snow.visible = under;
    if (under) {
      snowMat.uniforms.uCam.value.copy(cp);
      snowMat.uniforms.uTime.value = time;
      snowMat.uniforms.uOp.value = 0.35 + 0.4 * ss(10, 200, d);
      snowMat.uniforms.uCol.value.setRGB(0.75, 0.86, 1.0).multiplyScalar(0.5 + 0.5 * Math.exp(-d / 150));
    }
  }

  // ---- Section boundaries (contract v5 continuity) ----
  // scene.js reads the immersive sections' page offsets itself (cached; refreshed on resize and every second)
  // so it can blend across a boundary: while the boundary line between two contiguous sections scrolls from the
  // viewport bottom to its top (u: 0 -> 1; main.js holds the outgoing section at t = 1 and the incoming at t = 0
  // across exactly this span), the camera and every whale present in both shots blend from shot N's end pose
  // to shot N+1's start pose (ease in-out, scroll-driven, so it reverses). Whales only in N+1 rise into place
  // from below; props only in one shot switch at the midpoint, where the camera has left them behind.
  let secEls = null, secShots = [], secAt = -1;
  const secTop = new Float64Array(16), secH = new Float64Array(16);
  function refreshSections(time) {
    if (secAt >= 0 && time - secAt < 1 && time >= secAt) return;
    secAt = time;
    if (!secEls) {
      if (typeof document === 'undefined') { secEls = []; return; }
      secEls = document.querySelectorAll('.whale-hero[data-shot], .whale-scene[data-shot]');
      secShots = Array.prototype.map.call(secEls, (el) => el.dataset.shot);
    }
    const sy = window.scrollY || 0;
    for (let i = 0; i < secEls.length && i < 16; i++) {
      const r = secEls[i].getBoundingClientRect();
      secTop[i] = r.top + sy; secH[i] = r.height;
    }
  }
  const bnd = { a: '', b: '', u: 0 };
  function findBoundary(state) {
    if (!secEls || !secEls.length) return null;
    const vh = window.innerHeight || 1, sy = window.scrollY || 0;
    const i = state.index | 0;
    for (let k = Math.max(0, i - 1); k <= i && k + 1 < secEls.length && k + 1 < 16; k++) {
      if (Math.abs(secTop[k + 1] - (secTop[k] + secH[k])) > 4) continue; // not contiguous (prose between)
      const u = (sy + vh - secTop[k + 1]) / vh;
      if (u > 0 && u < 1) { bnd.a = secShots[k]; bnd.b = secShots[k + 1]; bnd.u = u; return bnd; }
    }
    return null;
  }
  const allWhales = Object.values(whales);
  const snap = [0, 1].map(() => ({
    cam: V(), camQ: new THREE.Quaternion(), vis: new Uint8Array(managed.length),
    wv: new Uint8Array(allWhales.length), wp: allWhales.map(() => V()), wq: allWhales.map(() => new THREE.Quaternion()),
  }));
  function capture(sn) {
    sn.cam.copy(camera.position); sn.camQ.copy(camera.quaternion);
    for (let i = 0; i < managed.length; i++) sn.vis[i] = managed[i].visible ? 1 : 0;
    for (let i = 0; i < allWhales.length; i++) {
      const r = allWhales[i].root;
      sn.wv[i] = r.visible ? 1 : 0; sn.wp[i].copy(r.position); sn.wq[i].copy(r.quaternion);
    }
  }
  function hideAll() {
    for (let i = 0; i < managed.length; i++) managed[i].visible = false;
    for (let i = 0; i < beams.length; i++) beams[i].core.mesh.visible = beams[i].haze.mesh.visible = false;
    for (let i = 0; i < overlapHaze.length; i++) overlapHaze[i].visible = false;
  }
  const _bq = new THREE.Quaternion(), _bq2 = new THREE.Quaternion(), _bx = V(1, 0, 0), _fa = V(), _fb = V(), _fc = V(), _da = V(), _db = V();
  function combine(e) {
    const A = snap[0], B = snap[1];
    // Shared whales' centroid in each shot (the blend's focus).
    let nf = 0;
    _fa.set(0, 0, 0); _fb.set(0, 0, 0);
    for (let i = 0; i < allWhales.length; i++) if (A.wv[i] && B.wv[i]) { _fa.add(A.wp[i]); _fb.add(B.wp[i]); nf++; }
    if (nf) {
      _fa.multiplyScalar(1 / nf); _fb.multiplyScalar(1 / nf);
      // Camera position: the focus travels in a straight line; the camera's offset from it swings around it
      // (direction slerped, distance blended), so the subject never sweeps through the lens.
      _da.subVectors(A.cam, _fa); _db.subVectors(B.cam, _fb);
      const la = _da.length(), lb = _db.length();
      _da.multiplyScalar(1 / Math.max(la, 1e-6)); _db.multiplyScalar(1 / Math.max(lb, 1e-6));
      _bq.setFromUnitVectors(_da, _db);
      // Through the sea surface, swing steep while close (rising: tilt over first, then climb; sinking: close in
      // first, then level out), so the waterline is crossed looking down at the whales, never skimming it.
      let eD = e, eL = e;
      if (A.cam.y < 0 && B.cam.y > 0) { eD = 1 - (1 - e) ** 3; eL = e * e; }
      else if (A.cam.y > 0 && B.cam.y < 0) { eD = e ** 3; eL = 1 - (1 - e) ** 2; }
      _bq2.identity().slerp(_bq, eD);
      camera.position.copy(_da).applyQuaternion(_bq2).multiplyScalar(lerp(la, lb, eL)).add(_fc.lerpVectors(_fa, _fb, e));
    } else camera.position.lerpVectors(A.cam, B.cam, e);
    // Crossing the sea surface: never park within 2 m of the waterline.
    if ((A.cam.y < 0) !== (B.cam.y < 0) && Math.abs(camera.position.y) < 2) camera.position.y = (e < 0.5 ? Math.sign(A.cam.y) : Math.sign(B.cam.y)) * 2;
    camera.quaternion.slerpQuaternions(A.camQ, B.camQ, e);
    if (nf) {
      // Aim: keep the focus on the screen spot that blends between where each shot frames it.
      _da.subVectors(_fa, A.cam).normalize().applyQuaternion(_bq.copy(A.camQ).invert()); // focus dir in camera space
      _db.subVectors(_fb, B.cam).normalize().applyQuaternion(_bq.copy(B.camQ).invert());
      _da.lerp(_db, e).normalize().applyQuaternion(camera.quaternion);                  // where it should be seen
      _fc.sub(camera.position).normalize();                                            // where it is
      camera.quaternion.premultiply(_bq.setFromUnitVectors(_da, _fc));
    }
    for (let i = 0; i < managed.length; i++) {
      const va = A.vis[i], vb = B.vis[i];
      managed[i].visible = !!((va && vb) || (va && e < 0.5) || (vb && e >= 0.5));
    }
    const eY = A.cam.y < 0 && B.cam.y > 0 ? 1 - (1 - e) ** 4 : (A.cam.y > 0 && B.cam.y < 0 ? e ** 3 : e);
    for (let i = 0; i < allWhales.length; i++) {
      const r = allWhales[i].root, va = A.wv[i], vb = B.wv[i];
      if (va && vb) {
        r.position.lerpVectors(A.wp[i], B.wp[i], e);
        // When the camera breaks the surface, the whales lead it (surfacing: backs out of the water before the
        // camera is up there; diving: still logging until the camera is under), so a grazing view of the
        // waterline never hides them.
        if (eY !== e) r.position.y = lerp(A.wp[i].y, B.wp[i].y, eY);
        r.quaternion.slerpQuaternions(A.wq[i], B.wq[i], e);
        // A big climb or descent between the two poses: the head leads (nose up to rise, down to sink).
        const dy = B.wp[i].y - A.wp[i].y;
        const pk = clamp(Math.abs(dy) / 60) * Math.sign(dy) * -0.55 * Math.sin(Math.PI * e);
        if (Math.abs(pk) > 1e-3) r.quaternion.multiply(_bq.setFromAxisAngle(_bx, pk));
        r.visible = true;
      } else if (vb) {
        // Arrives out of the haze: slides in from 45 m further out from the shared focus (or from below if none).
        r.position.copy(B.wp[i]);
        const ar = (1 - e) * (1 - e);
        if (nf) { _da.subVectors(B.wp[i], _fb).setY(0); const l = _da.length(); if (l > 1e-3) r.position.addScaledVector(_da, 45 * ar / l); else r.position.y -= 30 * ar; }
        else r.position.y -= 30 * ar;
        r.quaternion.copy(B.wq[i]);
        r.visible = e > 0.02;
      } else if (va) {
        r.visible = e < 0.5;
      }
    }
  }
  const AERIAL = { open: 1 };
  const CLEAR = { patterns: 1 };

  let lastKey = '';
  const api = {
    depth: 0,
    dim: 0,
    fade: 1,
    shotWeight: 1,     // 1 = settled in the current shot, 0 = at a section boundary's switch point (camera-blend curve)
    blend: 0,          // 0..1 progress through a section boundary blend (0 = none)
    blendFrom: null,   // shot names of that blend
    blendTo: null,
    litSquid: 0,
    frames: 0,
    stats: { bufW: 0, bufH: 0, pr: 0, quality: 1, calls: 0, triangles: 0, medianMs: 0 }, // perf readout
    updates: 0,        // harness: counts update() calls (frames counts draws)
    skipDraw: false,   // harness: pose everything but skip the draw (numeric continuity sweeps)
    whaleModel: 'placeholder',
    propsModel: 'primitive',
    oceanModel: 'fallback',
    tagBone: null,
    camera,
    scene,
    renderer,
    get debugFrame() { return DEBUG_FRAME; },
    anchorRoot(name) { return whales[name] ? whales[name].root : null; }, // harness: a whale's root group
    get closeKeys() { return closeK.slice(); },
    get bloom() { return useBloom; },
    get blowAge() { return blowAge(); },
    get ocean() { return ocean; },
    get tagContact() { return { gap: tagSite.gapMax, lift: tagSite.lift, normal: contact.normal.toArray(), pos: contact.pos.toArray(), skinned: contact.ok }; },
    update(state, dt) {
      if (state.active === false) return;
      const reduced = !!state.reducedMotion;
      // Reduced motion: one still per shot; in the conclusion, one per card, posed at that card's beat.
      const ci = state.card && Number.isFinite(state.card.index) ? state.card.index : -1;
      if (reduced && state.shot === 'close') refreshCloseKeys(state.time || 0);
      const t = reduced ? (state.shot === 'close' ? (ci >= 0 ? closeK[Math.min(ci, 4)] : 0.02) : 0.5) : clamp(state.t || 0);
      const time = reduced ? 4 : (state.time || 0);
      const step = reduced ? 0 : (dt || 0);
      const visible = state.visibility === undefined || state.visibility > 0;
      // Canvas box changes without a window resize (layout switch, layout C's inset stage).
      syncSize();
      // Safe zone (eased by main.js).
      const sf = state.safe;
      if (sf && Number.isFinite(sf.x0) && Number.isFinite(sf.y1) && sf.x1 > sf.x0 && sf.y1 > sf.y0) {
        safe = safeSm.set(sf); // main.js already eases it, and it must ride with the animated frame (no second lag)
        // Centre on the safe zone, kept within the middle 40% of the frame (a degenerate axis uses the default).
        defaultView();
        const fx0 = frameBox.x0, fxw = frameBox.x1 - frameBox.x0, fy0 = frameBox.y0, fyh = frameBox.y1 - frameBox.y0;
        view.tx = clamp((safe.x0 + safe.x1) / 2, fx0 + 0.3 * fxw, fx0 + 0.7 * fxw);
        view.ty = clamp((safe.y0 + safe.y1) / 2, fy0 + 0.3 * fyh, fy0 + 0.7 * fyh);
      } else {
        safe = null;
        defaultView();
      }
      // The frame follows main.js exactly (it is the CSS clip); the composition centre is eased on top of it but
      // rides along with any frame motion, so the subject moves with the frame as the inset animates.
      const fr = state.frame;
      let frameMoved = false, frameJump = false;
      if (fr && Number.isFinite(fr.x0) && fr.x1 - fr.x0 > 0.05 && fr.y1 - fr.y0 > 0.05) {
        const dx = (fr.x0 + fr.x1 - frameBox.x0 - frameBox.x1) / 2, dy = (fr.y0 + fr.y1 - frameBox.y0 - frameBox.y1) / 2;
        if (Math.abs(fr.x0 - frameBox.x0) + Math.abs(fr.x1 - frameBox.x1) + Math.abs(fr.y0 - frameBox.y0) + Math.abs(fr.y1 - frameBox.y1) > 1e-5) {
          frameBox.x0 = fr.x0; frameBox.y0 = fr.y0; frameBox.x1 = fr.x1; frameBox.y1 = fr.y1;
          // A mode switch (hero canvas <-> scene stage, v7: no morph) jumps the frame: snap the composition with it.
          if (Math.abs(dx) + Math.abs(dy) > 0.12) frameJump = true;
          view.cx += dx; view.cy += dy; frameMoved = true;
        }
      } else if (frameBox.x0 || frameBox.y0 || frameBox.x1 !== 1 || frameBox.y1 !== 1) {
        frameBox.x0 = frameBox.y0 = 0; frameBox.x1 = frameBox.y1 = 1; frameMoved = true;
      }
      if (frameMoved || Math.abs(view.tx - view.cx) > 1e-4 || Math.abs(view.ty - view.cy) > 1e-4) {
        const k = reduced || !step || api.noSmooth || frameJump ? 1 : 1 - Math.exp(-step * 5);
        view.cx += (view.tx - view.cx) * k; view.cy += (view.ty - view.cy) * k;
        applyViewOffset();
        dirty = true;
      }
      if (frameMoved) syncSize(); // re-place / re-size the canvas to the new frame window this same frame
      if (reduced) {
        const key = `${state.shot}|${ci}|${visible}|${size.w}x${size.h}|${view.cx.toFixed(3)}`;
        if (key === lastKey && !dirty) return;
        lastKey = key;
      }
      now.time = time;
      frameId++;
      snapAnim = reduced;
      if (state.shot !== curShot) { curShot = state.shot; shotT0 = time; if (curShot === 'listen') listenBlown = false; prevT = t; }
      if (curShot === 'open' && api.whaleModel !== 'glb') shotT0 = time; // the hero's clock starts once the whale is on screen
      since = state.since != null ? +state.since : (reduced ? 3.4 : time - shotT0);
      if (reduced) { openSurfaced = true; }
      blowAgeOverride = state.blowAge != null ? +state.blowAge : (reduced ? 0.9 : null);
      if (state.since != null && curShot === 'open') { blowT0 = time - (since - BLOW_AT); blowWhale = since >= BLOW_AT ? whales.whaleA : null; }

      api.updates++;
      api.lastState = state; // harness: the state object main.js passed (by reference)
      refreshSections(time);
      const bd = reduced || state.view ? null : findBoundary(state);
      let r, aerialW, closeW, clearW;
      hideAll();
      if (bd && SHOTS[bd.a] && SHOTS[bd.b]) {
        // Smoothstep, not the cubic ease: half the peak speed, so big swings (patterns -> close) read as one
        // deliberate camera move spread over the whole span.
        const e = bd.u * bd.u * (3 - 2 * bd.u);
        const rA = SHOTS[bd.a](1, time, step, null);
        const dA = rA.depth, mA = rA.dim;
        capture(snap[0]);
        hideAll();
        const rB = SHOTS[bd.b](0, time, step, null);
        capture(snap[1]);
        combine(e);
        r = blendR; r.depth = lerp(dA, rB.depth, e); r.dim = lerp(mA, rB.dim, e);
        aerialW = lerp(AERIAL[bd.a] || 0, AERIAL[bd.b] || 0, e);
        clearW = lerp(CLEAR[bd.a] || 0, CLEAR[bd.b] || 0, e);
        closeW = lerp(bd.a === 'close' ? 1 : 0, bd.b === 'close' ? 1 : 0, e);
        api.blend = bd.u; api.blendFrom = bd.a; api.blendTo = bd.b;
        // overlays: shotWeight follows the camera blend (1 settled in a shot, 0 at the switch point, mid-span);
        // fade stays 1: there is no fade-through-black any more.
        api.shotWeight = Math.abs(1 - 2 * e);
        api.fade = 1;
      } else {
        const fn = SHOTS[state.shot] || shotOpen;
        r = fn(t, time, step, state.view);
        aerialW = AERIAL[state.shot] || 0;
        clearW = CLEAR[state.shot] || 0;
        closeW = state.shot === 'close' ? 1 : 0;
        api.blend = 0; api.blendFrom = api.blendTo = null; api.fade = 1; api.shotWeight = 1;
      }
      prevT = t;
      api.depth = r.depth;
      api.dim = r.dim;
      veilMat.opacity = reduced || state.view ? 0 : r.dim * 0.4; // a light dim: data shots stay readable without going murky
      veil.visible = veilMat.opacity > 0.002;
      renderCam.position.copy(camera.position); renderCam.quaternion.copy(camera.quaternion); renderCam.updateMatrixWorld();
      updateEnvironment(time, aerialW, closeW, clearW);
      scene.updateMatrixWorld();
      if (!visible || api.skipDraw) { dirty = true; return; } // poses/camera stay current for project(); skip the draw
      dirty = false;
      api.frames++;
      trackFrame(dt);
      renderer.info.reset();
      // Bloom only where it earns its cost: the conclusion's beams and the hero's sun. Elsewhere a plain render.
      if (useBloom && composer && (closeW > 0.01 || aerialW > 0.5)) {
        bloom.strength = lerp(0.16, 0.22, closeW);
        composer.render(step);
      } else {
        renderer.render(scene, renderCam);
      }
      api.stats.calls = renderer.info.render.calls; api.stats.triangles = renderer.info.render.triangles;
      api.stats.bufW = Math.round(buf.w * buf.pr); api.stats.bufH = Math.round(buf.h * buf.pr); api.stats.pr = Math.round(buf.pr * 100) / 100;
      api.stats.quality = quality;
    },
    project(name) {
      const o = anchors[name];
      if (!o) return { x: 0, y: 0, visible: false, scale: 0 };
      let shown = true;
      for (let p = o; p; p = p.parent) if (!p.visible) { shown = false; break; }
      o.getWorldPosition(tA);
      right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      tB.copy(tA).add(right);
      tA.project(camera); // projectionMatrix includes the view offset, so CSS px below match the canvas
      tB.project(camera);
      const x = ((tA.x + 1) / 2) * size.w;
      const y = ((1 - tA.y) / 2) * size.h;
      const x2 = ((tB.x + 1) / 2) * size.w;
      const y2 = ((1 - tB.y) / 2) * size.h;
      const inFront = tA.z > -1 && tA.z < 1;
      const onScreen = x > -40 && x < size.w + 40 && y > -40 && y < size.h + 40;
      return { x, y, visible: shown && inFront && onScreen, scale: inFront ? Math.hypot(x2 - x, y2 - y) : 0 };
    },
  };
  // debug/harness handle: only with ?debug (scene-test.html opts in the same way)
  if (typeof window !== 'undefined' && /[?&]debug\b/.test(window.location.search) && !window.__sceneApi) window.__sceneApi = api;
  return api;
}

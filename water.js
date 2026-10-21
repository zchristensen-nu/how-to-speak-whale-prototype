/*
 * water.js — open-ocean surface + sky for the whale scroll (contract v3, owner: water)
 *
 * INTERFACE
 *   import { createOcean } from './water.js';
 *   const ocean = createOcean({ renderer, scene, camera, quality });   // quality: 'high' | 'low'
 *   ocean.update(time, camera);        // once per frame BEFORE rendering; no allocations
 *   ocean.sunDirection                 // THREE.Vector3, unit, points TOWARD the sun (read/write; .set() or assign)
 *   ocean.environment                  // PMREM texture of the sky (+ ocean below the horizon) → scene.environment
 *   ocean.surfaceHeightAt(x, z, time)  // metres; matches the GPU displacement (same waves, same distance fade)
 *   ocean.dispose()
 *
 * EXTRAS (optional, for art direction)
 *   createOcean({ ..., waves })  // override DEFAULT_WAVES ([wavelength m, amplitude m, heading deg, chop])
 *   ocean.surfaceNormalAt(x, z, time, target)  // unit normal of the swell at x,z (for tilting the boat/buoy)
 *   ocean.sunColor            // THREE.Color, linear, max channel 1: sun after atmospheric extinction (key light)
 *   ocean.horizonColor        // THREE.Color, linear: sky at the horizon in the camera's look azimuth
 *   ocean.fogColor            // THREE.Color: horizonColor above water; underwater fog colour at camera depth below
 *   ocean.depthStops          // [[0,c],[15,c],[40,c],[150,c],[600,c]] live THREE.Colors (linear): the level-view
 *                             //   underwater colour at each depth, interpolated in log space. v4 "moody navy"
 *                             //   defaults are back-solved through AgX to display #0c4466 / #062d4a / #04213a /
 *                             //   #021120 / #010306. Looking up/down applies a per-channel gradient fitted to
 *                             //   #1a5a7e (45° up) and #08344f (45° down).
 *   ocean.underwaterColor     // = depthStops[0][1] (0 m)      ocean.deepColor = depthStops[3][1] (150 m)
 *   ocean.underwaterEnvironment // PMREM of the underwater light field (blue, bright from above) for whale envMaps
 *   ocean.isUnderwater        // boolean: camera below the LOCAL wave surface (set in update())
 *   ocean.cameraDepth         // metres below y=0 (0 when above)
 *   ocean.mesh / ocean.sky    // the surface mesh and sky dome (createOcean adds both to `scene`)
 *   ocean.params              // live tunables, see below
 *
 * TUNABLES (ocean.params.*, all live; sky ones re-bake the environment on the next update())
 *   amplitude      1.0    swell height multiplier (1.0 ≈ significant wave height 1.5 m; 0.5 = glassy calm)
 *   choppiness     1.0    horizontal Gerstner displacement (crest sharpening)
 *   detail         1.0    ripple slope strength: glitter width above, crinkle below (Cox–Munk ≈ 3 m/s wind)
 *   sunIntensity   1.8    sun irradiance in sky-radiance units (glitter, crest scattering, the sun in Snell's window)
 *   skyExposure    0.28   scales the Preetham sky (the renderer stays at exposure 1 with ACES)
 *   skyGamma 1.5, skySaturation 1.5 (tint 0.7/0.94/1.4: moody, less sunny)   contrast/saturation grade on the sky (Preetham alone is milky)
 *   turbidity 1.7, rayleigh 2.5, mieCoefficient 0.0012, mieDirectionalG 0.93
 *   horizonFog     5000   m, aerial-perspective distance blending the far sea into the horizon sky
 *   underwaterVisibility 55 m, e-folding distance of the underwater haze over the ceiling
 *   refraction     true ('high') / false ('low')  see-through surface: a half-res colour+depth pass of the scene
 *                  (ocean + sky hidden; full res up to ~2.3 MP targets, else half; params.refractionScale overrides) rendered
 *                  from the surface's onBeforeRender, sampled with swell/ripple
 *                  distortion and absorbed toward the body colour (uniforms.uAbsorb, per metre, default
 *                  (0.36, 0.16, 0.10): clear for the first few metres, gone by ~15 m). From below, objects
 *                  above the waterline show through Snell's window. Skipped when the camera is >150 m up
 *                  or >40 m down. Costs one extra half-res render of the scene per frame.
 *   bodyColor, scatterColor   THREE.Color (live): upwelling deep-water colour from above / backlit-crest colour
 *   uniforms                  the raw ShaderMaterial uniforms (uWindowTint, uMirrorTint, uFocus, uSpecClamp…)
 *
 * SUN: default 12° elevation, azimuth 164° (direction ≈ (0.27, 0.21, -0.94): ahead and slightly right of a
 *   camera looking down -Z). The disc is drawn by the dome; the glitter is analytic, never from the env map.
 *
 * WAVE SET (DEFAULT_WAVES): 8 Gerstner trains, wavelengths 6–120 m, non-harmonic, spread ±70° around the
 *   swell heading (SWELL_HEADING), deep-water dispersion ω = √(gk), random phases (fixed seed). ΣA² gives
 *   Hs ≈ 1.5 m: a gentle open-ocean swell. Normals are analytic per pixel (no faceting). The fine ripples
 *   are three scrolling layers of two FFT-synthesised, tileable slope maps generated at init (no image
 *   files; RGBA16F with a hand-built mip chain that stores slope AND slope²). Waves the mesh or the pixel
 *   cannot resolve are faded out and their slope variance moves into the specular roughness (LEAN), so
 *   the far field never aliases or tiles: sparkles merge into a glitter path, as in photographs.
 *
 * RENDERING NOTES FOR SCENE
 *   - v4 colours are tuned for renderer.toneMapping = AgXToneMapping, exposure 1, sRGB output (ACES still
 *     works but reads more saturated/violet).
 *     Both materials include tonemapping/colorspace chunks, so they work with or without EffectComposer.
 *   - The surface is one double-sided mesh (see-through near objects when params.refraction is on): front faces shade as seen from air, back faces as
 *     seen from water (Snell's window, total internal reflection, refracted sun). There is no seam at y=0.
 *   - The sky dome draws at the far plane after opaque objects (renderOrder 1000). When the camera is
 *     below the surface it draws the underwater background gradient instead of the sky, so scene does
 *     NOT need its own background either way. Its colour at horizontal = ocean.fogColor.
 *   - Neither material uses three's fog. Scene's own objects should use scene.fog.color = ocean.fogColor
 *     (copy each frame) so they melt into the same horizon / underwater haze.
 *   - Changing sunDirection or the sky params re-bakes the environment (≈2 ms CPU + GPU). Fine on a
 *     scroll event, avoid every frame.
 *   - Requires WebGL2 (GLSL 3: textureLod/transpose/RGBA16F filtering), which three 0.160 uses by default.
 *   - Geometry: one camera-centred radial grid (high: 320 × ~270 rings ≈ 86k verts; low: 128 × ~90 ≈ 11k),
 *     radius 0.86 × camera.far plus a horizon skirt; built once from camera.far at creation.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// [wavelength m, amplitude m, direction (deg, relative to swell heading), chop 0..1]
export const DEFAULT_WAVES = [
  [120.0, 0.380, 0, 1.0],
  [79.0, 0.270, 17, 1.0],
  [53.0, 0.190, -24, 1.0],
  [34.0, 0.120, 38, 1.0],
  [22.0, 0.075, -45, 1.0],
  [14.5, 0.050, 62, 1.0],
  [9.3, 0.032, -70, 1.0],
  [6.1, 0.021, 12, 1.0],
];
const NWAVES = 8;
const SWELL_HEADING = 0.35; // rad, direction the swell travels (x→z)
const G = 9.81;

// Default sun: low warm morning sun, 12° above the horizon, roughly toward -Z (scene's v2 azimuth).
const SUN_ELEVATION_DEG = 12;
const SUN_AZIMUTH_DEG = 164; // compass-style: 180° = -Z, 90° = +X (see sunFromAngles)

function sunFromAngles(elevDeg, azDeg, out) {
  const e = THREE.MathUtils.degToRad(elevDeg), a = THREE.MathUtils.degToRad(azDeg);
  // azimuth 180° = -Z; 90° = +X
  return out.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).normalize();
}

// GLSL chunks
const GLSL_UNDER = /* glsl */`
uniform vec3 uUnderColor;   // depth stops (linear, pre-tone-map): 0 m
uniform vec3 uStop15;       // 15 m
uniform vec3 uStop40;       // 40 m
uniform vec3 uDeepColor;    // 150 m
uniform vec3 uAbyssColor;   // 600 m and below
uniform float uCamDepth;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
vec3 underBase() {
  float d = uCamDepth;
  // log-space interpolation between the depth stops (level view colour at that depth)
  vec3 a = uUnderColor, b = uStop15; float t = d / 15.0;
  if (d > 15.0) { a = uStop15; b = uStop40; t = (d - 15.0) / 25.0; }
  if (d > 40.0) { a = uStop40; b = uDeepColor; t = (d - 40.0) / 110.0; }
  if (d > 150.0) { a = uDeepColor; b = uAbyssColor; t = (d - 150.0) / 450.0; }
  t = clamp(t, 0.0, 1.0);
  return exp(mix(log(max(a, 1e-5)), log(max(b, 1e-5)), t));
}
// Underwater light field seen along dir (unit). Brighter toward the surface, dark below, a soft glow
// around the refracted sun.
vec3 underBg(vec3 dir) {
  vec3 base = underBase();
  float up = dir.y;
  // per-channel gradient fitted to the v4 targets (45° up #1a5a7e, level #0c4466, 45° down #08344f)
  vec3 g = up >= 0.0 ? mix(vec3(1.0), vec3(1.27, 2.06, 2.02), pow(up, 1.3)) : mix(vec3(1.0), vec3(0.91, 0.59, 0.50), pow(-up, 0.7));
  float sinA = sqrt(max(1.0 - uSunDir.y * uSunDir.y, 0.0)) / 1.333;
  vec2 hz = uSunDir.xz / max(length(uSunDir.xz), 1e-4);
  vec3 Lu = vec3(hz.x * sinA, sqrt(1.0 - sinA * sinA), hz.y * sinA);
  float sg = max(dot(dir, Lu), 0.0);
  float glow = (0.3 * pow(sg, 5.0) + 0.8 * pow(sg, 40.0)) * exp(-uCamDepth / 45.0);
  vec3 glowCol = base * vec3(1.6, 2.4, 2.6); // cool, water-tinted (a warm glow reads violet under AgX)
  return base * g + glowCol * glow;
}
`;

const SKY_PARS = /* glsl */`
uniform float uExposure;
uniform float uSkyGamma;
uniform float uSkySat;
uniform vec3 uSkyTint;
uniform float uSunDisk;
uniform float uUnder;
uniform float uLowerOcean;
uniform vec3 uEnvBody;
`;

// Build the sky fragment shader from three's Sky.SkyShader (Preetham), turning its main() into a
// function so it can be evaluated for any direction, and adding: exposure, a sun-disc switch (the env
// bake leaves the disc out; the water shader draws the sun analytically), an ocean lower hemisphere
// for the env bake, and an underwater mode for the visible dome.
function buildSkyFragment() {
  let src = Sky.SkyShader.fragmentShader;
  const cut = src.indexOf('gl_FragColor');
  if (cut < 0) throw new Error('water.js: unexpected Sky.js shader');
  src = src.slice(0, cut) + 'return retColor;\n}\n';
  src = src.replace('void main() {', 'vec3 skyColor( vec3 direction ) {');
  src = src.replace('vec3 direction = normalize( vWorldPosition - cameraPosition );', '');
  src = src.replace('L0 += ( vSunE * 19000.0 * Fex ) * sundisk;', 'L0 += ( vSunE * 19000.0 * Fex ) * sundisk * 0.0;');
  return SKY_PARS + GLSL_UNDER + src + /* glsl */`
uniform vec3 sunPosition;
// Grade: a contrast curve around a 0.5 pivot (Preetham's 1/2.4 power leaves the sky milky), then a
// soft shoulder so the aureole stays under the bloom threshold; only the disc and the glitter bloom.
vec3 skyGrade( vec3 c, vec3 dir ) {
  c = pow( max( c, 0.0 ) * 2.0, vec3( uSkyGamma ) ) * 0.5;
  // Preetham reddens the whole low sky at a low sun (a sunset 'belt'); keep it only on the sun side
  c.r = mix( c.r, min( c.r, c.g * 0.92 ), smoothstep( 0.5, -0.3, dot( dir, normalize( sunPosition ) ) ) );
  // v4 moody grade: the low sky (except right around the sun) goes cool grey-blue (#7f95a5 family); AgX
  // otherwise turns Preetham's pale horizon mauve
  float hl = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  float hw = ( 1.0 - smoothstep( 0.0, 0.3, abs( dir.y ) ) ) * ( 1.0 - smoothstep( 0.75, 0.97, dot( dir, normalize( sunPosition ) ) ) );
  c = mix( c, hl * vec3( 0.8, 1.02, 1.24 ), hw * 0.85 );
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = max( mix( vec3( l ), c, uSkySat ), 0.0 ) * uSkyTint;
  // shoulder on luminance (keeps the warm hue of the aureole instead of clipping it to white)
  float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  float sl = lum > 0.42 ? 0.42 + 0.4 * ( 1.0 - exp( -( lum - 0.42 ) / 0.4 ) ) : lum;
  return c * ( sl / max( lum, 1e-5 ) );
}
void main() {
  vec3 dir = normalize( vWorldPosition - cameraPosition );
  vec3 col;
  if ( uUnder > 0.5 ) {
    col = underBg( dir );
  } else if ( uLowerOcean > 1.5 && dir.y < 0.0 ) {
    // reflection bake: the lower hemisphere mirrors the sky, so blurred lookups near the horizon stay sky
    vec3 md = vec3( dir.x, -dir.y, dir.z );
    col = skyGrade( skyColor( md ) * uExposure, md );
    gl_FragColor = vec4( col, 1.0 );
    return;
  } else if ( uLowerOcean > 0.5 && dir.y < 0.0 ) {
    // env bake only: what the sea looks like from above, so whales get dark-blue bounce from below
    vec3 m = vec3( dir.x, -dir.y, dir.z );
    float f = 0.02 + 0.98 * pow( 1.0 - (-dir.y), 5.0 );
    vec3 sm = skyGrade( skyColor( m ) * uExposure, m );
    col = sm * f + uEnvBody * ( 1.0 - f );
    gl_FragColor = vec4( col, 1.0 );
    return;
  } else {
    col = skyColor( dir ) * uExposure;
  }
  if ( uUnder < 0.5 ) {
    col = skyGrade( col, dir );
    // sun disc, drawn here (not by Preetham) so it stays out of the env bake and anti-aliases
    float ct = dot( dir, normalize( sunPosition ) );
    col += uSunColor * uSunDisk * 60.0 * smoothstep( 0.999950, 0.999968, ct );
  }
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
}

const WATER_COMMON = /* glsl */`
#define NWAVES ${NWAVES}
uniform vec4 uWaveA[NWAVES];   // dir.x, dir.z, k, amplitude
uniform vec4 uWaveB[NWAVES];   // omega, phase, chop, 0
uniform float uTime;
uniform float uAmp;
uniform float uChop;
uniform float uCellK;
uniform float uRmain;
varying vec3 vWorld;
varying vec2 vXZ0;
varying float vSkirt;
varying float vR;
`;

const WATER_VERT = WATER_COMMON + /* glsl */`
void main() {
  vec2 off = position.xz;
  float skirt = position.y;
  vec2 xz0 = cameraPosition.xz + off;
  float r = length(off);
  vec3 p = vec3(xz0.x, 0.0, xz0.y);
  if (skirt > 0.5) {
    // Skirt ring: lifted to (almost) the camera height far away, so its outer edge sits on the
    // horizon line. Covers the gap between the end of the grid and the true horizon at any height.
    p.y = cameraPosition.y > 0.0 ? cameraPosition.y * (1.0 - r * 1.0e-7) : 0.0;
  } else {
    float cell = r * uCellK;
    for (int i = 0; i < NWAVES; i++) {
      vec4 a = uWaveA[i];
      vec4 b = uWaveB[i];
      float lambda = 6.2831853 / a.z;
      float fade = 1.0 - smoothstep(0.12 * lambda, 0.25 * lambda, cell);
      float th = a.z * dot(a.xy, xz0) - b.x * uTime + b.y;
      float A = a.w * uAmp * fade;
      p.y += A * cos(th);
      p.xz -= a.xy * (A * uChop * b.z * sin(th));
    }
  }
  vWorld = p;
  vXZ0 = xz0;
  vSkirt = skirt;
  vR = r;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const WATER_FRAG = WATER_COMMON + GLSL_UNDER + /* glsl */`
uniform sampler2D uDetailA;
uniform sampler2D uDetailB;
uniform vec4 uDetA;          // scale (1/tile m), cos, sin, strength
uniform vec4 uDetB;
uniform vec4 uDetC;
uniform vec4 uDetOffAB;      // uv offsets A.xy, B.xy
uniform vec2 uDetOffC;
uniform sampler2D uEnv;      // PMREM (cube-UV) of the sky, lower hemisphere mirrored
#include <cube_uv_reflection_fragment>
uniform float uSunIntensity;
uniform vec3 uBodyColor;
uniform vec3 uScatterColor;
uniform float uFogDist;
uniform float uM2Min;
uniform float uCrestScale;
uniform float uUnderVis;
uniform vec3 uWindowTint;
uniform vec3 uMirrorTint;
uniform float uSpecClamp;
uniform float uFocus;
// refraction (scene colour + depth without the ocean, half res, rendered just before the surface draws)
uniform sampler2D uRefrColor;
uniform sampler2D uRefrDepth;
uniform float uRefrOn;
uniform vec2 uRes;
uniform float uNear;
uniform float uFar;
uniform vec3 uAbsorb;
uniform float uRefrDistort;
float refrViewZ(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
// Look up what lies behind the surface along (approximately) the refracted ray. Returns the object's
// view-space depth in .a (-1 when only empty water / sky lies behind).
vec4 refrSample(vec2 offset, float wz, vec2 jitter) {
  vec2 uv0 = gl_FragCoord.xy / uRes + jitter;
  vec2 uv = uv0 + offset;
  float d = textureLod(uRefrDepth, uv, 0.0).r;
  float oz = refrViewZ(d);
  if (oz < wz) { uv = uv0; d = textureLod(uRefrDepth, uv, 0.0).r; oz = refrViewZ(d); } // don't pull in foreground
  if (d > 0.99999 || oz <= wz) return vec4(0.0, 0.0, 0.0, -1.0);
  return vec4(textureLod(uRefrColor, uv, 0.0).rgb, oz);
}

vec2 detail(sampler2D tex, vec4 P, vec2 offs, vec2 xz, out float var) {
  mat2 R = mat2(P.y, P.z, -P.z, P.y);
  vec4 t = texture(tex, (R * xz) * P.x + offs, -0.6); // slight negative LOD bias: crisper ripples (LEAN keeps it alias-free)
  var = max(t.b - dot(t.rg, t.rg), 0.0) * P.w * P.w;
  return (transpose(R) * t.rg) * P.w;
}

float G1(float x, float k) { return x / (x * (1.0 - k) + k); }

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // pixel footprint on the undisplaced plane (m), for filtering the analytic waves
  float foot = max(length(dFdx(vXZ0)), length(dFdy(vXZ0)));

  // --- Gerstner: analytic tangent frame at this fragment, under-resolved waves → roughness
  vec3 T = vec3(1.0, 0.0, 0.0);
  vec3 B = vec3(0.0, 0.0, 1.0);
  float extraVar = 0.0;
  float cell = vR * uCellK;
  for (int i = 0; i < NWAVES; i++) {
    vec4 a = uWaveA[i];
    vec4 b = uWaveB[i];
    float lambda = 6.2831853 / a.z;
    float w = 1.0 - smoothstep(0.25 * lambda, 1.0 * lambda, foot);
    float th = a.z * dot(a.xy, vXZ0) - b.x * uTime + b.y;
    float s = sin(th), c = cos(th);
    float A = a.w * uAmp;
    float kA = a.z * A;
    float q = uChop * b.z * kA * c * w;
    float h = kA * s * w;
    T += vec3(-q * a.x * a.x, -h * a.x, -q * a.x * a.y);
    B += vec3(-q * a.x * a.y, -h * a.y, -q * a.y * a.y);
    extraVar += 0.5 * kA * kA * (1.0 - w * w);
  }
  vec3 Ng = normalize(cross(B, T));
  vec2 sG = -Ng.xz / Ng.y;

  // --- ripples: three scrolling slope layers with mip-averaged variance (LEAN)
  float vA, vB, vC;
  vec2 sA = detail(uDetailA, uDetA, uDetOffAB.xy, vXZ0, vA);
  vec2 sB = detail(uDetailB, uDetB, uDetOffAB.zw, vXZ0, vB);
  vec2 sC = detail(uDetailB, uDetC, uDetOffC, vXZ0, vC);
  vec2 sd = sA + sB + sC;
  vec2 sl = sG + sd;
  // (scene-v6d guard) mip-averaged slope variance can come out slightly negative under low-precision / software
  // filtering: keep m2 >= the floor so sqrt()/divisions below never produce NaN.
  float m2 = max(uM2Min + extraVar + vA + vB + vC, max(uM2Min, 1e-5));
  vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));

  vec3 L = uSunDir;
  vec3 sunE = uSunColor * uSunIntensity * smoothstep(-0.03, 0.06, L.y);
  float m = sqrt(m2);
  vec3 col;

  // horizon colour in this azimuth (fog target above water)
  vec3 hdir = normalize(vec3(-V.x, 0.0, -V.z));
  // aerial-perspective colour: the horizon sky for grazing rays; azimuth-averaged for steep ones (the
  // horizon's narrow sun-side glow must not paint a streak when looking down from a height)
  vec3 hz = textureCubeUV(uEnv, hdir, mix(0.12, 1.0, smoothstep(0.03, 0.4, V.y))).rgb;

  if (gl_FrontFacing) {
    // seen from the air
    float NdV = max(dot(N, V), 1e-3);
    float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
    // rough surfaces reflect less at grazing (the facets tilted away are hidden)
    F *= mix(1.0, 0.75, smoothstep(0.02, 0.3, m) * pow(1.0 - NdV, 3.0));
    vec3 R = reflect(-V, N);
    R.y = abs(R.y) + 0.002;
    // PMREM roughness ~ sqrt(Beckmann m): GGX-prefiltered, seamless, widens with distance (LEAN variance)
    vec3 sky = textureCubeUV(uEnv, normalize(R), clamp(sqrt(m) * 0.9, 0.0, 1.0)).rgb;
    vec3 skyUp = textureCubeUV(uEnv, vec3(0.0, 1.0, 0.0), 1.0).rgb;

    // water body (upwelling light) + subsurface scattering through the backlit crests
    vec3 body = uBodyColor * (skyUp + sunE * max(L.y, 0.0) * 0.5);
    float crest = clamp(vWorld.y * uCrestScale * 0.5 + 0.5, 0.0, 1.0);
    float back = pow(max(dot(L, -V), 0.0), 4.0) * pow(max(0.5 - 0.5 * dot(L, N), 0.0), 3.0);
    vec3 scatter = uScatterColor * (sunE * (2.2 * crest * crest * back + 0.07 * crest * max(dot(N, L), 0.0))
                 + skyUp * 0.25 * crest * crest);

    // sun glitter: Beckmann over the filtered slope distribution (Bruneton-style)
    vec3 H = normalize(L + V);
    vec2 sh = -H.xz / max(H.y, 1e-3) - sl;
    float D = exp(-dot(sh, sh) / m2) / (3.14159265 * m2 * pow(max(H.y, 1e-3), 4.0));
    float FH = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
    float k = m * 0.7979;
    float Gs = G1(NdV, k) * G1(max(dot(N, L), 0.0), k);
    vec3 spec = sunE * FH * D * Gs / (4.0 * NdV);
    spec = min(spec, vec3(uSpecClamp));

    // see-through water: the submerged scene (whales) absorbed toward the body colour with path length
    vec3 waterCol = body;
    if (uRefrOn > 0.5) {
      float wz = -(viewMatrix * vec4(vWorld, 1.0)).z;
      // distort by the swell + broad ripples only: a smooth wobble, not a crumbly edge
      // 4 taps one full-res pixel apart, each resolved (object absorbed / empty water) BEFORE averaging:
      // a depth-aware resolve of the half-res pass, so silhouettes come out anti-aliased, not stair-stepped
      vec2 off = (sG + sA) * uRefrDistort / max(dist, 2.0);
      vec3 acc = vec3(0.0);
      for (int k = 0; k < 4; k++) {
        vec2 j = vec2((k == 0 || k == 2) ? -1.6 : 1.6, k < 2 ? -0.6 : 0.6) * mat2(0.8, 0.6, -0.6, 0.8) / uRes; // rotated grid: water blurs what is under it
        vec4 r = refrSample(off + j, wz, j);
        vec3 c = body;
        if (r.a > 0.0) {
          float objDist = dist * r.a / wz;
          float path = objDist - dist;                     // metres of water along the view ray
          vec3 objPos = cameraPosition - V * objDist;
          float below = max(vWorld.y - objPos.y, 0.0);     // depth of the object under this crest
          vec3 Tv = exp(-uAbsorb * path);
          vec3 Tl = exp(-uAbsorb * below * 0.5);           // sunlight already dimmed on its way down
          c = r.rgb * Tl * Tv + body * (1.0 - Tv);
        }
        acc += c;
      }
      waterCol = acc * 0.25;
    }
    col = F * sky + (1.0 - F) * (waterCol + scatter) + spec;

    // waterline contact: a thin broken foam/wet line where an object pierces the surface
    if (uRefrOn > 0.5) {
      float wz0 = -(viewMatrix * vec4(vWorld, 1.0)).z;
      float d0 = textureLod(uRefrDepth, gl_FragCoord.xy / uRes, 0.0).r;
      if (d0 < 0.99999) {
        float gap = abs(refrViewZ(d0) - wz0) * dist / wz0;   // metres between surface and object along the ray
        float foam = 1.0 - smoothstep(0.04, 0.5, gap);
        float brk = smoothstep(-0.02, 0.06, dot(sB + sC, vec2(0.8, 0.6)) + 0.03);
        vec3 foamCol = skyUp * 1.6 + sunE * max(L.y, 0.0) * 0.55;
        col = mix(col, foamCol, foam * brk * 0.6 * (1.0 - smoothstep(30.0, 80.0, dist)));
      }
    }

    float fogF = 1.0 - exp(-dist / uFogDist);
    fogF = max(fogF, smoothstep(uRmain * 0.6, uRmain, vR));
    if (vSkirt > 0.5) fogF = 1.0;
    col = mix(col, hz, fogF);
  } else {
    // seen from below
    vec3 I = -V;               // camera → surface (upward)
    vec3 Nd = -N;              // normal facing the camera
    vec3 Tr = refract(I, Nd, 1.333);
    float tir = step(dot(Tr, Tr), 1e-6);
    float cosT = max(dot(Tr, N), 0.0);
    float Fw = mix(0.02 + 0.98 * pow(1.0 - cosT, 5.0), 1.0, tir);
    vec3 Rr = reflect(I, Nd);
    // TIR mirror: reflects the deep, plus a cyan-silver sheen (the look reference's bright underside)
    vec3 base = underBase();
    // The cyan-silver sheen lives only near Snell's window (crinkles throw window light into it); toward
    // the horizon the ceiling is a plain TIR mirror of the deep and then melts into the haze (no seam).
    float upness = I.y;                                    // cos of the angle from straight up
    float sheenW = smoothstep(0.30, 0.64, upness);         // full by ~50°, gone by ~72° from vertical
    // TIR band: reads a touch brighter than level water (#134b6e target), never a dark seam
    vec3 refl = underBg(normalize(vec3(Rr.x, abs(Rr.y) * 0.5, Rr.z))) * 1.15 + uMirrorTint * dot(base, vec3(0.2126, 0.7152, 0.0722)) * 6.0 * sheenW;
    // Snell's window: the whole sky squeezed into a ~97° cone, slightly blurred by the ripples
    vec3 Tsafe = tir > 0.5 ? vec3(0.0, 1.0, 0.0) : normalize(vec3(Tr.x, max(Tr.y, 0.002), Tr.z));
    vec3 trans = textureCubeUV(uEnv, Tsafe, clamp(sqrt(m * 0.5), 0.0, 1.0)).rgb * uWindowTint;
    // the sun through the window: refracted-direction lobe (refraction bends ~1/3 as much as reflection)
    float m2t = m2 * 0.12 + 4e-5;
    float ct = max(dot(Tsafe, L), 0.0);
    float lobe = exp(-2.0 * (1.0 - ct) / m2t) / (3.14159265 * m2t);
    vec3 sunT = min(sunE * lobe * 0.06, vec3(uSpecClamp)) * (1.0 - tir);
    // brightness flicker: the surface focuses light as it moves
    float flick = (1.0 + 0.05 * sin(uTime * 11.0) * sin(uTime * 7.3 + 1.3)) * clamp(1.0 + uFocus * mix(1.0, 0.35, 1.0 - Fw) * dot(sA + 0.5 * sB + sG, normalize(L.xz + 1e-4)), 0.55, 1.8);
    // the crinkle reads as relief lit from the window side (mip-filtered, so it never sparkles into noise)
    if (uRefrOn > 0.5 && tir < 0.5) {
      // things above the waterline seen through Snell's window (instead of being clipped by the ceiling)
      float wz = -(viewMatrix * vec4(vWorld, 1.0)).z;
      vec4 r = refrSample((sG + sA) * uRefrDistort * 0.6 / max(dist, 2.0), wz + 0.05, vec2(0.0));
      if (r.a > 0.0) { trans = r.rgb * uWindowTint * 0.8; sunT *= 0.0; }
    }
    flick = mix(1.0, flick, max(sheenW, 1.0 - Fw));
    // Toward grazing, ripples can only tip a few sub-pixel facets into the window: that reads as a row of
    // dashes along the underwater horizon. Fade window light + sun out there, and with slope variance.
    float winFade = smoothstep(0.42, 0.6, upness) * (1.0 - smoothstep(0.02, 0.08, m2));
    trans = mix(refl, trans, winFade);
    sunT *= winFade;
    col = ((1.0 - Fw) * (trans + sunT) + Fw * refl) * flick;
    float fu = 1.0 - exp(-dist / uUnderVis);
    fu = max(fu, 1.0 - smoothstep(0.02, 0.3, upness));    // grazing ceiling dissolves into the haze
    col = mix(col, underBg(I), fu);
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Procedural tileable ripple slope maps (FFT synthesis, LEAN mip chain)
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fft1d(re, im, n, off, stride, inverse, tr, ti) {
  // gather
  for (let i = 0; i < n; i++) { tr[i] = re[off + i * stride]; ti[i] = im[off + i * stride]; }
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = tr[i]; tr[i] = tr[j]; tr[j] = t; t = ti[i]; ti[i] = ti[j]; ti[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = tr[i + j], ai = ti[i + j];
        const br = tr[i + j + len / 2] * cr - ti[i + j + len / 2] * ci;
        const bi = tr[i + j + len / 2] * ci + ti[i + j + len / 2] * cr;
        tr[i + j] = ar + br; ti[i + j] = ai + bi;
        tr[i + j + len / 2] = ar - br; ti[i + j + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  for (let i = 0; i < n; i++) { re[off + i * stride] = tr[i]; im[off + i * stride] = ti[i]; }
}

/**
 * Tileable slope texture: RGBA half-float = (dh/du, dh/dv, (dh/du)²+(dh/dv)², 0), rms slope per axis = 1,
 * with a box-filtered mip chain (so the shader recovers mean slope AND slope variance at any distance).
 */
function makeSlopeTexture(n, seed, { kMin = 2, kMax = n * 0.36, wind = 0, directional = 0.5 } = {}) {
  const rnd = mulberry32(seed);
  const gauss = () => { const u = Math.max(rnd(), 1e-9), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const N2 = n * n;
  const hr = new Float64Array(N2), hi = new Float64Array(N2);
  const wx = Math.cos(wind), wz = Math.sin(wind);
  for (let y = 0; y < n; y++) {
    const ky = y <= n / 2 ? y : y - n;
    for (let x = 0; x < n; x++) {
      const kx = x <= n / 2 ? x : x - n;
      const k = Math.hypot(kx, ky);
      const g1 = gauss(), g2 = gauss();
      if (k < kMin || k > n / 2 - 1) continue;
      const c = (kx * wx + ky * wz) / k;
      const dir = (1 - directional) + directional * c * c;
      // Phillips-like k^-4 height spectrum → equal slope variance per octave; soft cut near Nyquist
      const P = Math.pow(k, -4) * dir * Math.exp(-(k * k) / (kMax * kMax)) * (1 - Math.exp(-(k * k) / (kMin * kMin * 2)));
      const amp = Math.sqrt(P * 0.5);
      hr[y * n + x] = g1 * amp; hi[y * n + x] = g2 * amp;
    }
  }
  // slope spectra G = i·kx·H + i·(i·kz·H), with H made Hermitian so both slope fields come out real
  const gr = new Float64Array(N2), gi = new Float64Array(N2);
  for (let y = 0; y < n; y++) {
    const ky = y <= n / 2 ? y : y - n;
    const y2 = (n - y) % n;
    for (let x = 0; x < n; x++) {
      const kx = x <= n / 2 ? x : x - n;
      const x2 = (n - x) % n;
      const Hr = 0.5 * (hr[y * n + x] + hr[y2 * n + x2]);
      const Hi = 0.5 * (hi[y * n + x] - hi[y2 * n + x2]);
      // Sx = i kx H = (-kx Hi, kx Hr); Sz = i ky H = (-ky Hi, ky Hr); G = Sx + i Sz
      gr[y * n + x] = -kx * Hi - ky * Hr;
      gi[y * n + x] = kx * Hr - ky * Hi;
    }
  }
  const tr = new Float64Array(n), ti = new Float64Array(n);
  for (let y = 0; y < n; y++) fft1d(gr, gi, n, y * n, 1, true, tr, ti);
  for (let x = 0; x < n; x++) fft1d(gr, gi, n, x, n, true, tr, ti);
  let ss = 0;
  for (let i = 0; i < N2; i++) ss += gr[i] * gr[i] + gi[i] * gi[i];
  const norm = 1 / Math.sqrt(ss / (2 * N2));
  // level 0 (float) then box-filter mips
  let level = new Float32Array(N2 * 4);
  for (let i = 0; i < N2; i++) {
    const sx = gr[i] * norm, sz = gi[i] * norm;
    level[i * 4] = sx; level[i * 4 + 1] = sz; level[i * 4 + 2] = sx * sx + sz * sz; level[i * 4 + 3] = 1;
  }
  const toHalf = THREE.DataUtils.toHalfFloat;
  const mipmaps = [];
  let size = n;
  for (;;) {
    const h = new Uint16Array(size * size * 4);
    for (let i = 0; i < h.length; i++) h[i] = toHalf(level[i]);
    mipmaps.push({ data: h, width: size, height: size });
    if (size === 1) break;
    const ns = size >> 1;
    const next = new Float32Array(ns * ns * 4);
    for (let y = 0; y < ns; y++) for (let x = 0; x < ns; x++) for (let c = 0; c < 4; c++) {
      const a = ((2 * y) * size + 2 * x) * 4 + c;
      next[(y * ns + x) * 4 + c] = 0.25 * (level[a] + level[a + 4] + level[a + size * 4] + level[a + size * 4 + 4]);
    }
    level = next; size = ns;
  }
  const tex = new THREE.DataTexture(mipmaps[0].data, n, n, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mipmaps = mipmaps;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Camera-centred radial grid: angular resolution constant → density follows perspective.
// position.xz = offset from the camera, position.y = 1 on the horizon skirt ring.
function buildGrid(N, aspect, r0, Rmain, Rskirt) {
  const g = 1 + aspect * 2 * Math.PI / N;
  const radii = [];
  for (let r = r0; r < Rmain; r *= g) radii.push(r);
  radii.push(Rmain);
  const rings = radii.length + 1; // + skirt
  const pos = new Float32Array((1 + rings * N) * 3);
  let p = 3; // centre vertex at 0
  const ringR = radii.concat([Rskirt]);
  for (let i = 0; i < rings; i++) {
    const r = ringR[i], skirt = i === rings - 1 ? 1 : 0;
    for (let j = 0; j < N; j++) {
      const a = (j / N) * Math.PI * 2;
      pos[p++] = Math.cos(a) * r; pos[p++] = skirt; pos[p++] = Math.sin(a) * r;
    }
  }
  const idx = new Uint32Array((N + (rings - 1) * N * 2) * 3);
  let q = 0;
  for (let j = 0; j < N; j++) {
    const j1 = (j + 1) % N;
    idx[q++] = 0; idx[q++] = 1 + j1; idx[q++] = 1 + j;
  }
  for (let i = 0; i < rings - 1; i++) {
    const a0 = 1 + i * N, b0 = 1 + (i + 1) * N;
    for (let j = 0; j < N; j++) {
      const j1 = (j + 1) % N;
      const ij = a0 + j, ij1 = a0 + j1, oj = b0 + j, oj1 = b0 + j1;
      idx[q++] = ij; idx[q++] = ij1; idx[q++] = oj;
      idx[q++] = ij1; idx[q++] = oj1; idx[q++] = oj;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Rskirt * 2);
  return { geo, cellK: g - 1 };
}

// JS port of the Preetham sky (identical maths to Sky.js) for horizon / sun colours on the CPU.
const TOTAL_RAYLEIGH = [5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5];
const MIE_CONST = [1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14];
const _skyRes = [0, 0, 0];
const lerpLog = (x, y, t) => Math.exp(Math.log(Math.max(x, 1e-5)) * (1 - t) + Math.log(Math.max(y, 1e-5)) * t);
function skyEval(dir, sun, sp, exposure, out, extinctionOnly) {
  const sunfade = 1.0 - Math.min(Math.max(1.0 - Math.exp(sun.y / 450000.0), 0), 1);
  const zc = Math.min(Math.max(sun.y, -1), 1);
  const sunE = 1000.0 * Math.max(0.0, 1.0 - Math.exp(-((1.6110731556870734 - Math.acos(zc)) / 1.5)));
  const rc = sp.rayleigh - (1.0 - sunfade);
  const mieC = 0.434 * (0.2 * sp.turbidity) * 10E-18;
  const zen = Math.acos(Math.max(0, dir.y));
  const inv = 1.0 / (Math.cos(zen) + 0.15 * Math.pow(93.885 - (zen * 180.0) / Math.PI, -1.253));
  const sR = 8.4E3 * inv, sM = 1.25E3 * inv;
  const cosT = dir.x * sun.x + dir.y * sun.y + dir.z * sun.z;
  const rPhase = 0.05968310365946075 * (1.0 + Math.pow(cosT * 0.5 + 0.5, 2.0));
  const g = sp.mieDirectionalG, g2 = g * g;
  const mPhase = 0.07957747154594767 * ((1.0 - g2) / Math.pow(1.0 - 2.0 * g * cosT + g2, 1.5));
  const mixF = Math.min(Math.max(Math.pow(1.0 - sun.y, 5.0), 0), 1);
  const res = _skyRes;
  for (let c = 0; c < 3; c++) {
    const bR = TOTAL_RAYLEIGH[c] * rc, bM = mieC * MIE_CONST[c] * sp.mieCoefficient;
    const Fex = Math.exp(-(bR * sR + bM * sM));
    if (extinctionOnly) { res[c] = Fex; continue; }
    const ratio = (bR * rPhase + bM * mPhase) / (bR + bM);
    let Lin = Math.pow(sunE * ratio * (1.0 - Fex), 1.5);
    Lin *= (1 - mixF) + mixF * Math.pow(sunE * ratio * Fex, 0.5);
    const L0 = 0.1 * Fex;
    const tex = (Lin + L0) * 0.04 + (c === 1 ? 0.0003 : c === 2 ? 0.00075 : 0);
    res[c] = Math.pow(Math.pow(tex, 1.0 / (1.2 + 1.2 * sunfade)) * exposure * 2.0, sp.gamma) * 0.5;
  }
  if (!extinctionOnly) {
    const a = Math.min(Math.max((cosT - 0.5) / (-0.3 - 0.5), 0), 1), w = a * a * (3 - 2 * a);
    res[0] = res[0] + (Math.min(res[0], res[1] * 0.92) - res[0]) * w;
    const hl = 0.2126 * res[0] + 0.7152 * res[1] + 0.0722 * res[2];
    const ay = Math.min(Math.abs(dir.y) / 0.3, 1), sy = ay * ay * (3 - 2 * ay);
    const as = Math.min(Math.max((cosT - 0.75) / 0.22, 0), 1), ss = as * as * (3 - 2 * as);
    const hw = (1 - sy) * (1 - ss) * 0.85;
    res[0] += (hl * 0.8 - res[0]) * hw; res[1] += (hl * 1.02 - res[1]) * hw; res[2] += (hl * 1.24 - res[2]) * hw;
  }
  if (!extinctionOnly) {
    const l = 0.2126 * res[0] + 0.7152 * res[1] + 0.0722 * res[2];
    for (let c = 0; c < 3; c++) res[c] = Math.max(l + (res[c] - l) * sp.saturation, 0) * sp.tint[c];
    const lum = 0.2126 * res[0] + 0.7152 * res[1] + 0.0722 * res[2];
    const sl = lum > 0.42 ? 0.42 + 0.4 * (1 - Math.exp(-(lum - 0.42) / 0.4)) : lum;
    for (let c = 0; c < 3; c++) res[c] *= sl / Math.max(lum, 1e-5);
  }
  return out.setRGB(res[0], res[1], res[2], THREE.LinearSRGBColorSpace);
}

// createOcean
export function createOcean({ renderer, scene, camera, quality = 'high', waves = DEFAULT_WAVES } = {}) {
  const low = quality === 'low';
  const far = camera && camera.far ? camera.far : 9000;
  const Rmain = Math.min(far * 0.86, 12000);
  const Rskirt = Math.min(far * 0.95, 13000);

  const sunDirection = sunFromAngles(SUN_ELEVATION_DEG, SUN_AZIMUTH_DEG, new THREE.Vector3());
  const sunColor = new THREE.Color(1, 0.8, 0.6);
  const horizonColor = new THREE.Color();
  const fogColor = new THREE.Color();
  // v4 "moody navy" grade (hue ~205–215°), linear values back-solved through three's AgX tone mapping so
  // a level underwater view displays: 0 m #0c4466, 15 m #062d4a, 40 m #04213a, 150 m #021120, 600 m #010306
  const LIN = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
  const underwaterColor = LIN(0.00824, 0.04247, 0.09781);
  const stop15 = LIN(0.00712, 0.02315, 0.05290);
  const stop40 = LIN(0.00600, 0.01602, 0.03590);
  const deepColor = LIN(0.00401, 0.00897, 0.01703);
  const abyssColor = LIN(0.00212, 0.00345, 0.00521);
  const depthStops = [[0, underwaterColor], [15, stop15], [40, stop40], [150, deepColor], [600, abyssColor]];

  const skyParams = { turbidity: 1.7, rayleigh: 2.5, mieCoefficient: 0.0012, mieDirectionalG: 0.93, gamma: 1.5, saturation: 1.5, tint: [0.7, 0.94, 1.4] };

  // waves (shared by GPU and CPU)
  const wA = [], wB = [];
  const cw = { dx: new Float64Array(NWAVES), dz: new Float64Array(NWAVES), k: new Float64Array(NWAVES),
    a: new Float64Array(NWAVES), om: new Float64Array(NWAVES), ph: new Float64Array(NWAVES), ch: new Float64Array(NWAVES) };
  const rnd = mulberry32(1931);
  let ampSum = 0;
  for (let i = 0; i < NWAVES; i++) {
    const [lambda, amp, deg, chop] = waves[i] || [10, 0, 0, 0];
    const ang = SWELL_HEADING + THREE.MathUtils.degToRad(deg);
    const k = 2 * Math.PI / lambda;
    cw.dx[i] = Math.cos(ang); cw.dz[i] = Math.sin(ang); cw.k[i] = k; cw.a[i] = amp;
    cw.om[i] = Math.sqrt(G * k); cw.ph[i] = rnd() * Math.PI * 2; cw.ch[i] = chop;
    wA.push(new THREE.Vector4(cw.dx[i], cw.dz[i], k, amp));
    wB.push(new THREE.Vector4(cw.om[i], cw.ph[i], chop, 0));
    ampSum += amp;
  }

  // environment bake: sky (+ ocean below horizon) and underwater light field
  const envSize = low ? 128 : 256;
  const skyFrag = buildSkyFragment();
  const makeSkyMaterial = (lowerOcean, sunDisk) => {
    const u = THREE.UniformsUtils.clone(Sky.SkyShader.uniforms);
    Object.assign(u, {
      uExposure: { value: 0.28 }, uSkyGamma: { value: skyParams.gamma }, uSkySat: { value: skyParams.saturation }, uSkyTint: { value: new THREE.Vector3(...skyParams.tint) }, uSunDisk: { value: sunDisk }, uUnder: { value: 0 }, uLowerOcean: { value: lowerOcean },
      uEnvBody: { value: new THREE.Color() },
      uUnderColor: { value: underwaterColor }, uDeepColor: { value: deepColor }, uStop15: { value: stop15 }, uStop40: { value: stop40 }, uAbyssColor: { value: abyssColor }, uCamDepth: { value: 0 },
      uSunDir: { value: sunDirection }, uSunColor: { value: sunColor },
    });
    u.sunPosition.value = sunDirection;
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) u[k].value = skyParams[k];
    return new THREE.ShaderMaterial({ name: 'OceanSky', uniforms: u, vertexShader: Sky.SkyShader.vertexShader,
      fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false });
  };

  const skyMat = makeSkyMaterial(0, 1);
  const sky = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), skyMat);
  sky.scale.setScalar(Math.min(far * 0.5, 4000));
  sky.frustumCulled = false;
  sky.renderOrder = 1000;
  sky.name = 'OceanSky';
  sky.onBeforeRender = (r, s, cam) => { sky.position.copy(cam.position); sky.updateMatrixWorld(); };

  const envSkyMat = makeSkyMaterial(1, 0);
  const envScene = new THREE.Scene();
  const envBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), envSkyMat);
  envBox.scale.setScalar(50);
  envScene.add(envBox);
  const cubeRT = new THREE.WebGLCubeRenderTarget(envSize, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(0.1, 100, cubeRT);
  envScene.add(cubeCam);

  const underMat = new THREE.ShaderMaterial({
    name: 'OceanUnderEnv',
    uniforms: { uUnderColor: { value: underwaterColor }, uDeepColor: { value: deepColor }, uStop15: { value: stop15 }, uStop40: { value: stop40 }, uAbyssColor: { value: abyssColor }, uCamDepth: { value: 0 },
      uSunDir: { value: sunDirection }, uSunColor: { value: sunColor } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: GLSL_UNDER + 'varying vec3 vDir; void main(){ gl_FragColor = vec4(underBg(normalize(vDir)), 1.0); }',
    side: THREE.BackSide, depthWrite: false,
  });
  const underScene = new THREE.Scene();
  const underBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), underMat);
  underBox.scale.setScalar(50);
  underScene.add(underBox);
  const underCubeRT = new THREE.WebGLCubeRenderTarget(envSize, { type: THREE.HalfFloatType });
  const underCam = new THREE.CubeCamera(0.1, 100, underCubeRT);
  underScene.add(underCam);

  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null, underEnvRT = null, reflRT = null;

  // detail maps
  const texA = makeSlopeTexture(low ? 256 : 512, 7, { kMin: 2.5, kMax: (low ? 256 : 512) * 0.14, wind: 0.3, directional: 0.55 });
  const texB = makeSlopeTexture(low ? 128 : 256, 23, { kMin: 2.0, kMax: (low ? 128 : 256) * 0.16, wind: -0.6, directional: 0.25 });
  const aniso = Math.min(renderer.capabilities.getMaxAnisotropy(), low ? 4 : 16);
  texA.anisotropy = texB.anisotropy = aniso;

  const detA = { tile: 13.7, angle: 0.42, strength: 0.058, vel: [0.42, 0.16] }; // vel in m/s along world x/z
  const detB = { tile: 3.9, angle: -0.93, strength: 0.046, vel: [0.12, -0.28] };
  const detC = { tile: 1.21, angle: 2.1, strength: 0.022, vel: [-0.17, 0.09] };
  const detV = (d) => new THREE.Vector4(1 / d.tile, Math.cos(d.angle), Math.sin(d.angle), d.strength);

  // surface
  const { geo, cellK } = buildGrid(low ? 128 : 320, low ? 2.5 : 2.0, low ? 0.6 : 0.25, Rmain, Rskirt);
  const uniforms = {
    uWaveA: { value: wA }, uWaveB: { value: wB },
    uTime: { value: 0 }, uAmp: { value: 1 }, uChop: { value: 1 }, uCellK: { value: cellK }, uRmain: { value: Rmain },
    uDetailA: { value: texA }, uDetailB: { value: texB },
    uDetA: { value: detV(detA) }, uDetB: { value: detV(detB) }, uDetC: { value: detV(detC) },
    uDetOffAB: { value: new THREE.Vector4() }, uDetOffC: { value: new THREE.Vector2() },
    uEnv: { value: null },
    uSunDir: { value: sunDirection }, uSunColor: { value: sunColor }, uSunIntensity: { value: 1.8 },
    uBodyColor: { value: new THREE.Color().setRGB(0.018, 0.036, 0.064, THREE.LinearSRGBColorSpace) }, // v4 navy, hue ~210°
    uScatterColor: { value: new THREE.Color().setRGB(0.012, 0.06, 0.09, THREE.LinearSRGBColorSpace) },
    uFogDist: { value: 5000 }, uM2Min: { value: 0.0008 }, uCrestScale: { value: 1 / (ampSum * 0.6) },
    uUnderColor: { value: underwaterColor }, uDeepColor: { value: deepColor }, uStop15: { value: stop15 }, uStop40: { value: stop40 }, uAbyssColor: { value: abyssColor }, uCamDepth: { value: 0 },
    uUnderVis: { value: 55 }, uWindowTint: { value: new THREE.Color(1.25, 1.6, 1.75) },
    uMirrorTint: { value: new THREE.Color(0.30, 0.72, 1.0) }, uSpecClamp: { value: 10 }, uFocus: { value: 3.0 },
    uRefrColor: { value: null }, uRefrDepth: { value: null }, uRefrOn: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
    uNear: { value: 0.1 }, uFar: { value: 9000 }, uRefrDistort: { value: 0.8 },
    // absorption per metre (linear RGB): clear for the first few metres, the body colour by ~15 m
    uAbsorb: { value: new THREE.Vector3(0.36, 0.16, 0.1) },
  };
  const cubeUVHeight = 4 * envSize; // PMREM layout, as three's generateCubeUVSize() derives it
  const cubeUVMaxMip = Math.log2(cubeUVHeight) - 2;
  const f = (v) => v.toFixed(10);
  const mat = new THREE.ShaderMaterial({ name: 'OceanSurface', uniforms, vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG, side: THREE.DoubleSide,
    defines: { ENVMAP_TYPE_CUBE_UV: '', CUBEUV_MAX_MIP: f(cubeUVMaxMip), CUBEUV_TEXEL_HEIGHT: f(1 / cubeUVHeight),
      CUBEUV_TEXEL_WIDTH: f(1 / (3 * Math.max(Math.pow(2, cubeUVMaxMip), 7 * 16))) } });
  mat.extensions = { derivatives: true };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'OceanSurface';
  scene.add(mesh);
  scene.add(sky);

  // env regeneration
  const lastSun = new THREE.Vector3();
  const lastUnder = new THREE.Color();
  const lastSky = { turbidity: 0, rayleigh: 0, mieCoefficient: 0, mieDirectionalG: 0, gamma: 0, saturation: 0, exposure: 0 };
  const tmpC = new THREE.Color();
  const tmpV = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  function syncSkyUniforms(m) {
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) m.uniforms[k].value = skyParams[k];
    m.uniforms.uSkyGamma.value = skyParams.gamma;
    m.uniforms.uSkySat.value = skyParams.saturation;
    m.uniforms.uSkyTint.value.set(...skyParams.tint);
    m.uniforms.uExposure.value = skyMat.uniforms.uExposure.value;
  }
  function bakeSky() {
    syncSkyUniforms(envSkyMat);
    syncSkyUniforms(skyMat);
    // sun colour from extinction along the sun ray (softened: Preetham over-reddens at low sun)
    skyEval(sunDirection, sunDirection, skyParams, 1, tmpC, true);
    const r = Math.pow(tmpC.r, 0.25), g = Math.pow(tmpC.g, 0.25), b = Math.pow(tmpC.b, 0.25);
    const mx = Math.max(r, g, b, 1e-6);
    sunColor.setRGB(r / mx, g / mx, b / mx, THREE.LinearSRGBColorSpace);
    // body colour lit by the sky zenith → env lower hemisphere
    skyEval(_up, sunDirection, skyParams, skyMat.uniforms.uExposure.value, tmpC);
    envSkyMat.uniforms.uEnvBody.value.copy(uniforms.uBodyColor.value).multiply(tmpC).multiplyScalar(1.0)
      .add(tmpC.copy(uniforms.uBodyColor.value).multiplyScalar(uniforms.uSunIntensity.value * Math.max(sunDirection.y, 0) * 0.5));
    envSkyMat.uniforms.uLowerOcean.value = 2;
    cubeCam.update(renderer, envScene);
    reflRT = pmrem.fromCubemap(cubeRT.texture, reflRT);
    uniforms.uEnv.value = reflRT.texture;
    envSkyMat.uniforms.uLowerOcean.value = 1;
    cubeCam.update(renderer, envScene);
    envRT = pmrem.fromCubemap(cubeRT.texture, envRT);
    lastSun.copy(sunDirection);
    Object.assign(lastSky, skyParams, { exposure: skyMat.uniforms.uExposure.value });
  }
  function bakeUnder() {
    underCam.update(renderer, underScene);
    underEnvRT = pmrem.fromCubemap(underCubeRT.texture, underEnvRT);
    lastUnder.copy(underwaterColor);
  }
  bakeSky();
  bakeUnder();

  // CPU waves
  const camXZ = { x: camera ? camera.position.x : 0, z: camera ? camera.position.z : 0 };
  const fades = new Float64Array(NWAVES);
  function computeFades(x, z) {
    const cell = Math.hypot(x - camXZ.x, z - camXZ.z) * cellK;
    for (let i = 0; i < NWAVES; i++) {
      const lambda = 2 * Math.PI / cw.k[i];
      const e0 = 0.12 * lambda, e1 = 0.25 * lambda;
      const t = Math.min(Math.max((cell - e0) / (e1 - e0), 0), 1);
      fades[i] = 1 - t * t * (3 - 2 * t);
    }
  }
  // Invert the horizontal Gerstner displacement: find x0 with x0 + D(x0) = (x, z).
  const inv = { x: 0, z: 0 };
  function invert(x, z, time) {
    const amp = uniforms.uAmp.value, chop = uniforms.uChop.value;
    let x0 = x, z0 = z;
    for (let it = 0; it < 4; it++) {
      let ox = 0, oz = 0;
      for (let i = 0; i < NWAVES; i++) {
        const th = cw.k[i] * (cw.dx[i] * x0 + cw.dz[i] * z0) - cw.om[i] * time + cw.ph[i];
        const s = cw.a[i] * amp * fades[i] * chop * cw.ch[i] * Math.sin(th);
        ox -= cw.dx[i] * s; oz -= cw.dz[i] * s;
      }
      x0 = x - ox; z0 = z - oz;
    }
    inv.x = x0; inv.z = z0;
  }
  function surfaceHeightAt(x, z, time) {
    computeFades(x, z);
    invert(x, z, time);
    const amp = uniforms.uAmp.value;
    let y = 0;
    for (let i = 0; i < NWAVES; i++) {
      const th = cw.k[i] * (cw.dx[i] * inv.x + cw.dz[i] * inv.z) - cw.om[i] * time + cw.ph[i];
      y += cw.a[i] * amp * fades[i] * Math.cos(th);
    }
    return y;
  }
  function surfaceNormalAt(x, z, time, target = new THREE.Vector3()) {
    computeFades(x, z);
    invert(x, z, time);
    const amp = uniforms.uAmp.value, chop = uniforms.uChop.value;
    let tx = 1, ty = 0, tz = 0, bx = 0, by = 0, bz = 1;
    for (let i = 0; i < NWAVES; i++) {
      const th = cw.k[i] * (cw.dx[i] * inv.x + cw.dz[i] * inv.z) - cw.om[i] * time + cw.ph[i];
      const kA = cw.k[i] * cw.a[i] * amp * fades[i];
      const q = chop * cw.ch[i] * kA * Math.cos(th), h = kA * Math.sin(th);
      const dx = cw.dx[i], dz = cw.dz[i];
      tx -= q * dx * dx; ty -= h * dx; tz -= q * dx * dz;
      bx -= q * dx * dz; by -= h * dz; bz -= q * dz * dz;
    }
    // n = B × T
    return target.set(by * tz - bz * ty, bz * tx - bx * tz, bx * ty - by * tx).normalize();
  }

  // per frame
  // JS twin of the shader's underBase(): level underwater colour at depth d (log-space between stops)
  function underBaseJS(d, out) {
    let i = 0;
    while (i < depthStops.length - 2 && d > depthStops[i + 1][0]) i++;
    const s0 = depthStops[i], s1 = depthStops[i + 1], a = s0[1], b = s1[1];
    const t = Math.min(Math.max((d - s0[0]) / (s1[0] - s0[0]), 0), 1);
    return out.setRGB(lerpLog(a.r, b.r, t), lerpLog(a.g, b.g, t), lerpLog(a.b, b.b, t), THREE.LinearSRGBColorSpace);
  }
  const lookDir = new THREE.Vector3();
  const fogTmp = new THREE.Color();
  const wrap = (v) => v - Math.floor(v);
  // Refraction pass: rendered from the surface's onBeforeRender (same frame, same camera, works inside
  // EffectComposer), at half the current target's resolution, with the ocean and sky hidden. Nested
  // renders like this are what three's Reflector does. Skipped on 'low', when disabled, and when the
  // camera is far from the surface (nothing near it would show).
  const refr = { enabled: !low, rt: null, size: new THREE.Vector2(), skip: false, scale: 0 };
  const _dbs = new THREE.Vector2();
  mesh.onBeforeRender = (r, s, cam) => {
    uniforms.uRefrOn.value = 0;
    if (!refr.enabled || cam.position.y > 150 || cam.position.y < -40) return;
    const target = r.getRenderTarget();
    if (target) _dbs.set(target.width, target.height); else r.getDrawingBufferSize(_dbs);
    // Full res up to ~2.3 MP (1080p-class targets), half res above that (retina: a half-res texel is then
    // ~1 CSS pixel). params.refractionScale overrides (1 or 0.5).
    const sc = refr.scale || (_dbs.x * _dbs.y > 2.3e6 ? 0.5 : 1);
    const w = Math.max(1, Math.floor(_dbs.x * sc)), h = Math.max(1, Math.floor(_dbs.y * sc));
    if (!refr.rt) {
      refr.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true,
        depthTexture: new THREE.DepthTexture(w, h) });
      refr.rt.texture.generateMipmaps = false;
    } else if (refr.rt.width !== w || refr.rt.height !== h) {
      refr.rt.setSize(w, h);
    }
    uniforms.uRes.value.copy(_dbs);
    uniforms.uNear.value = cam.near; uniforms.uFar.value = cam.far;
    const xr = r.xr.enabled, shadowAuto = r.shadowMap.autoUpdate, skyVis = sky.visible;
    mesh.visible = false; sky.visible = false;
    r.xr.enabled = false; r.shadowMap.autoUpdate = false;
    r.setRenderTarget(refr.rt);
    r.state.buffers.depth.setMask(true);
    if (r.autoClear === false) r.clear();
    r.render(s, cam);
    r.xr.enabled = xr; r.shadowMap.autoUpdate = shadowAuto;
    mesh.visible = true; sky.visible = skyVis;
    r.setRenderTarget(target);
    if (cam.viewport !== undefined) r.state.viewport(cam.viewport);
    uniforms.uRefrColor.value = refr.rt.texture;
    uniforms.uRefrDepth.value = refr.rt.depthTexture;
    uniforms.uRefrOn.value = 1;
  };

  function update(time, cam = camera) {
    uniforms.uTime.value = time;
    const offs = uniforms.uDetOffAB.value;
    offs.set(wrap(-time * detA.vel[0] / detA.tile), wrap(-time * detA.vel[1] / detA.tile),
      wrap(-time * detB.vel[0] / detB.tile), wrap(-time * detB.vel[1] / detB.tile));
    uniforms.uDetOffC.value.set(wrap(-time * detC.vel[0] / detC.tile), wrap(-time * detC.vel[1] / detC.tile));

    if (lastSun.distanceToSquared(sunDirection) > 1e-8 || lastSky.turbidity !== skyParams.turbidity ||
        lastSky.rayleigh !== skyParams.rayleigh || lastSky.mieCoefficient !== skyParams.mieCoefficient ||
        lastSky.mieDirectionalG !== skyParams.mieDirectionalG || lastSky.gamma !== skyParams.gamma || lastSky.saturation !== skyParams.saturation || lastSky.exposure !== skyMat.uniforms.uExposure.value) {
      sunDirection.normalize();
      bakeSky();
      bakeUnder();
    } else if (!lastUnder.equals(underwaterColor)) {
      bakeUnder();
    }

    if (cam) {
      camXZ.x = cam.position.x; camXZ.z = cam.position.z;
      const surf = surfaceHeightAt(cam.position.x, cam.position.z, time);
      ocean.isUnderwater = cam.position.y < surf;
      ocean.cameraDepth = Math.max(-cam.position.y, 0);
      skyMat.uniforms.uUnder.value = ocean.isUnderwater ? 1 : 0;
      skyMat.uniforms.uCamDepth.value = ocean.cameraDepth;
      uniforms.uCamDepth.value = ocean.cameraDepth;
      cam.getWorldDirection(lookDir);
      lookDir.y = 0;
      if (lookDir.lengthSq() < 1e-6) lookDir.set(0, 0, -1);
      lookDir.normalize();
      skyEval(lookDir, sunDirection, skyParams, skyMat.uniforms.uExposure.value, horizonColor);
      if (ocean.isUnderwater) {
        const d = ocean.cameraDepth;
        underBaseJS(d, fogTmp);
        fogColor.copy(fogTmp);
      } else {
        fogColor.copy(horizonColor);
      }
    }
  }

  const ocean = {
    mesh, sky,
    get sunDirection() { return sunDirection; },
    set sunDirection(v) { sunDirection.copy(v).normalize(); },
    sunColor, horizonColor, fogColor, underwaterColor, deepColor, depthStops,
    get environment() { return envRT.texture; },
    get underwaterEnvironment() { return underEnvRT.texture; },
    isUnderwater: false,
    cameraDepth: 0,
    waves: cw,
    params: {
      get amplitude() { return uniforms.uAmp.value; }, set amplitude(v) { uniforms.uAmp.value = v; },
      get choppiness() { return uniforms.uChop.value; }, set choppiness(v) { uniforms.uChop.value = v; },
      get detail() { return uniforms.uDetA.value.w / detA.strength; },
      set detail(v) { uniforms.uDetA.value.w = detA.strength * v; uniforms.uDetB.value.w = detB.strength * v; uniforms.uDetC.value.w = detC.strength * v; },
      get sunIntensity() { return uniforms.uSunIntensity.value; }, set sunIntensity(v) { uniforms.uSunIntensity.value = v; },
      get skyExposure() { return skyMat.uniforms.uExposure.value; }, set skyExposure(v) { skyMat.uniforms.uExposure.value = v; },
      get horizonFog() { return uniforms.uFogDist.value; }, set horizonFog(v) { uniforms.uFogDist.value = v; },
      get refraction() { return refr.enabled; }, set refraction(v) { refr.enabled = !!v; },
      get refractionScale() { return refr.scale; }, set refractionScale(v) { refr.scale = v || 0; }, // 0 = auto
      get underwaterVisibility() { return uniforms.uUnderVis.value; }, set underwaterVisibility(v) { uniforms.uUnderVis.value = v; },
      get turbidity() { return skyParams.turbidity; }, set turbidity(v) { skyParams.turbidity = v; },
      get rayleigh() { return skyParams.rayleigh; }, set rayleigh(v) { skyParams.rayleigh = v; },
      get mieCoefficient() { return skyParams.mieCoefficient; }, set mieCoefficient(v) { skyParams.mieCoefficient = v; },
      get mieDirectionalG() { return skyParams.mieDirectionalG; }, set mieDirectionalG(v) { skyParams.mieDirectionalG = v; },
      get skyGamma() { return skyParams.gamma; }, set skyGamma(v) { skyParams.gamma = v; },
      get skySaturation() { return skyParams.saturation; }, set skySaturation(v) { skyParams.saturation = v; },
      bodyColor: uniforms.uBodyColor.value,
      scatterColor: uniforms.uScatterColor.value,
      uniforms,
    },
    update,
    surfaceHeightAt,
    surfaceNormalAt,
    dispose() {
      scene.remove(mesh); scene.remove(sky);
      geo.dispose(); mat.dispose();
      sky.geometry.dispose(); skyMat.dispose();
      envBox.geometry.dispose(); envSkyMat.dispose();
      underBox.geometry.dispose(); underMat.dispose();
      texA.dispose(); texB.dispose();
      if (refr.rt) { refr.rt.depthTexture.dispose(); refr.rt.dispose(); }
      cubeRT.dispose(); underCubeRT.dispose();
      if (envRT) envRT.dispose();
      if (reflRT) reflRT.dispose();
      if (underEnvRT) underEnvRT.dispose();
      pmrem.dispose();
    },
  };
  if (camera) update(0, camera);
  return ocean;
}

import * as THREE from "three";
import { GPUComputationRenderer } from "three/addons/misc/GPUComputationRenderer.js";

const TEX_W = 1024;
const MAX_MODS = 12;
const KIND_NONE = 0;
const KIND_WIND = 1;
const KIND_DRAG = 2;
const KIND_GRAVITY = 3;
const KIND_TURBULENCE = 4;
const KIND_VORTEX = 5;
const KIND_KICK = 6;
const KIND_SURFACE = 7;
const KIND_CURLNOISE = 8;
const KIND_SURFACESLIDE = 9;

const KIND_BY_TYPE = {
  wind: KIND_WIND,
  drag: KIND_DRAG,
  gravity: KIND_GRAVITY,
  turbulence: KIND_TURBULENCE,
  vortex: KIND_VORTEX,
  randomKick: KIND_KICK,
  surfaceStick: KIND_SURFACE,
  curlnoise: KIND_CURLNOISE,
  surfaceSlide: KIND_SURFACESLIDE
};

export function vectorFromAzEl(azDeg, elDeg) {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  const horizontal = Math.cos(el);
  return [Math.cos(az) * horizontal, Math.sin(el), Math.sin(az) * horizontal];
}

const HASH_GLSL = /* glsl */ `
  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }
  vec3 hash12_3(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
  }
  float vhash3(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
  }
  float vnoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float n000 = vhash3(i);
    float n100 = vhash3(i + vec3(1.0, 0.0, 0.0));
    float n010 = vhash3(i + vec3(0.0, 1.0, 0.0));
    float n110 = vhash3(i + vec3(1.0, 1.0, 0.0));
    float n001 = vhash3(i + vec3(0.0, 0.0, 1.0));
    float n101 = vhash3(i + vec3(1.0, 0.0, 1.0));
    float n011 = vhash3(i + vec3(0.0, 1.0, 1.0));
    float n111 = vhash3(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
      mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
      u.z
    ) * 2.0 - 1.0;
  }
  vec3 vnoise3v(vec3 p) {
    return vec3(
      vnoise3(p),
      vnoise3(p + vec3(57.13, 31.71, 91.27)),
      vnoise3(p + vec3(11.39, 71.53, 47.91))
    );
  }
  vec3 fbmTurb(vec3 p, float t, float baseScale, int octaves) {
    vec3 acc = vec3(0.0);
    float amp = 1.0;
    float freq = baseScale;
    vec3 timeShift = vec3(t * 1.5, t * 1.2, t * 0.9);
    for (int o = 0; o < 6; o++) {
      if (o >= octaves) break;
      acc += vnoise3v(p * freq + timeShift) * amp;
      amp *= 0.5;
      freq *= 2.0;
    }
    return acc;
  }
  float fbmScalar(vec3 p, float t, float baseScale, int octaves, vec3 seed) {
    float acc = 0.0;
    float amp = 1.0;
    float freq = baseScale;
    vec3 timeShift = vec3(t * 1.5, t * 1.2, t * 0.9);
    vec3 q = p + seed;
    for (int o = 0; o < 6; o++) {
      if (o >= octaves) break;
      acc += vnoise3(q * freq + timeShift) * amp;
      amp *= 0.5;
      freq *= 2.0;
    }
    return acc;
  }
  vec3 curlNoise(vec3 p, float t, float baseScale, int octaves) {
    const float e = 0.05;
    const float invH = 1.0 / (2.0 * e);
    vec3 sa = vec3(0.0,   0.0,  0.0);
    vec3 sb = vec3(31.4, 11.7, 47.3);
    vec3 sc = vec3(73.1, 89.2, 19.8);
    float dAz_dy = (fbmScalar(p + vec3(0.0,   e, 0.0), t, baseScale, octaves, sc)
                  - fbmScalar(p - vec3(0.0,   e, 0.0), t, baseScale, octaves, sc)) * invH;
    float dAy_dz = (fbmScalar(p + vec3(0.0, 0.0,   e), t, baseScale, octaves, sb)
                  - fbmScalar(p - vec3(0.0, 0.0,   e), t, baseScale, octaves, sb)) * invH;
    float dAx_dz = (fbmScalar(p + vec3(0.0, 0.0,   e), t, baseScale, octaves, sa)
                  - fbmScalar(p - vec3(0.0, 0.0,   e), t, baseScale, octaves, sa)) * invH;
    float dAz_dx = (fbmScalar(p + vec3(  e, 0.0, 0.0), t, baseScale, octaves, sc)
                  - fbmScalar(p - vec3(  e, 0.0, 0.0), t, baseScale, octaves, sc)) * invH;
    float dAy_dx = (fbmScalar(p + vec3(  e, 0.0, 0.0), t, baseScale, octaves, sb)
                  - fbmScalar(p - vec3(  e, 0.0, 0.0), t, baseScale, octaves, sb)) * invH;
    float dAx_dy = (fbmScalar(p + vec3(0.0,   e, 0.0), t, baseScale, octaves, sa)
                  - fbmScalar(p - vec3(0.0,   e, 0.0), t, baseScale, octaves, sa)) * invH;
    return vec3(dAz_dy - dAy_dz,
                dAx_dz - dAz_dx,
                dAy_dx - dAx_dy);
  }
`;

const TRIANGLE_GLSL = /* glsl */ `
  uniform sampler2D triVertsTex;
  uniform sampler2D triNormalsTex;
  uniform sampler2D triCDFTex;
  uniform sampler2D sampleVertsTex;
  uniform sampler2D sampleNormalsTex;
  uniform vec2 uTriVNSize;
  uniform vec2 uTriCDFSize;
  uniform vec2 uSampleSize;
  uniform float uTriCount;
  uniform float uSampleCount;
  uniform int uEmissionMode;

  vec2 flatTo2D(float idx, vec2 dims) {
    float row = floor(idx / dims.x);
    float col = idx - row * dims.x;
    return (vec2(col, row) + 0.5) / dims;
  }

  vec3 triVert(float t, float corner) {
    return texture2D(triVertsTex, flatTo2D(t * 3.0 + corner, uTriVNSize)).rgb;
  }
  vec3 triNorm(float t, float corner) {
    return texture2D(triNormalsTex, flatTo2D(t * 3.0 + corner, uTriVNSize)).rgb;
  }
  vec3 sampleVert(float idx) {
    return texture2D(sampleVertsTex, flatTo2D(idx, uSampleSize)).rgb;
  }
  vec3 sampleNorm(float idx) {
    return texture2D(sampleNormalsTex, flatTo2D(idx, uSampleSize)).rgb;
  }

  float pickTriByCDF(float r) {
    int hi = int(uTriCount) - 1;
    if (hi <= 0) return 0.0;
    int lo = 0;
    for (int i = 0; i < 24; i++) {
      if (lo >= hi) break;
      int mid = (lo + hi) / 2;
      float c = texture2D(triCDFTex, flatTo2D(float(mid), uTriCDFSize)).r;
      if (c < r) lo = mid + 1; else hi = mid;
    }
    return float(lo);
  }
`;

const SPAWN_GLSL = /* glsl */ `
  uniform vec3 uSpawnWind;
  uniform float uTangentSpeed;
  uniform float uLifetime;
  uniform float uLifetimeJitter;

  void computeSpawn(float seedBase, out vec3 outPos, out vec3 outNormal) {
    if (uEmissionMode == 1) {
      float r = hash11(seedBase + 7.0);
      float idx = floor(r * uSampleCount);
      idx = clamp(idx, 0.0, uSampleCount - 1.0);
      outPos = sampleVert(idx);
      outNormal = sampleNorm(idx);
    } else {
      float r = hash11(seedBase + 11.0);
      float t = pickTriByCDF(r);
      vec3 v0 = triVert(t, 0.0);
      vec3 v1 = triVert(t, 1.0);
      vec3 v2 = triVert(t, 2.0);
      vec3 n0 = triNorm(t, 0.0);
      vec3 n1 = triNorm(t, 1.0);
      vec3 n2 = triNorm(t, 2.0);
      if (uEmissionMode == 2) {
        float ePick = floor(hash11(seedBase + 13.0) * 3.0);
        float lt = hash11(seedBase + 17.0);
        if (ePick < 1.0) { outPos = mix(v0, v1, lt); outNormal = mix(n0, n1, lt); }
        else if (ePick < 2.0) { outPos = mix(v1, v2, lt); outNormal = mix(n1, n2, lt); }
        else { outPos = mix(v2, v0, lt); outNormal = mix(n2, n0, lt); }
      } else {
        float u = hash11(seedBase + 13.0);
        float v = hash11(seedBase + 17.0);
        if (u + v > 1.0) { u = 1.0 - u; v = 1.0 - v; }
        float w = 1.0 - u - v;
        outPos = v0 * w + v1 * u + v2 * v;
        outNormal = n0 * w + n1 * u + n2 * v;
      }
    }
    float ln = length(outNormal);
    if (ln > 1e-5) outNormal = outNormal / ln;
    else outNormal = vec3(0.0, 1.0, 0.0);
  }

  void initVel(vec3 normal, out vec3 outVel) {
    vec3 w = uSpawnWind;
    vec3 tangent = w - dot(w, normal) * normal;
    outVel = tangent * uTangentSpeed + normal * 0.05;
  }

  float jitteredLifetime(float seedBase) {
    float jitter = (hash11(seedBase + 23.0) - 0.5) * uLifetimeJitter * 2.0;
    return max(0.05, uLifetime * (1.0 + jitter));
  }
`;

const SDF_GLSL = /* glsl */ `
  uniform sampler2D sdfAtlas;
  uniform float uSdfDim;
  uniform vec3 uSdfBoundsMin;
  uniform vec3 uSdfBoundsInvSize;
  uniform int uSdfReady;

  vec4 sdfFetch(vec3 voxel) {
    vec2 atlasSize = vec2(uSdfDim, uSdfDim * uSdfDim);
    vec2 uv = vec2(voxel.x + 0.5, voxel.z * uSdfDim + voxel.y + 0.5) / atlasSize;
    return texture2D(sdfAtlas, uv);
  }

  vec4 sampleSDF(vec3 worldPos) {
    vec3 uvw = (worldPos - uSdfBoundsMin) * uSdfBoundsInvSize;
    uvw = clamp(uvw, vec3(0.0), vec3(1.0));
    vec3 vc = uvw * (uSdfDim - 1.0);
    vec3 vc0 = floor(vc);
    vec3 frac = vc - vc0;
    vec3 vc1 = min(vc0 + 1.0, vec3(uSdfDim - 1.0));
    vec4 c000 = sdfFetch(vec3(vc0.x, vc0.y, vc0.z));
    vec4 c100 = sdfFetch(vec3(vc1.x, vc0.y, vc0.z));
    vec4 c010 = sdfFetch(vec3(vc0.x, vc1.y, vc0.z));
    vec4 c110 = sdfFetch(vec3(vc1.x, vc1.y, vc0.z));
    vec4 c001 = sdfFetch(vec3(vc0.x, vc0.y, vc1.z));
    vec4 c101 = sdfFetch(vec3(vc1.x, vc0.y, vc1.z));
    vec4 c011 = sdfFetch(vec3(vc0.x, vc1.y, vc1.z));
    vec4 c111 = sdfFetch(vec3(vc1.x, vc1.y, vc1.z));
    vec4 c00 = mix(c000, c100, frac.x);
    vec4 c10 = mix(c010, c110, frac.x);
    vec4 c01 = mix(c001, c101, frac.x);
    vec4 c11 = mix(c011, c111, frac.x);
    vec4 c0 = mix(c00, c10, frac.y);
    vec4 c1 = mix(c01, c11, frac.y);
    return mix(c0, c1, frac.z);
  }
`;

const POS_FRAG = /* glsl */ `
${HASH_GLSL}
${TRIANGLE_GLSL}
${SPAWN_GLSL}

uniform float uDt;
uniform float uTime;
uniform float uForceRespawn;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 pos = texture2D(posTex, uv);
  vec4 vel = texture2D(velTex, uv);

  float age = pos.a + uDt;
  float lifetime = vel.a;
  vec3 p = pos.xyz;

  bool respawn = (lifetime <= 0.0) || (age >= lifetime) || (uForceRespawn > 0.5);
  if (respawn) {
    float jitterSeed = dot(uv, vec2(127.1, 311.7)) + uTime * 100.0;
    float newLifetime = jitteredLifetime(jitterSeed);
    float spawnSeed = dot(uv, vec2(127.1, 311.7)) + newLifetime * 1000.0;
    vec3 sp, sn;
    computeSpawn(spawnSeed, sp, sn);
    p = sp + sn * 0.002;
    age = 0.0;
  } else {
    p += vel.xyz * uDt;
  }

  gl_FragColor = vec4(p, age);
}
`;

const VEL_FRAG = /* glsl */ `
${HASH_GLSL}
${TRIANGLE_GLSL}
${SPAWN_GLSL}
${SDF_GLSL}

uniform float uDt;
uniform float uTime;
uniform float uForceRespawn;

uniform int uModCount;
uniform int uModKind[${MAX_MODS}];
uniform vec4 uModP0[${MAX_MODS}];
uniform vec4 uModP1[${MAX_MODS}];
uniform vec4 uModFalloff[${MAX_MODS}];
uniform vec2 uModFalloffR[${MAX_MODS}];
uniform float uModOverlay[${MAX_MODS}];

float falloffWeight(vec4 fc, vec2 r, vec3 p) {
  if (fc.w < 0.5) return 1.0;
  float d = length(p - fc.xyz);
  if (d <= r.x) return 1.0;
  if (d >= r.y) return 0.0;
  float t = (r.y - d) / max(r.y - r.x, 1e-5);
  return t * t * (3.0 - 2.0 * t);
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 pos = texture2D(posTex, uv);
  vec4 vel = texture2D(velTex, uv);

  float age = pos.a + uDt;
  float lifetime = vel.a;

  bool respawn = (lifetime <= 0.0) || (age >= lifetime) || (uForceRespawn > 0.5);
  if (respawn) {
    float jitterSeed = dot(uv, vec2(127.1, 311.7)) + uTime * 100.0;
    float newLifetime = jitteredLifetime(jitterSeed);
    float spawnSeed = dot(uv, vec2(127.1, 311.7)) + newLifetime * 1000.0;
    vec3 sp, sn;
    computeSpawn(spawnSeed, sp, sn);
    vec3 nv;
    initVel(sn, nv);
    gl_FragColor = vec4(nv, newLifetime);
    return;
  }

  vec3 p = pos.xyz;
  vec3 v = vel.xyz;
  vec3 baseForce = vec3(0.0);
  vec3 overlayForce = vec3(0.0);

  vec3 anchorP = vec3(0.0);
  vec3 anchorN = vec3(0.0);
  bool surfaceActive = false;
  float surfaceTangentDamp = 0.0;

  for (int i = 0; i < ${MAX_MODS}; i++) {
    if (i >= uModCount) break;
    int kind = uModKind[i];
    float w = falloffWeight(uModFalloff[i], uModFalloffR[i], p);
    if (w <= 0.0) continue;

    vec3 thisForce = vec3(0.0);

    if (kind == ${KIND_WIND}) {
      thisForce = uModP0[i].xyz * (uModP0[i].w * w);
    } else if (kind == ${KIND_DRAG}) {
      thisForce = -v * (uModP0[i].x * w);
    } else if (kind == ${KIND_GRAVITY}) {
      thisForce.y = -uModP0[i].x * w;
    } else if (kind == ${KIND_TURBULENCE}) {
      float strength = uModP0[i].x * w;
      float scale = uModP0[i].y;
      int octaves = int(uModP0[i].z + 0.5);
      if (octaves < 1) octaves = 1;
      if (octaves > 6) octaves = 6;
      thisForce = fbmTurb(p, uTime, scale, octaves) * strength;
    } else if (kind == ${KIND_CURLNOISE}) {
      float strength = uModP0[i].x * w;
      float scale = uModP0[i].y;
      int octaves = int(uModP0[i].z + 0.5);
      if (octaves < 1) octaves = 1;
      if (octaves > 6) octaves = 6;
      thisForce = curlNoise(p, uTime, scale, octaves) * strength;
    } else if (kind == ${KIND_VORTEX}) {
      vec3 axis = uModP0[i].xyz;
      float k = uModP0[i].w * w;
      vec3 c = uModP1[i].xyz;
      thisForce = cross(axis, p - c) * k;
    } else if (kind == ${KIND_KICK}) {
      float k = uModP0[i].x * w;
      vec3 rnd = hash12_3(uv * 1024.0 + vec2(uTime, float(i))) - 0.5;
      thisForce = rnd * k;
    } else if (kind == ${KIND_SURFACE}) {
      if (!surfaceActive) {
        float anchorSeed = dot(uv, vec2(127.1, 311.7)) + lifetime * 1000.0;
        computeSpawn(anchorSeed, anchorP, anchorN);
        surfaceActive = true;
      }
      float pullK = uModP0[i].x * w;
      thisForce = (anchorP - p) * pullK;
      surfaceTangentDamp += uModP0[i].y * w;
    } else if (kind == ${KIND_SURFACESLIDE}) {
      if (uSdfReady == 1) {
        vec4 sdf = sampleSDF(p);
        float d = sdf.r;
        vec3 nRaw = sdf.gba;
        float nLen = length(nRaw);
        if (nLen > 1e-5) {
          vec3 n = nRaw / nLen;
          float stickK = uModP0[i].x * w;
          thisForce = -n * d * stickK;
          anchorN = n;
          surfaceActive = true;
          surfaceTangentDamp += uModP0[i].y * w;
        }
      }
    }

    if (uModOverlay[i] > 0.5) {
      overlayForce += thisForce;
    } else {
      baseForce += thisForce;
    }
  }

  float baseLen = length(baseForce);
  if (baseLen > 1e-5) {
    vec3 trendDir = baseForce / baseLen;
    overlayForce -= trendDir * dot(overlayForce, trendDir);
  }
  vec3 force = baseForce + overlayForce;

  v += force * uDt;

  if (surfaceActive && surfaceTangentDamp > 0.0) {
    float damp = clamp(surfaceTangentDamp, 0.0, 1.0);
    v -= anchorN * dot(v, anchorN) * damp;
  }

  gl_FragColor = vec4(v, lifetime);
}
`;

const RENDER_VERT = /* glsl */ `
attribute vec2 reference;

uniform sampler2D posTex;
uniform sampler2D velTex;
uniform sampler2D gradTex;
uniform float uPointSize;
uniform float uPointSizeJitter;
uniform float uScale;
uniform int uColorMode;
uniform float uColorSpeedRef;
uniform float uColorFade;

varying vec3 vColor;
varying float vDiscard;

float hashRender(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec4 pos = texture2D(posTex, reference);
  vec4 vel = texture2D(velTex, reference);
  vec3 p = pos.xyz;
  float age = pos.a;
  float lifetime = vel.a;

  float u = lifetime > 1e-5 ? clamp(age / lifetime, 0.0, 1.0) : 0.0;
  float t;
  if (uColorMode == 0) {
    t = u;
  } else if (uColorMode == 1) {
    t = clamp(length(vel.xyz) / max(uColorSpeedRef, 1e-3), 0.0, 1.0);
  } else {
    t = 0.0;
  }
  vec3 c = texture2D(gradTex, vec2(t, 0.5)).rgb;
  float fade = 1.0 - u * u * uColorFade;
  vColor = c * fade;
  vDiscard = (lifetime <= 1e-5) ? 1.0 : 0.0;

  // Per-particle stable size multiplier; reseeded each respawn (lifetime mutates)
  float sizeRand = hashRender(reference * 1024.0 + lifetime * 13.7);
  float sizeMul = 1.0 + (sizeRand - 0.5) * 2.0 * uPointSizeJitter;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uPointSize * sizeMul * (uScale / max(-mv.z, 0.01));
  gl_Position = projectionMatrix * mv;
}
`;

const RENDER_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D particleTexture;
uniform float uParticleOpacity;
varying vec3 vColor;
varying float vDiscard;

void main() {
  if (vDiscard > 0.5) discard;
  vec4 t = texture2D(particleTexture, gl_PointCoord);
  if (t.a < 0.01) discard;
  gl_FragColor = vec4(vColor, uParticleOpacity) * t;
}
`;

const TRAIL_MAX_K = 14;

const COPY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COPY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uSrc, vUv);
}
`;

// GLSL1 (WebGL1-compatible) trail shader. K capped at 14 by sampler limit;
// to extend trail duration beyond ~14 frames we use sub-step sampling: copy
// posTex into history every uSubSteps actual frames. uDtAvg passed to this
// shader represents "time between adjacent history slots" (= subSteps * dt).
const TRAIL_VERT = /* glsl */ `
attribute vec2 reference;
attribute float aSegIdx;

uniform sampler2D uHistory[${TRAIL_MAX_K}];
uniform sampler2D velTex;
uniform sampler2D gradTex;
uniform int uK;
uniform int uFrame;
uniform float uTrailWidth;
uniform float uTrailJitter;
uniform float uTailFade;
uniform float uDtAvg;
uniform int uColorMode;
uniform float uColorSpeedRef;
uniform float uColorFade;

varying vec3 vColor;
varying float vAlpha;

float hashTrail(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec4 sampleHist(int slot, vec2 uv) {
  vec4 r = vec4(0.0);
  if (slot ==  0) r = texture2D(uHistory[ 0], uv);
  else if (slot ==  1) r = texture2D(uHistory[ 1], uv);
  else if (slot ==  2) r = texture2D(uHistory[ 2], uv);
  else if (slot ==  3) r = texture2D(uHistory[ 3], uv);
  else if (slot ==  4) r = texture2D(uHistory[ 4], uv);
  else if (slot ==  5) r = texture2D(uHistory[ 5], uv);
  else if (slot ==  6) r = texture2D(uHistory[ 6], uv);
  else if (slot ==  7) r = texture2D(uHistory[ 7], uv);
  else if (slot ==  8) r = texture2D(uHistory[ 8], uv);
  else if (slot ==  9) r = texture2D(uHistory[ 9], uv);
  else if (slot == 10) r = texture2D(uHistory[10], uv);
  else if (slot == 11) r = texture2D(uHistory[11], uv);
  else if (slot == 12) r = texture2D(uHistory[12], uv);
  else if (slot == 13) r = texture2D(uHistory[13], uv);
  return r;
}

void main() {
  // Per-particle effective trail length (segments in [1, K-1])
  float kEffMax = max(1.0, float(uK - 1));
  float h = hashTrail(reference * 1024.0 + 7.31);
  float kEffI = max(1.0, kEffMax * (1.0 - uTrailJitter * h));

  // Discard segments beyond per-particle length
  if (aSegIdx > kEffI) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    vColor = vec3(0.0);
    return;
  }

  int seg = int(aSegIdx);
  // (uFrame - seg) mod uK; pad with +uK*64 to keep positive in case uFrame is small
  int slotHead = (uFrame - seg     + uK * 64) - ((uFrame - seg     + uK * 64) / uK) * uK;
  int slotTail = (uFrame - seg - 1 + uK * 64) - ((uFrame - seg - 1 + uK * 64) / uK) * uK;

  vec4 head = sampleHist(slotHead, reference);
  vec4 tail = sampleHist(slotTail, reference);
  vec4 vel  = texture2D(velTex, reference);
  float lifetime = vel.a;

  // Particle dead / never spawned
  if (lifetime <= 1e-5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vColor = vec3(0.0);
    return;
  }

  // Per-segment age delta should be ~uDtAvg. Reject:
  //   - delta < 0  (head captured AFTER respawn while tail captured BEFORE)
  //   - delta > 4*uDtAvg (anomaly: stale slot, frame skip, or head/tail from different particles)
  float ageDelta = head.a - tail.a;
  if (ageDelta < 0.0 || ageDelta > uDtAvg * 4.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vColor = vec3(0.0);
    return;
  }

  // Tail must be at least (seg+1) frames into the particle's life; otherwise
  // its slot was filled before the particle existed (zero clear or prev gen).
  if (tail.a < float(seg + 1) * uDtAvg * 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vColor = vec3(0.0);
    return;
  }

  // Position jump sanity: even if ages look fine, reject if positions are
  // implausibly far apart (defensive against e.g. emission-mode change).
  vec3 segVec = head.xyz - tail.xyz;
  float segLen2 = dot(segVec, segVec);
  // Per-frame distance budget = max plausible velocity * uDtAvg. Particles in
  // this sim live in normalized [-1.18,1.18] space, plausible speed ≤ 30.
  float maxStep = 30.0 * uDtAvg;
  if (segLen2 > maxStep * maxStep) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vColor = vec3(0.0);
    return;
  }

  // position.x in {0,1}: 0 = older end (tail), 1 = newer end (head)
  // position.y in {-0.5, +0.5}: ribbon width
  vec3 p = mix(tail.xyz, head.xyz, position.x);
  vec3 dir = head.xyz - tail.xyz;

  // Billboard right vector: perpendicular to dir, in screen plane
  vec3 toCam = cameraPosition - p;
  float toCamLen = length(toCam);
  toCam = (toCamLen > 1e-5) ? toCam / toCamLen : vec3(0.0, 0.0, 1.0);
  vec3 right = cross(dir, toCam);
  float rightLen = length(right);
  if (rightLen < 1e-5) {
    // dir nearly parallel to toCam; pick an arbitrary perpendicular
    right = cross(vec3(0.0, 1.0, 0.0), toCam);
    rightLen = length(right);
    right = (rightLen > 1e-5) ? right / rightLen : vec3(1.0, 0.0, 0.0);
  } else {
    right = right / rightLen;
  }
  p += right * uTrailWidth * position.y;

  // Color
  float ageHere = mix(tail.a, head.a, position.x);
  float u_age = clamp(ageHere / max(lifetime, 1e-3), 0.0, 1.0);
  float t;
  if (uColorMode == 0) {
    t = u_age;
  } else if (uColorMode == 1) {
    float spd = length(dir) / max(uDtAvg, 1e-4);
    t = clamp(spd / max(uColorSpeedRef, 1e-3), 0.0, 1.0);
  } else {
    t = 0.0;
  }
  vec3 c = texture2D(gradTex, vec2(t, 0.5)).rgb;
  float fade = 1.0 - u_age * u_age * uColorFade;
  vColor = c * fade;

  // Alpha along trail length: head bright, tail faded by uTailFade
  float lengthAlpha = mix(uTailFade, 1.0, position.x);
  // Older segments dimmer (segIdx 0 newest)
  float segAlpha = mix(uTailFade, 1.0, 1.0 - aSegIdx / kEffMax);
  vAlpha = lengthAlpha * segAlpha;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const TRAIL_FRAG = /* glsl */ `
precision highp float;
uniform float uTrailOpacity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  if (vAlpha <= 0.001) discard;
  gl_FragColor = vec4(vColor, vAlpha * uTrailOpacity);
}
`;

function makeFloatTex(data, width, height) {
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export class GpuParticleSim {
  constructor(renderer, particleTexture) {
    this.renderer = renderer;
    this.particleTexture = particleTexture;

    this.count = 0;
    this.texSize = 0;
    this.gpuCompute = null;
    this.posVar = null;
    this.velVar = null;
    this.surface = null;
    this.points = null;
    this.geometry = null;
    this._gradTex = null;
    this._sdfTex = null;
    this._needsForceRespawn = false;
    this._speed = 1.0;

    this._sharedUniforms = {
      triVertsTex: { value: null },
      triNormalsTex: { value: null },
      triCDFTex: { value: null },
      sampleVertsTex: { value: null },
      sampleNormalsTex: { value: null },
      uTriVNSize: { value: new THREE.Vector2(1, 1) },
      uTriCDFSize: { value: new THREE.Vector2(1, 1) },
      uSampleSize: { value: new THREE.Vector2(1, 1) },
      uTriCount: { value: 1 },
      uSampleCount: { value: 1 },
      uEmissionMode: { value: 0 },
      uSpawnWind: { value: new THREE.Vector3() },
      uTangentSpeed: { value: 1.2 },
      uLifetime: { value: 2.2 },
      uLifetimeJitter: { value: 0.4 },
      uDt: { value: 0 },
      uTime: { value: 0 },
      uForceRespawn: { value: 0 },
      sdfAtlas: { value: null },
      uSdfDim: { value: 32.0 },
      uSdfBoundsMin: { value: new THREE.Vector3(-1.0, -1.0, -1.0) },
      uSdfBoundsInvSize: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
      uSdfReady: { value: 0 }
    };

    this._modUniforms = {
      uModCount: { value: 0 },
      uModKind: { value: new Array(MAX_MODS).fill(0) },
      uModP0: { value: Array.from({ length: MAX_MODS }, () => new THREE.Vector4()) },
      uModP1: { value: Array.from({ length: MAX_MODS }, () => new THREE.Vector4()) },
      uModFalloff: { value: Array.from({ length: MAX_MODS }, () => new THREE.Vector4()) },
      uModFalloffR: { value: Array.from({ length: MAX_MODS }, () => new THREE.Vector2()) },
      uModOverlay: { value: new Array(MAX_MODS).fill(0) }
    };

    this._gradTex = this._buildGradientTexture([
      { pos: 0, color: "#57d4ff" },
      { pos: 1, color: "#ff8f1f" }
    ]);

    this._renderUniforms = {
      posTex: { value: null },
      velTex: { value: null },
      gradTex: { value: this._gradTex },
      particleTexture: { value: particleTexture },
      uPointSize: { value: 0.022 },
      uPointSizeJitter: { value: 0 },
      uScale: { value: 1 },
      uColorMode: { value: 0 },
      uColorSpeedRef: { value: 5 },
      uColorFade: { value: 1 },
      uParticleOpacity: { value: 0.92 }
    };

    this._material = new THREE.ShaderMaterial({
      uniforms: this._renderUniforms,
      vertexShader: RENDER_VERT,
      fragmentShader: RENDER_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    // ---- Trail (C-tier real history path) ----
    this._trailEnabled = false;
    this._trailHistory = [];        // K_eff WebGLRenderTargets, RGBA32F
    this._trailKEff = 0;
    this._trailKReq = 0;            // K user requested (pre-clamp by VRAM/sampler)
    this._trailSubSteps = 1;        // copy posTex into history every N actual frames
    this._trailStepCounter = 0;     // counts actual frames; advance when % subSteps == 0
    this._trailFrame = 0;           // logical frame, increments per stored snapshot
    this._trailDtAvg = 1 / 60;      // EMA of actual per-frame dt
    this._trailMesh = null;
    this._trailGeom = null;
    this._trailMaterial = null;
    this._trailUniforms = null;
    this._copyScene = null;
    this._copyCam = null;
    this._copyMaterial = null;
    this._copyMesh = null;
    this._dummyTrailTex = null;     // 1x1 dummy for unused sampler slots
    this._trailParams = {
      sec: 0.15,
      jitter: 0.0,
      width: 0.005,
      tailFade: 0.85,
      vramBudgetMB: 128,
      opacity: 0.92
    };
    this._trailStatus = {
      kEff: 0, kReq: 0, vramMB: 0,
      truncatedByVram: false, disabledByAlloc: false
    };

    this._updateRendererScale();
    this._resizeListener = () => this._updateRendererScale();
    window.addEventListener("resize", this._resizeListener);
  }

  _updateRendererScale() {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const dpr = this.renderer.getPixelRatio() || (window.devicePixelRatio || 1);
    this._renderUniforms.uScale.value = Math.max(size.y * dpr * 0.5, 1);
  }

  _buildGradientTexture(stops, samples = 256) {
    const sorted = [...stops].sort((a, b) => a.pos - b.pos);
    const data = new Float32Array(samples * 4);
    const a = new THREE.Color();
    const b = new THREE.Color();
    const tmp = new THREE.Color();
    for (let i = 0; i < samples; i += 1) {
      const t = (samples === 1) ? 0 : i / (samples - 1);
      let r = 1, g = 1, bb = 1;
      if (sorted.length === 0) {
        r = 1; g = 1; bb = 1;
      } else if (sorted.length === 1 || t <= sorted[0].pos) {
        tmp.set(sorted[0].color);
        r = tmp.r; g = tmp.g; bb = tmp.b;
      } else if (t >= sorted[sorted.length - 1].pos) {
        tmp.set(sorted[sorted.length - 1].color);
        r = tmp.r; g = tmp.g; bb = tmp.b;
      } else {
        for (let k = 0; k < sorted.length - 1; k += 1) {
          const s0 = sorted[k];
          const s1 = sorted[k + 1];
          if (t <= s1.pos) {
            const span = s1.pos - s0.pos;
            const localT = span > 1e-6 ? (t - s0.pos) / span : 0;
            a.set(s0.color);
            b.set(s1.color);
            r = a.r + (b.r - a.r) * localT;
            g = a.g + (b.g - a.g) * localT;
            bb = a.b + (b.b - a.b) * localT;
            break;
          }
        }
      }
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = bb;
      data[i * 4 + 3] = 1;
    }
    const tex = new THREE.DataTexture(data, samples, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  setSurfaceData(samples) {
    const triCount = samples.triCount | 0;
    const sampleCount = (samples.samplePositions.length / 3) | 0;
    if (!triCount || !sampleCount) return;

    const totalTriTexels = triCount * 3;
    const triVNW = TEX_W;
    const triVNH = Math.max(1, Math.ceil(totalTriTexels / triVNW));
    const triV = new Float32Array(triVNW * triVNH * 4);
    const triN = new Float32Array(triVNW * triVNH * 4);
    for (let t = 0; t < triCount; t += 1) {
      for (let c = 0; c < 3; c += 1) {
        const flat = t * 3 + c;
        const dst = flat * 4;
        const src = t * 9 + c * 3;
        triV[dst]     = samples.triVerts[src];
        triV[dst + 1] = samples.triVerts[src + 1];
        triV[dst + 2] = samples.triVerts[src + 2];
        triV[dst + 3] = 1;
        triN[dst]     = samples.triNormals[src];
        triN[dst + 1] = samples.triNormals[src + 1];
        triN[dst + 2] = samples.triNormals[src + 2];
        triN[dst + 3] = 0;
      }
    }
    const triVTex = makeFloatTex(triV, triVNW, triVNH);
    const triNTex = makeFloatTex(triN, triVNW, triVNH);

    const cdfW = TEX_W;
    const cdfH = Math.max(1, Math.ceil(triCount / cdfW));
    const cdfData = new Float32Array(cdfW * cdfH * 4);
    for (let t = 0; t < triCount; t += 1) cdfData[t * 4] = samples.triCDF[t];
    if (triCount > 0) cdfData[(triCount - 1) * 4] = 1.0;
    const triCDFTex = makeFloatTex(cdfData, cdfW, cdfH);

    const sampW = TEX_W;
    const sampH = Math.max(1, Math.ceil(sampleCount / sampW));
    const sampV = new Float32Array(sampW * sampH * 4);
    const sampN = new Float32Array(sampW * sampH * 4);
    for (let i = 0; i < sampleCount; i += 1) {
      sampV[i * 4]     = samples.samplePositions[i * 3];
      sampV[i * 4 + 1] = samples.samplePositions[i * 3 + 1];
      sampV[i * 4 + 2] = samples.samplePositions[i * 3 + 2];
      sampV[i * 4 + 3] = 1;
      sampN[i * 4]     = samples.sampleNormals[i * 3];
      sampN[i * 4 + 1] = samples.sampleNormals[i * 3 + 1];
      sampN[i * 4 + 2] = samples.sampleNormals[i * 3 + 2];
      sampN[i * 4 + 3] = 0;
    }
    const sampVTex = makeFloatTex(sampV, sampW, sampH);
    const sampNTex = makeFloatTex(sampN, sampW, sampH);

    this._disposeSurface();
    this.surface = {
      triVertsTex: triVTex,
      triNormalsTex: triNTex,
      triCDFTex,
      sampleVertsTex: sampVTex,
      sampleNormalsTex: sampNTex,
      triCount,
      sampleCount
    };

    const u = this._sharedUniforms;
    u.triVertsTex.value = triVTex;
    u.triNormalsTex.value = triNTex;
    u.triCDFTex.value = triCDFTex;
    u.sampleVertsTex.value = sampVTex;
    u.sampleNormalsTex.value = sampNTex;
    u.uTriVNSize.value.set(triVNW, triVNH);
    u.uTriCDFSize.value.set(cdfW, cdfH);
    u.uSampleSize.value.set(sampW, sampH);
    u.uTriCount.value = triCount;
    u.uSampleCount.value = sampleCount;
    this._needsForceRespawn = true;
  }

  _disposeSurface() {
    if (!this.surface) return;
    this.surface.triVertsTex.dispose();
    this.surface.triNormalsTex.dispose();
    this.surface.triCDFTex.dispose();
    this.surface.sampleVertsTex.dispose();
    this.surface.sampleNormalsTex.dispose();
    this.surface = null;
  }

  setSDF(sdf) {
    if (this._sdfTex) {
      this._sdfTex.dispose();
      this._sdfTex = null;
    }
    if (!sdf || !sdf.texture) {
      this._sharedUniforms.sdfAtlas.value = null;
      this._sharedUniforms.uSdfReady.value = 0;
      return;
    }
    this._sdfTex = sdf.texture;
    this._sharedUniforms.sdfAtlas.value = sdf.texture;
    this._sharedUniforms.uSdfDim.value = sdf.dim ?? 32;
    this._sharedUniforms.uSdfBoundsMin.value.set(
      sdf.boundsMin[0], sdf.boundsMin[1], sdf.boundsMin[2]
    );
    const sx = sdf.boundsMax[0] - sdf.boundsMin[0];
    const sy = sdf.boundsMax[1] - sdf.boundsMin[1];
    const sz = sdf.boundsMax[2] - sdf.boundsMin[2];
    this._sharedUniforms.uSdfBoundsInvSize.value.set(
      sx > 1e-8 ? 1.0 / sx : 0,
      sy > 1e-8 ? 1.0 / sy : 0,
      sz > 1e-8 ? 1.0 / sz : 0
    );
    this._sharedUniforms.uSdfReady.value = 1;
  }

  setEmissionMode(mode) {
    const m = mode === "vertex" ? 1 : (mode === "edge" ? 2 : 0);
    this._sharedUniforms.uEmissionMode.value = m;
    this._needsForceRespawn = true;
  }

  setSimParams({ lifetime, lifetimeJitter, tangentSpeed, particleSize, particleSizeJitter, particleOpacity, speed } = {}) {
    if (lifetime !== undefined) this._sharedUniforms.uLifetime.value = lifetime;
    if (lifetimeJitter !== undefined) this._sharedUniforms.uLifetimeJitter.value = lifetimeJitter;
    if (tangentSpeed !== undefined) this._sharedUniforms.uTangentSpeed.value = tangentSpeed;
    if (particleSize !== undefined) this._renderUniforms.uPointSize.value = particleSize;
    if (particleSizeJitter !== undefined) this._renderUniforms.uPointSizeJitter.value = particleSizeJitter;
    if (particleOpacity !== undefined) this._renderUniforms.uParticleOpacity.value = particleOpacity;
    if (speed !== undefined) this._speed = speed;
  }

  setModifiers(mods) {
    let count = 0;
    let windX = 0, windY = 0, windZ = 0;
    const mu = this._modUniforms;

    for (const mod of mods) {
      if (!mod.enabled) continue;
      if (mod.type === "wind") {
        const [dx, dy, dz] = vectorFromAzEl(mod.params.azimuth, mod.params.elevation);
        windX += dx * mod.params.strength;
        windY += dy * mod.params.strength;
        windZ += dz * mod.params.strength;
      }

      const kind = KIND_BY_TYPE[mod.type];
      if (!kind) continue;
      if (count >= MAX_MODS) continue;

      const slot = count;
      mu.uModKind.value[slot] = kind;
      const p0 = mu.uModP0.value[slot];
      const p1 = mu.uModP1.value[slot];

      if (kind === KIND_WIND) {
        const [dx, dy, dz] = vectorFromAzEl(mod.params.azimuth, mod.params.elevation);
        p0.set(dx, dy, dz, mod.params.strength);
        p1.set(0, 0, 0, 0);
      } else if (kind === KIND_VORTEX) {
        const [ax, ay, az] = vectorFromAzEl(mod.params.axisAzimuth, mod.params.axisElevation);
        p0.set(ax, ay, az, mod.params.strength);
        const cx = mod.falloff.type === "sphere" ? mod.falloff.center[0] : 0;
        const cy = mod.falloff.type === "sphere" ? mod.falloff.center[1] : 0;
        const cz = mod.falloff.type === "sphere" ? mod.falloff.center[2] : 0;
        p1.set(cx, cy, cz, 0);
      } else if (kind === KIND_TURBULENCE) {
        p0.set(mod.params.strength, mod.params.scale ?? 1, mod.params.octaves ?? 3, 0);
        p1.set(0, 0, 0, 0);
      } else if (kind === KIND_CURLNOISE) {
        p0.set(mod.params.strength, mod.params.scale ?? 1.5, mod.params.octaves ?? 3, 0);
        p1.set(0, 0, 0, 0);
      } else if (kind === KIND_SURFACE) {
        p0.set(mod.params.strength, mod.params.tangentDamp ?? 0.85, 0, 0);
        p1.set(0, 0, 0, 0);
      } else if (kind === KIND_SURFACESLIDE) {
        p0.set(mod.params.strength, mod.params.tangentDamp ?? 0.95, 0, 0);
        p1.set(0, 0, 0, 0);
      } else {
        p0.set(mod.params.strength, 0, 0, 0);
        p1.set(0, 0, 0, 0);
      }

      const ft = mod.falloff.type === "sphere" ? 1 : 0;
      const fc = mod.falloff.center;
      mu.uModFalloff.value[slot].set(fc[0], fc[1], fc[2], ft);
      mu.uModFalloffR.value[slot].set(mod.falloff.inner, mod.falloff.outer);
      mu.uModOverlay.value[slot] = mod.overlay ? 1 : 0;

      count += 1;
    }

    for (let i = count; i < MAX_MODS; i += 1) {
      mu.uModKind.value[i] = KIND_NONE;
      mu.uModOverlay.value[i] = 0;
    }
    mu.uModCount.value = count;
    this._sharedUniforms.uSpawnWind.value.set(windX, windY, windZ);
  }

  setGradientStops(stops, mode, speedRef, fade) {
    if (this._gradTex) this._gradTex.dispose();
    this._gradTex = this._buildGradientTexture(stops);
    this._renderUniforms.gradTex.value = this._gradTex;
    this._renderUniforms.uColorMode.value = mode === "speed" ? 1 : (mode === "fixed" ? 2 : 0);
    this._renderUniforms.uColorSpeedRef.value = Math.max(speedRef ?? 5, 1e-3);
    this._renderUniforms.uColorFade.value = fade ?? 1;
    if (this._trailUniforms) {
      this._trailUniforms.gradTex.value = this._gradTex;
      this._trailUniforms.uColorMode.value = this._renderUniforms.uColorMode.value;
      this._trailUniforms.uColorSpeedRef.value = this._renderUniforms.uColorSpeedRef.value;
      this._trailUniforms.uColorFade.value = this._renderUniforms.uColorFade.value;
    }
  }

  setCount(count) {
    const c = Math.max(1, Math.min((count | 0), 4194304));
    this.count = c;
    const newSize = Math.max(1, Math.ceil(Math.sqrt(c)));
    if (newSize !== this.texSize) {
      this.texSize = newSize;
      this._rebuildCompute();
    }
    this._rebuildGeometry();
    this._needsForceRespawn = true;
    if (this._trailEnabled) {
      this._rebuildTrailHistory();
    }
  }

  _rebuildCompute() {
    this._disposeCompute();
    const W = this.texSize;
    const H = this.texSize;
    const gpuCompute = new GPUComputationRenderer(W, H, this.renderer);

    const initPos = gpuCompute.createTexture();
    const initVel = gpuCompute.createTexture();
    const pa = initPos.image.data;
    const va = initVel.image.data;
    const total = W * H;
    for (let i = 0; i < total; i += 1) {
      pa[i * 4]     = 0;
      pa[i * 4 + 1] = 0;
      pa[i * 4 + 2] = 0;
      pa[i * 4 + 3] = 1e6;
      va[i * 4]     = 0;
      va[i * 4 + 1] = 0;
      va[i * 4 + 2] = 0;
      va[i * 4 + 3] = 0;
    }

    const posVar = gpuCompute.addVariable("posTex", POS_FRAG, initPos);
    const velVar = gpuCompute.addVariable("velTex", VEL_FRAG, initVel);
    gpuCompute.setVariableDependencies(posVar, [posVar, velVar]);
    gpuCompute.setVariableDependencies(velVar, [posVar, velVar]);

    Object.assign(posVar.material.uniforms, this._sharedUniforms);
    Object.assign(velVar.material.uniforms, this._sharedUniforms, this._modUniforms);

    const error = gpuCompute.init();
    if (error !== null) {
      console.error("[GpuParticleSim] GPUComputationRenderer init error:", error);
    }

    this.gpuCompute = gpuCompute;
    this.posVar = posVar;
    this.velVar = velVar;
  }

  _disposeCompute() {
    if (!this.gpuCompute) return;
    const tryDispose = (v) => {
      if (!v) return;
      if (Array.isArray(v.renderTargets)) {
        for (const rt of v.renderTargets) {
          try { rt.dispose(); } catch (e) { /* noop */ }
        }
      }
    };
    tryDispose(this.posVar);
    tryDispose(this.velVar);
    this.gpuCompute = null;
    this.posVar = null;
    this.velVar = null;
  }

  _rebuildGeometry() {
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
    const N = this.count;
    const positions = new Float32Array(N * 3);
    const reference = new Float32Array(N * 2);
    const tex = this.texSize;
    for (let i = 0; i < N; i += 1) {
      const x = i % tex;
      const y = (i / tex) | 0;
      reference[i * 2]     = (x + 0.5) / tex;
      reference[i * 2 + 1] = (y + 0.5) / tex;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute("reference", new THREE.BufferAttribute(reference, 2));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    if (!this.points) {
      this.points = new THREE.Points(this.geometry, this._material);
      this.points.frustumCulled = false;
    } else {
      this.points.geometry = this.geometry;
    }
  }

  forceRespawn() {
    this._needsForceRespawn = true;
  }

  update(rawDt, time) {
    if (!this.gpuCompute || !this.posVar || !this.velVar || !this.surface) return;
    const dt = Math.min(Math.max(rawDt || 0, 0), 0.04) * this._speed;

    const u = this._sharedUniforms;
    u.uDt.value = dt;
    u.uTime.value = time;
    u.uForceRespawn.value = this._needsForceRespawn ? 1 : 0;

    this.gpuCompute.compute();
    this._needsForceRespawn = false;

    this._renderUniforms.posTex.value = this.gpuCompute.getCurrentRenderTarget(this.posVar).texture;
    this._renderUniforms.velTex.value = this.gpuCompute.getCurrentRenderTarget(this.velVar).texture;

    if (this._trailEnabled && this._trailKEff > 0) {
      // EMA of dt, used to compute "time between adjacent history slots"
      if (dt > 1e-5) {
        this._trailDtAvg = this._trailDtAvg * 0.92 + dt * 0.08;
      }
      // Sub-step: only capture posTex into history every uSubSteps actual frames.
      // Lets us cover trails longer than K * frame_dt at the cost of coarser segments.
      if (this._trailStepCounter % this._trailSubSteps === 0) {
        this._runTrailCopyPass();
        this._trailUniforms.uFrame.value = this._trailFrame;
        // Shader's uDtAvg = "per-stored-slot delta" = subSteps * actual_dt
        this._trailUniforms.uDtAvg.value = this._trailDtAvg * this._trailSubSteps;
        this._trailFrame += 1;
      }
      this._trailStepCounter += 1;
    }
  }

  getPoints() {
    return this.points;
  }

  getTrailMesh() {
    return this._trailMesh;
  }

  getTrailStatus() {
    return { ...this._trailStatus };
  }

  setTrailEnabled(enabled) {
    const next = !!enabled;
    if (next === this._trailEnabled) return this.getTrailStatus();
    this._trailEnabled = next;
    if (next) {
      this._ensureTrailScaffolding();
      this._rebuildTrailHistory();
      if (this._trailMesh) this._trailMesh.visible = !this._trailStatus.disabledByAlloc;
    } else {
      if (this._trailMesh) this._trailMesh.visible = false;
      // Free RTs immediately on disable to release VRAM
      this._disposeTrailHistory();
      this._trailStatus = { kEff: 0, kReq: this._trailKReq, vramMB: 0, truncatedByVram: false, disabledByAlloc: false };
    }
    return this.getTrailStatus();
  }

  setTrailParams({ sec, jitter, width, tailFade, vramBudgetMB, opacity } = {}) {
    const p = this._trailParams;
    let needsRebuild = false;
    if (sec !== undefined && sec !== p.sec) { p.sec = sec; needsRebuild = true; }
    if (vramBudgetMB !== undefined && vramBudgetMB !== p.vramBudgetMB) { p.vramBudgetMB = vramBudgetMB; needsRebuild = true; }
    if (jitter !== undefined) p.jitter = jitter;
    if (width !== undefined) p.width = width;
    if (tailFade !== undefined) p.tailFade = tailFade;
    if (opacity !== undefined) p.opacity = opacity;

    if (this._trailUniforms) {
      this._trailUniforms.uTrailJitter.value = p.jitter;
      this._trailUniforms.uTrailWidth.value = p.width;
      this._trailUniforms.uTailFade.value = p.tailFade;
      this._trailUniforms.uTrailOpacity.value = p.opacity;
    }

    if (this._trailEnabled && needsRebuild) {
      this._rebuildTrailHistory();
    }
    return this.getTrailStatus();
  }

  _computeTrailKEff() {
    // Target trail length expressed in real frames (assume 60fps).
    const targetFrames = Math.max(1, Math.round(this._trailParams.sec * 60));

    // Sub-step: if user wants more frames than TRAIL_MAX_K, sample every N actual
    // frames. Stored snapshots = ceil(target / N), capped at TRAIL_MAX_K.
    const subSteps = Math.max(1, Math.ceil(targetFrames / TRAIL_MAX_K));
    const kReq = Math.max(1, Math.ceil(targetFrames / subSteps));

    const bytesPerTexel = 16; // RGBA32F
    const texSizeSq = this.texSize * this.texSize;
    const budgetBytes = Math.max(1, this._trailParams.vramBudgetMB) * 1048576;
    const kVramLimit = Math.max(1, Math.floor(budgetBytes / Math.max(1, texSizeSq * bytesPerTexel)));
    const kEff = Math.max(1, Math.min(kReq, kVramLimit, TRAIL_MAX_K));
    return { kReq, kVramLimit, kEff, subSteps };
  }

  _ensureTrailScaffolding() {
    if (this._copyMesh && this._trailMesh && this._dummyTrailTex) return;

    if (!this._dummyTrailTex) {
      const dummyData = new Float32Array([0, 0, 0, 0]);
      this._dummyTrailTex = makeFloatTex(dummyData, 1, 1);
    }

    if (!this._copyMesh) {
      this._copyScene = new THREE.Scene();
      this._copyCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this._copyMaterial = new THREE.ShaderMaterial({
        uniforms: { uSrc: { value: null } },
        vertexShader: COPY_VERT,
        fragmentShader: COPY_FRAG,
        depthTest: false,
        depthWrite: false
      });
      const quad = new THREE.PlaneGeometry(2, 2);
      this._copyMesh = new THREE.Mesh(quad, this._copyMaterial);
      this._copyScene.add(this._copyMesh);
    }

    if (!this._trailMesh) {
      this._trailUniforms = {
        uHistory: { value: new Array(TRAIL_MAX_K).fill(this._dummyTrailTex) },
        velTex: { value: null },
        gradTex: { value: this._gradTex },
        uK: { value: 1 },
        uFrame: { value: 0 },
        uTrailWidth: { value: this._trailParams.width },
        uTrailJitter: { value: this._trailParams.jitter },
        uTailFade: { value: this._trailParams.tailFade },
        uDtAvg: { value: 1 / 60 },
        uColorMode: { value: this._renderUniforms.uColorMode.value },
        uColorSpeedRef: { value: this._renderUniforms.uColorSpeedRef.value },
        uColorFade: { value: this._renderUniforms.uColorFade.value },
        uTrailOpacity: { value: this._trailParams.opacity }
      };
      this._trailMaterial = new THREE.ShaderMaterial({
        uniforms: this._trailUniforms,
        vertexShader: TRAIL_VERT,
        fragmentShader: TRAIL_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
      });
      // Geometry built lazily in _rebuildTrailGeometry
      this._trailMesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), this._trailMaterial);
      this._trailMesh.frustumCulled = false;
      this._trailMesh.visible = false;
    }
  }

  _rebuildTrailHistory() {
    this._ensureTrailScaffolding();
    const { kReq, kVramLimit, kEff, subSteps } = this._computeTrailKEff();
    this._trailKReq = kReq;
    this._trailSubSteps = subSteps;

    // Free old RTs
    this._disposeTrailHistory();

    // Allocate K_eff RTs with try/catch fallback (halve K on failure)
    let attemptK = kEff;
    let allocated = [];
    while (attemptK >= 1) {
      try {
        const next = [];
        for (let i = 0; i < attemptK; i += 1) {
          const rt = new THREE.WebGLRenderTarget(this.texSize, this.texSize, {
            type: THREE.FloatType,
            format: THREE.RGBAFormat,
            magFilter: THREE.NearestFilter,
            minFilter: THREE.NearestFilter,
            wrapS: THREE.ClampToEdgeWrapping,
            wrapT: THREE.ClampToEdgeWrapping,
            depthBuffer: false,
            stencilBuffer: false
          });
          next.push(rt);
        }
        allocated = next;
        break;
      } catch (e) {
        console.warn("[trail] RT alloc failed at K=", attemptK, e);
        attemptK = Math.floor(attemptK / 2);
      }
    }

    if (allocated.length === 0) {
      this._trailKEff = 0;
      this._trailHistory = [];
      this._trailStatus = {
        kEff: 0,
        kReq,
        vramMB: 0,
        truncatedByVram: kEff < kReq,
        disabledByAlloc: true,
        subSteps
      };
      if (this._trailMesh) this._trailMesh.visible = false;
      return;
    }

    this._trailHistory = allocated;
    this._trailKEff = allocated.length;

    // Clear all RTs to zero so initial frames don't sample garbage
    const oldClear = new THREE.Color();
    this.renderer.getClearColor(oldClear);
    const oldClearAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    for (const rt of this._trailHistory) {
      this.renderer.setRenderTarget(rt);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(oldClear, oldClearAlpha);

    // Wire textures into shader uniforms (pad with dummy)
    const arr = new Array(TRAIL_MAX_K);
    for (let i = 0; i < TRAIL_MAX_K; i += 1) {
      arr[i] = i < this._trailKEff ? this._trailHistory[i].texture : this._dummyTrailTex;
    }
    this._trailUniforms.uHistory.value = arr;
    this._trailUniforms.uK.value = this._trailKEff;
    this._trailUniforms.gradTex.value = this._gradTex;

    // Reset counters so slot indexing starts fresh
    this._trailFrame = 0;
    this._trailStepCounter = 0;
    this._trailUniforms.uFrame.value = 0;

    // Build geometry sized for current N × (K_eff - 1)
    this._rebuildTrailGeometry();

    const vramBytes = this._trailKEff * this.texSize * this.texSize * 16;
    this._trailStatus = {
      kEff: this._trailKEff,
      kReq,
      vramMB: vramBytes / 1048576,
      truncatedByVram: this._trailKEff < kReq,
      disabledByAlloc: false,
      subSteps
    };
    if (this._trailMesh) this._trailMesh.visible = this._trailEnabled;
  }

  _rebuildTrailGeometry() {
    if (!this._trailMesh) return;
    const oldGeom = this._trailMesh.geometry;
    if (oldGeom) oldGeom.dispose();

    const N = this.count;
    const K = this._trailKEff;
    const segPerParticle = Math.max(0, K - 1);

    const geom = new THREE.InstancedBufferGeometry();

    // Quad template: 4 verts, position.x ∈ {0,1} (tail/head), position.y ∈ {-0.5, +0.5}
    const tplPos = new Float32Array([
      0, -0.5, 0,
      1, -0.5, 0,
      1,  0.5, 0,
      0,  0.5, 0
    ]);
    const tplIdx = new Uint16Array([0, 1, 2, 0, 2, 3]);
    geom.setAttribute("position", new THREE.BufferAttribute(tplPos, 3));
    geom.setIndex(new THREE.BufferAttribute(tplIdx, 1));

    const totalInst = N * segPerParticle;
    if (totalInst > 0) {
      const refs = new Float32Array(totalInst * 2);
      const segs = new Float32Array(totalInst);
      const tex = this.texSize;
      for (let i = 0; i < N; i += 1) {
        const x = i % tex;
        const y = (i / tex) | 0;
        const u = (x + 0.5) / tex;
        const v = (y + 0.5) / tex;
        for (let s = 0; s < segPerParticle; s += 1) {
          const idx = i * segPerParticle + s;
          refs[idx * 2]     = u;
          refs[idx * 2 + 1] = v;
          segs[idx]         = s;
        }
      }
      const refAttr = new THREE.InstancedBufferAttribute(refs, 2);
      const segAttr = new THREE.InstancedBufferAttribute(segs, 1);
      geom.setAttribute("reference", refAttr);
      geom.setAttribute("aSegIdx", segAttr);
      geom.instanceCount = totalInst;
    } else {
      geom.instanceCount = 0;
    }
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this._trailMesh.geometry = geom;
    this._trailGeom = geom;
  }

  _runTrailCopyPass() {
    if (!this.gpuCompute || !this.posVar) return;
    const K = this._trailHistory.length;
    if (K === 0) return;
    const dst = this._trailHistory[this._trailFrame % K];
    const srcRT = this.gpuCompute.getCurrentRenderTarget(this.posVar);
    if (!srcRT || !dst) return;
    this._copyMaterial.uniforms.uSrc.value = srcRT.texture;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(dst);
    this.renderer.render(this._copyScene, this._copyCam);
    this.renderer.setRenderTarget(prev);

    // Wire latest velTex / gradTex / color uniforms (cheap; covers gradient changes too)
    this._trailUniforms.velTex.value = this._renderUniforms.velTex.value;
    this._trailUniforms.gradTex.value = this._gradTex;
    this._trailUniforms.uColorMode.value = this._renderUniforms.uColorMode.value;
    this._trailUniforms.uColorSpeedRef.value = this._renderUniforms.uColorSpeedRef.value;
    this._trailUniforms.uColorFade.value = this._renderUniforms.uColorFade.value;
    // NOTE: do NOT increment _trailFrame here. Caller in update() must read
    // _trailFrame as "the slot just written" before bumping it. Otherwise the
    // shader's seg=0 read points to a K-frame-stale slot.
  }

  _disposeTrailHistory() {
    if (this._trailHistory && this._trailHistory.length) {
      for (const rt of this._trailHistory) {
        try { rt.dispose(); } catch (_) { /* noop */ }
      }
    }
    this._trailHistory = [];
    this._trailKEff = 0;
    if (this._trailUniforms) {
      const arr = new Array(TRAIL_MAX_K).fill(this._dummyTrailTex);
      this._trailUniforms.uHistory.value = arr;
      this._trailUniforms.uK.value = 1;
    }
  }

  _disposeTrail() {
    this._disposeTrailHistory();
    if (this._trailGeom) { try { this._trailGeom.dispose(); } catch (_) {} this._trailGeom = null; }
    if (this._trailMaterial) { try { this._trailMaterial.dispose(); } catch (_) {} this._trailMaterial = null; }
    if (this._copyMesh) {
      try { this._copyMesh.geometry.dispose(); } catch (_) {}
      this._copyMesh = null;
    }
    if (this._copyMaterial) { try { this._copyMaterial.dispose(); } catch (_) {} this._copyMaterial = null; }
    if (this._dummyTrailTex) { try { this._dummyTrailTex.dispose(); } catch (_) {} this._dummyTrailTex = null; }
    this._trailMesh = null;
    this._trailUniforms = null;
    this._copyScene = null;
    this._copyCam = null;
  }

  dispose() {
    window.removeEventListener("resize", this._resizeListener);
    this._disposeCompute();
    this._disposeSurface();
    this._disposeTrail();
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
    if (this._material) {
      this._material.dispose();
      this._material = null;
    }
    if (this._gradTex) {
      this._gradTex.dispose();
      this._gradTex = null;
    }
    this.points = null;
  }
}

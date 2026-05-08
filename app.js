import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GpuParticleSim } from "./gpuSim.js";

const canvas = document.querySelector("#sceneCanvas");
const viewport = document.querySelector("#dropZone");
const modelInput = document.querySelector("#modelInput");
const modelStatus = document.querySelector("#modelStatus");
const fileName = document.querySelector("#fileName");
const vertexCount = document.querySelector("#vertexCount");
const particleCount = document.querySelector("#particleCount");
const playPause = document.querySelector("#playPause");
const timeScrub = document.querySelector("#timeScrub");
const fpsReadout = document.querySelector("#fpsReadout");
const fitCamera = document.querySelector("#fitCamera");
const resetScene = document.querySelector("#resetScene");
const presetNameInput = document.querySelector("#presetName");
const presetSaveBtn = document.querySelector("#presetSave");
const presetListEl = document.querySelector("#presetList");
const presetEmptyEl = document.querySelector("#presetEmpty");
const showModel = document.querySelector("#showModel");
const showGrid = document.querySelector("#showGrid");
const recordVideoBtn = document.querySelector("#recordVideo");
const exportPlyBtn = document.querySelector("#exportPly");
const renderModeLabel = document.querySelector("#renderModeLabel");
const renderModeControls = document.querySelector("#renderModeControls");

const modifierStackEl = document.querySelector("#modifierStack");
const modifierTypePicker = document.querySelector("#modifierTypePicker");
const addModifierBtn = document.querySelector("#addModifier");

const emissionModeControls = document.querySelector("#emissionModeControls");
const colorModeControls = document.querySelector("#colorModeControls");
const gradientPreviewEl = document.querySelector("#gradientPreview");
const gradientStopsEl = document.querySelector("#gradientStops");
const addGradientStopBtn = document.querySelector("#addGradientStop");
const colorSpeedRefInput = document.querySelector("#colorSpeedRef");
const colorSpeedRefRow = document.querySelector("#colorSpeedRefRow");
const colorFadeInput = document.querySelector("#colorFade");

const controlsConfig = {
  renderMode: "hybrid",
  density: document.querySelector("#density"),
  speed: document.querySelector("#speed"),
  particleSize: document.querySelector("#particleSize"),
  particleSizeJitter: document.querySelector("#particleSizeJitter"),
  lifetime: document.querySelector("#lifetime"),
  lifetimeJitter: document.querySelector("#lifetimeJitter"),
  tangentSpeed: document.querySelector("#tangentSpeed"),
  materialColor: document.querySelector("#materialColor"),
  materialMetalness: document.querySelector("#materialMetalness"),
  materialRoughness: document.querySelector("#materialRoughness"),
  materialOpacity: document.querySelector("#materialOpacity"),
  wireColor: document.querySelector("#wireColor"),
  wireOpacity: document.querySelector("#wireOpacity"),
  keyLightColor: document.querySelector("#keyLightColor"),
  ambientLightColor: document.querySelector("#ambientLightColor"),
  keyLightIntensity: document.querySelector("#keyLightIntensity"),
  ambientLightIntensity: document.querySelector("#ambientLightIntensity"),
  fillLightIntensity: document.querySelector("#fillLightIntensity"),
  rimLightIntensity: document.querySelector("#rimLightIntensity"),
  lightAzimuth: document.querySelector("#lightAzimuth"),
  lightElevation: document.querySelector("#lightElevation"),
  exposure: document.querySelector("#exposure")
};

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101114);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
camera.position.set(2.8, 1.6, 3.8);

const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(3, 4, 5);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x7fdcff, 0.7);
fillLight.position.set(-4, 1.6, 2.5);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xffc36b, 1.15);
rimLight.position.set(-2.5, 3.2, -4);
scene.add(rimLight);

const ambientLight = new THREE.AmbientLight(0xaab8ff, 0.9);
scene.add(ambientLight);

const grid = new THREE.GridHelper(8, 32, 0x2c3239, 0x20242b);
grid.position.y = -1.25;
scene.add(grid);

let modelRoot = new THREE.Group();
let surfaceSamples = null;
let emissionMode = "surface";
let modelBounds = new THREE.Box3();
let modelMeshes = [];
let densityDebounceTimer = 0;

let isPlaying = true;
let clock = new THREE.Clock();
let animationTime = 0;
let frameCount = 0;
let frameWindow = performance.now();

let colorMode = "age";
let gradientStopIdSeq = 0;
function makeStop(pos, color) {
  return { id: ++gradientStopIdSeq, pos, color, cached: new THREE.Color(color) };
}
let gradientStops = [
  makeStop(0, "#57d4ff"),
  makeStop(1, "#ff8f1f")
];
const tmpColor = new THREE.Color();

function sortGradientStops() {
  gradientStops.sort((a, b) => a.pos - b.pos);
}

function sampleGradient(t, out) {
  const stops = gradientStops;
  const n = stops.length;
  if (n === 0) { out.set(0xffffff); return; }
  if (n === 1) { out.copy(stops[0].cached); return; }
  if (t <= stops[0].pos) { out.copy(stops[0].cached); return; }
  const last = stops[n - 1];
  if (t >= last.pos) { out.copy(last.cached); return; }
  for (let i = 0; i < n - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (t <= b.pos) {
      const span = b.pos - a.pos;
      const localT = span > 1e-6 ? (t - a.pos) / span : 0;
      out.copy(a.cached).lerp(b.cached, localT);
      return;
    }
  }
  out.copy(last.cached);
}

function createParticleTexture() {
  const size = 128;
  const canvasEl = document.createElement("canvas");
  canvasEl.width = size;
  canvasEl.height = size;
  const ctx = canvasEl.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.55)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvasEl);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const particleTexture = createParticleTexture();

const MODIFIER_DEFS = {
  wind: {
    label: "风",
    description: "全局方向力",
    defaults: { strength: 2.0, azimuth: 0, elevation: 8 },
    paramSchema: [
      { key: "strength", label: "强度", min: 0, max: 8, step: 0.01 },
      { key: "azimuth", label: "方位角", min: -180, max: 180, step: 1 },
      { key: "elevation", label: "仰角", min: -85, max: 85, step: 1 }
    ]
  },
  turbulence: {
    label: "湍流",
    description: "3D value noise + fBm 多倍频叠加",
    defaults: { strength: 0.9, scale: 1.5, octaves: 3 },
    paramSchema: [
      { key: "strength", label: "强度", min: 0, max: 4, step: 0.01 },
      { key: "scale", label: "尺度", min: 0.3, max: 12, step: 0.1 },
      { key: "octaves", label: "倍频数", min: 1, max: 6, step: 1 }
    ]
  },
  drag: {
    label: "阻力",
    description: "Stokes 阻尼，让粒子减速归零",
    defaults: { strength: 1.4 },
    paramSchema: [
      { key: "strength", label: "强度", min: 0, max: 6, step: 0.01 }
    ]
  },
  gravity: {
    label: "重力",
    description: "Y 轴向下加速度（负值倒置）",
    defaults: { strength: 0.3 },
    paramSchema: [
      { key: "strength", label: "强度", min: -3, max: 3, step: 0.01 }
    ]
  },
  vortex: {
    label: "漩涡",
    description: "围绕指定轴旋转（轴穿过 falloff 中心；无 falloff 时穿过原点）",
    defaults: { strength: 1.5, axisAzimuth: 0, axisElevation: 90 },
    paramSchema: [
      { key: "strength", label: "强度", min: -4, max: 4, step: 0.01 },
      { key: "axisAzimuth", label: "轴方位角", min: -180, max: 180, step: 1 },
      { key: "axisElevation", label: "轴仰角", min: -85, max: 85, step: 1 }
    ]
  },
  randomKick: {
    label: "随机扰动",
    description: "每帧无相关随机推力",
    defaults: { strength: 0.15 },
    paramSchema: [
      { key: "strength", label: "强度", min: 0, max: 2, step: 0.01 }
    ]
  },
  surfaceStick: {
    label: "表面捕获",
    description: "把粒子拉回出生表面点，并按比例消掉法向速度——其他力（湍流/风）只能沿切平面推动粒子",
    defaults: { strength: 3.0, tangentDamp: 0.85 },
    paramSchema: [
      { key: "strength", label: "捕获强度", min: 0, max: 12, step: 0.05 },
      { key: "tangentDamp", label: "法向阻尼", min: 0, max: 1, step: 0.01 }
    ]
  },
  cohesion: {
    label: "群聚",
    description: "粒子互相聚拢 + 速度对齐 + 近距避让，形成丝缕",
    defaults: {
      strength: 1.0,
      cohesionStrength: 1.6,
      alignmentStrength: 2.4,
      separationStrength: 2.0,
      radius: 0.12,
      maxNeighbors: 16
    },
    paramSchema: [
      { key: "strength", label: "总强度", min: 0, max: 4, step: 0.01 },
      { key: "cohesionStrength", label: "聚拢", min: 0, max: 6, step: 0.05 },
      { key: "alignmentStrength", label: "对齐", min: 0, max: 6, step: 0.05 },
      { key: "separationStrength", label: "避让", min: 0, max: 6, step: 0.05 },
      { key: "radius", label: "邻域半径", min: 0.03, max: 0.5, step: 0.005 },
      { key: "maxNeighbors", label: "邻居上限", min: 4, max: 32, step: 1 }
    ]
  }
};

let modifierIdSeq = 0;
function makeModifier(type) {
  const def = MODIFIER_DEFS[type];
  if (!def) throw new Error(`未知 modifier 类型：${type}`);
  return {
    id: ++modifierIdSeq,
    type,
    enabled: true,
    overlay: false,
    collapsed: false,
    params: { ...def.defaults },
    falloff: { type: "none", center: [0, 0, 0], inner: 0.6, outer: 2.5 }
  };
}

let modifiers = [
  makeModifier("wind"),
  makeModifier("turbulence"),
  makeModifier("drag"),
  makeModifier("gravity"),
  makeModifier("randomKick")
];

const surfaceStickDefault = makeModifier("surfaceStick");
surfaceStickDefault.enabled = false;
surfaceStickDefault.collapsed = true;
modifiers.push(surfaceStickDefault);

const cohesionDefault = makeModifier("cohesion");
cohesionDefault.enabled = false;
cohesionDefault.collapsed = true;
modifiers.push(cohesionDefault);


scene.add(modelRoot);

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.round(value));
}

function setStatus(text) {
  modelStatus.textContent = text;
}

function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => material.dispose());
    }
  });
}

function createFallbackMaterial() {
  return new THREE.MeshStandardMaterial({
    color: controlsConfig.materialColor.value,
    metalness: Number(controlsConfig.materialMetalness.value),
    roughness: Number(controlsConfig.materialRoughness.value),
    transparent: true,
    opacity: Number(controlsConfig.materialOpacity.value)
  });
}

function cloneMeshMaterial(material) {
  if (!material) return createFallbackMaterial();
  if (Array.isArray(material)) return material.map((item) => cloneMeshMaterial(item));
  const cloned = material.clone();
  cloned.transparent = true;
  return cloned;
}

function createWireMaterial() {
  return new THREE.MeshBasicMaterial({
    color: controlsConfig.wireColor.value,
    wireframe: true,
    transparent: true,
    opacity: Number(controlsConfig.wireOpacity.value),
    depthWrite: false
  });
}

function applyMaterialControls(material) {
  if (Array.isArray(material)) {
    material.forEach(applyMaterialControls);
    return;
  }

  if (material.color && !material.map) {
    material.color.set(controlsConfig.materialColor.value);
  }
  if ("metalness" in material) material.metalness = Number(controlsConfig.materialMetalness.value);
  if ("roughness" in material) material.roughness = Number(controlsConfig.materialRoughness.value);
  material.transparent = Number(controlsConfig.materialOpacity.value) < 1;
  material.opacity = Number(controlsConfig.materialOpacity.value);
  material.needsUpdate = true;
}

function prepareModelMaterials(root) {
  modelMeshes = [];
  root.traverse((child) => {
    if (!child.isMesh || child.userData.isWireOverlay) return;
    modelMeshes.push(child);
  });

  modelMeshes.forEach((mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.baseMaterial = cloneMeshMaterial(mesh.material);
    mesh.userData.wireMaterial = createWireMaterial();

    const wireOverlay = new THREE.Mesh(mesh.geometry, mesh.userData.wireMaterial);
    wireOverlay.name = `${mesh.name || "mesh"}_wire_overlay`;
    wireOverlay.userData.isWireOverlay = true;
    wireOverlay.renderOrder = 2;
    wireOverlay.visible = false;
    mesh.add(wireOverlay);
    mesh.userData.wireOverlay = wireOverlay;
  });

  applyModelRenderSettings();
}

function applyModelRenderSettings() {
  modelMeshes.forEach((mesh) => {
    const baseMaterial = mesh.userData.baseMaterial || createFallbackMaterial();
    const wireMaterial = mesh.userData.wireMaterial || createWireMaterial();
    const overlay = mesh.userData.wireOverlay;

    applyMaterialControls(baseMaterial);
    wireMaterial.color.set(controlsConfig.wireColor.value);
    wireMaterial.opacity = Number(controlsConfig.wireOpacity.value);
    wireMaterial.needsUpdate = true;

    if (controlsConfig.renderMode === "wireframe") {
      mesh.material = wireMaterial;
      if (overlay) overlay.visible = false;
    } else {
      mesh.material = baseMaterial;
      if (overlay) overlay.visible = controlsConfig.renderMode === "hybrid";
    }
  });
}

function updateLighting() {
  const azimuth = THREE.MathUtils.degToRad(Number(controlsConfig.lightAzimuth.value));
  const elevation = THREE.MathUtils.degToRad(Number(controlsConfig.lightElevation.value));
  const distance = 5;
  const horizontal = Math.cos(elevation) * distance;

  keyLight.color.set(controlsConfig.keyLightColor.value);
  keyLight.intensity = Number(controlsConfig.keyLightIntensity.value);
  keyLight.position.set(Math.cos(azimuth) * horizontal, Math.sin(elevation) * distance, Math.sin(azimuth) * horizontal);

  ambientLight.color.set(controlsConfig.ambientLightColor.value);
  ambientLight.intensity = Number(controlsConfig.ambientLightIntensity.value);
  fillLight.intensity = Number(controlsConfig.fillLightIntensity.value);
  rimLight.intensity = Number(controlsConfig.rimLightIntensity.value);
  renderer.toneMappingExposure = Number(controlsConfig.exposure.value);
}

function normalizeModel(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const maxAxis = Math.max(size.x, size.y, size.z) || 1;
  const scaleFactor = 2.35 / maxAxis;

  root.scale.multiplyScalar(scaleFactor);
  root.updateMatrixWorld(true);
  const scaledCenter = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  root.position.sub(scaledCenter);
  root.updateMatrixWorld(true);

  modelBounds = new THREE.Box3().setFromObject(root);
  prepareModelMaterials(root);
}

function collectSurfaceSamples(root) {
  const positions = [];
  const normals = [];
  const tVerts = [];
  const tNorms = [];
  const cdf = [];
  let cumulative = 0;

  const tempPos = new THREE.Vector3();
  const tempNormal = new THREE.Vector3();
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const na = new THREE.Vector3();
  const nb = new THREE.Vector3();
  const nc = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();

  function normalizeOrFallback(n, fallbackPos) {
    const len = n.length();
    if (len > 1e-6) {
      n.divideScalar(len);
      return;
    }
    n.copy(fallbackPos);
    const l2 = n.length();
    if (l2 > 1e-6) n.divideScalar(l2);
    else n.set(0, 1, 0);
  }

  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (!child.isMesh || child.userData.isWireOverlay || !child.geometry?.attributes?.position) return;

    const original = child.geometry;
    let triGeom = original;
    let triOwned = false;
    if (original.index) {
      triGeom = original.toNonIndexed();
      triOwned = true;
    }
    if (!triGeom.attributes.normal) {
      if (!triOwned) {
        triGeom = triGeom.clone();
        triOwned = true;
      }
      triGeom.computeVertexNormals();
    }

    let vertGeom = original;
    let vertOwned = false;
    if (!vertGeom.attributes.normal) {
      vertGeom = vertGeom.clone();
      vertGeom.computeVertexNormals();
      vertOwned = true;
    }

    normalMatrix.getNormalMatrix(child.matrixWorld);

    const uPos = vertGeom.attributes.position;
    const uNorm = vertGeom.attributes.normal;
    for (let i = 0; i < uPos.count; i += 1) {
      tempPos.fromBufferAttribute(uPos, i).applyMatrix4(child.matrixWorld);
      tempNormal.fromBufferAttribute(uNorm, i).applyMatrix3(normalMatrix);
      normalizeOrFallback(tempNormal, tempPos);
      positions.push(tempPos.x, tempPos.y, tempPos.z);
      normals.push(tempNormal.x, tempNormal.y, tempNormal.z);
    }

    const tPos = triGeom.attributes.position;
    const tNorm = triGeom.attributes.normal;
    const triN = (tPos.count / 3) | 0;
    for (let t = 0; t < triN; t += 1) {
      const aIdx = t * 3;
      va.fromBufferAttribute(tPos, aIdx).applyMatrix4(child.matrixWorld);
      vb.fromBufferAttribute(tPos, aIdx + 1).applyMatrix4(child.matrixWorld);
      vc.fromBufferAttribute(tPos, aIdx + 2).applyMatrix4(child.matrixWorld);
      na.fromBufferAttribute(tNorm, aIdx).applyMatrix3(normalMatrix);
      nb.fromBufferAttribute(tNorm, aIdx + 1).applyMatrix3(normalMatrix);
      nc.fromBufferAttribute(tNorm, aIdx + 2).applyMatrix3(normalMatrix);
      normalizeOrFallback(na, va);
      normalizeOrFallback(nb, vb);
      normalizeOrFallback(nc, vc);

      tVerts.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
      tNorms.push(na.x, na.y, na.z, nb.x, nb.y, nb.z, nc.x, nc.y, nc.z);

      edge1.subVectors(vb, va);
      edge2.subVectors(vc, va);
      cross.crossVectors(edge1, edge2);
      cumulative += cross.length() * 0.5;
      cdf.push(cumulative);
    }

    if (triOwned) triGeom.dispose();
    if (vertOwned) vertGeom.dispose();
  });

  if (cumulative > 1e-12) {
    for (let i = 0; i < cdf.length; i += 1) cdf[i] /= cumulative;
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    triVerts: new Float32Array(tVerts),
    triNormals: new Float32Array(tNorms),
    triCDF: new Float32Array(cdf),
    triCount: cdf.length
  };
}

const sim = new GpuParticleSim(renderer, particleTexture);
let simAddedToScene = false;

function pushColorsToSim() {
  sortGradientStops();
  sim.setGradientStops(
    gradientStops.map((s) => ({ pos: s.pos, color: s.color })),
    colorMode,
    Number(colorSpeedRefInput.value),
    Number(colorFadeInput.value)
  );
}

function pushSimParams() {
  sim.setSimParams({
    lifetime: Number(controlsConfig.lifetime.value),
    lifetimeJitter: Number(controlsConfig.lifetimeJitter.value),
    tangentSpeed: Number(controlsConfig.tangentSpeed.value),
    particleSize: Number(controlsConfig.particleSize.value),
    particleSizeJitter: Number(controlsConfig.particleSizeJitter.value),
    speed: Number(controlsConfig.speed.value)
  });
}

function pushModifiers() {
  sim.setModifiers(modifiers);
}

function rebuildParticles() {
  if (!surfaceSamples) return;
  sim.setSurfaceData(surfaceSamples);
  const desiredCount = Number(controlsConfig.density.value);
  sim.setCount(desiredCount);
  sim.setEmissionMode(emissionMode);
  pushModifiers();
  pushColorsToSim();
  pushSimParams();
  const points = sim.getPoints();
  if (points && !simAddedToScene) {
    scene.add(points);
    simAddedToScene = true;
  }
  particleCount.textContent = formatNumber(desiredCount);
}

function updateParticleFrame(delta) {
  pushModifiers();
  pushSimParams();
  sim.update(delta, animationTime);
}

function fitView() {
  const box = modelBounds.isEmpty() ? new THREE.Box3().setFromObject(modelRoot) : modelBounds;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z, 1);
  const distance = maxSize / (2 * Math.tan((camera.fov * Math.PI) / 360));

  camera.position.copy(center).add(new THREE.Vector3(distance * 0.9, distance * 0.55, distance * 1.25));
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  orbit.target.copy(center);
  orbit.update();
}

function setModel(root, name = "model") {
  disposeObject(modelRoot);
  scene.remove(modelRoot);
  modelRoot = root;
  scene.add(modelRoot);
  normalizeModel(modelRoot);
  const samples = collectSurfaceSamples(modelRoot);
  surfaceSamples = {
    samplePositions: samples.positions,
    sampleNormals: samples.normals,
    triVerts: samples.triVerts,
    triNormals: samples.triNormals,
    triCDF: samples.triCDF,
    triCount: samples.triCount
  };
  vertexCount.textContent = formatNumber(samples.positions.length / 3);
  fileName.textContent = name;
  showModel.checked = true;
  modelRoot.visible = true;
  rebuildParticles();
  fitView();
  setStatus("模型已载入，粒子从模型表面持续发射");
}

function createDemoModel() {
  const group = new THREE.Group();
  const glassyBlue = new THREE.MeshStandardMaterial({
    color: 0x8eeeff,
    emissive: 0x123a44,
    metalness: 0.18,
    roughness: 0.28,
    transparent: true,
    opacity: 0.2
  });
  const darkTire = new THREE.MeshStandardMaterial({
    color: 0x223038,
    metalness: 0.1,
    roughness: 0.46,
    transparent: true,
    opacity: 0.48
  });

  const side = new THREE.Shape();
  side.moveTo(-1.45, -0.18);
  side.lineTo(-1.35, 0.08);
  side.bezierCurveTo(-1.08, 0.22, -0.82, 0.28, -0.54, 0.28);
  side.bezierCurveTo(-0.32, 0.55, -0.02, 0.7, 0.34, 0.66);
  side.bezierCurveTo(0.66, 0.58, 0.86, 0.34, 1.12, 0.24);
  side.bezierCurveTo(1.32, 0.18, 1.42, 0.02, 1.48, -0.16);
  side.lineTo(1.24, -0.28);
  side.lineTo(-1.2, -0.28);
  side.closePath();

  const carShell = new THREE.Mesh(
    new THREE.ExtrudeGeometry(side, {
      depth: 0.82,
      bevelEnabled: true,
      bevelThickness: 0.035,
      bevelSize: 0.04,
      bevelSegments: 2,
      curveSegments: 18
    }),
    glassyBlue.clone()
  );
  carShell.position.z = -0.41;
  group.add(carShell);

  const hoodLine = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.025, 0.86, 8, 1, 8), glassyBlue.clone());
  hoodLine.position.set(-0.92, 0.27, 0);
  hoodLine.rotation.z = 0.06;
  group.add(hoodLine);

  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.62, 1, 3, 8), glassyBlue.clone());
  grille.position.set(-1.48, -0.02, 0);
  group.add(grille);

  const wheelGeometry = new THREE.TorusGeometry(0.18, 0.055, 14, 34);
  [
    [-0.82, -0.18, -0.45],
    [0.74, -0.18, -0.45],
    [-0.82, -0.18, 0.45],
    [0.74, -0.18, 0.45]
  ].forEach(([x, y, z]) => {
    const wheel = new THREE.Mesh(wheelGeometry, darkTire.clone());
    wheel.position.set(x, y, z);
    wheel.rotation.y = Math.PI / 2;
    group.add(wheel);
  });

  const headlightMaterial = new THREE.MeshStandardMaterial({
    color: 0xbff8ff,
    emissive: 0x78eaff,
    emissiveIntensity: 1.4,
    transparent: true,
    opacity: 0.78
  });
  [-0.24, 0.24].forEach((z) => {
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 0.16), headlightMaterial.clone());
    light.position.set(-1.43, 0.1, z);
    group.add(light);
  });

  group.rotation.y = -0.16;
  setModel(group, "wire car demo");
}

function createLoadingManager(files) {
  const objectUrls = new Map();
  files.forEach((file) => objectUrls.set(file.name, URL.createObjectURL(file)));

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const cleanUrl = url.split("/").pop();
    return objectUrls.get(cleanUrl) || url;
  });

  return {
    manager,
    release() {
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    }
  };
}

async function loadFiles(fileList) {
  const files = Array.from(fileList);
  const primary = files.find((file) => /\.(glb|gltf|obj)$/i.test(file.name));
  if (!primary) {
    setStatus("请选择 .glb、.gltf 或 .obj 文件");
    return;
  }

  setStatus("正在解析模型");
  const { manager, release } = createLoadingManager(files);
  const primaryUrl = URL.createObjectURL(primary);
  const extension = primary.name.split(".").pop().toLowerCase();

  try {
    if (extension === "obj") {
      const loader = new OBJLoader(manager);
      const object = await loader.loadAsync(primaryUrl);
      setModel(object, primary.name);
    } else {
      const loader = new GLTFLoader(manager);
      const gltf = await loader.loadAsync(primaryUrl);
      setModel(gltf.scene, primary.name);
    }
  } catch (error) {
    console.error(error);
    setStatus("模型解析失败，请确认文件完整或优先使用 GLB");
  } finally {
    URL.revokeObjectURL(primaryUrl);
    release();
  }
}

function updateRendererSize() {
  const { clientWidth, clientHeight } = viewport;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / Math.max(clientHeight, 1);
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  if (isPlaying) {
    animationTime += delta;
    timeScrub.value = Math.floor((animationTime * 90) % 1000);
  }
  updateParticleFrame(isPlaying ? delta : 0);
  orbit.update();
  renderer.render(scene, camera);

  frameCount += 1;
  const now = performance.now();
  if (now - frameWindow > 700) {
    fpsReadout.textContent = `${Math.round((frameCount * 1000) / (now - frameWindow))} fps`;
    frameCount = 0;
    frameWindow = now;
  }
}

modelInput.addEventListener("change", (event) => loadFiles(event.target.files));

["dragenter", "dragover"].forEach((type) => {
  viewport.addEventListener(type, (event) => {
    event.preventDefault();
    viewport.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((type) => {
  viewport.addEventListener(type, (event) => {
    event.preventDefault();
    viewport.classList.remove("dragging");
  });
});

viewport.addEventListener("drop", (event) => loadFiles(event.dataTransfer.files));

playPause.addEventListener("click", () => {
  isPlaying = !isPlaying;
  playPause.textContent = isPlaying ? "暂停" : "播放";
});

timeScrub.addEventListener("input", () => {
  animationTime = Number(timeScrub.value) / 90;
});

fitCamera.addEventListener("click", fitView);
resetScene.addEventListener("click", createDemoModel);

renderModeControls.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-render-mode]");
  if (!button) return;
  renderModeControls.querySelectorAll("button").forEach((item) => item.classList.remove("selected"));
  button.classList.add("selected");
  controlsConfig.renderMode = button.dataset.renderMode;
  renderModeLabel.textContent = button.textContent;
  applyModelRenderSettings();
});

controlsConfig.density.addEventListener("input", () => {
  clearTimeout(densityDebounceTimer);
  densityDebounceTimer = setTimeout(() => rebuildParticles(), 180);
  particleCount.textContent = formatNumber(Number(controlsConfig.density.value));
});

function updateGradientPreview() {
  const sorted = [...gradientStops].sort((a, b) => a.pos - b.pos);
  const css = sorted.map((s) => `${s.color} ${(s.pos * 100).toFixed(2)}%`).join(", ");
  gradientPreviewEl.style.background = `linear-gradient(90deg, ${css})`;
}

function renderGradientStops() {
  gradientStopsEl.innerHTML = "";
  const visual = [...gradientStops].sort((a, b) => a.pos - b.pos);
  visual.forEach((stop) => {
    const row = document.createElement("div");
    row.className = "gradient-stop";
    row.dataset.stopId = String(stop.id);
    row.innerHTML = `
      <input type="color" value="${stop.color}" data-stop="color" />
      <input type="range" min="0" max="1" step="0.001" value="${stop.pos}" data-stop="pos" />
      <span class="gradient-stop-pos">${stop.pos.toFixed(2)}</span>
      <button type="button" class="gradient-delete" ${gradientStops.length <= 2 ? "disabled" : ""}>×</button>
    `;
    gradientStopsEl.appendChild(row);
  });
  updateGradientPreview();
}

function findStopForElement(el) {
  const row = el.closest(".gradient-stop");
  if (!row) return null;
  const id = Number(row.dataset.stopId);
  return gradientStops.find((s) => s.id === id) || null;
}

gradientStopsEl.addEventListener("input", (event) => {
  const target = event.target;
  const stop = findStopForElement(target);
  if (!stop) return;
  const row = target.closest(".gradient-stop");
  if (target.dataset.stop === "color") {
    stop.color = target.value;
    stop.cached.set(target.value);
    updateGradientPreview();
  } else if (target.dataset.stop === "pos") {
    stop.pos = Number(target.value);
    const posLabel = row.querySelector(".gradient-stop-pos");
    if (posLabel) posLabel.textContent = stop.pos.toFixed(2);
    updateGradientPreview();
  }
  pushColorsToSim();
});

gradientStopsEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!target.classList.contains("gradient-delete")) return;
  if (gradientStops.length <= 2) return;
  const stop = findStopForElement(target);
  if (!stop) return;
  gradientStops = gradientStops.filter((s) => s.id !== stop.id);
  renderGradientStops();
  pushColorsToSim();
});

addGradientStopBtn.addEventListener("click", () => {
  const sorted = [...gradientStops].sort((a, b) => a.pos - b.pos);
  let bestGap = -1;
  let bestPos = 0.5;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const gap = sorted[i + 1].pos - sorted[i].pos;
    if (gap > bestGap) {
      bestGap = gap;
      bestPos = (sorted[i + 1].pos + sorted[i].pos) / 2;
    }
  }
  sampleGradient(bestPos, tmpColor);
  const hex = `#${tmpColor.getHexString()}`;
  gradientStops.push(makeStop(bestPos, hex));
  renderGradientStops();
  pushColorsToSim();
});

function setColorMode(mode) {
  colorMode = mode;
  colorModeControls.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("selected", b.dataset.colorMode === mode);
  });
  colorSpeedRefRow.style.display = mode === "speed" ? "" : "none";
  pushColorsToSim();
}

colorModeControls.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-color-mode]");
  if (!button) return;
  setColorMode(button.dataset.colorMode);
});

colorSpeedRefInput.addEventListener("input", pushColorsToSim);
colorFadeInput.addEventListener("input", pushColorsToSim);

emissionModeControls.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-emission-mode]");
  if (!button) return;
  emissionModeControls.querySelectorAll("button").forEach((b) => b.classList.remove("selected"));
  button.classList.add("selected");
  emissionMode = button.dataset.emissionMode;
  sim.setEmissionMode(emissionMode);
});

setColorMode(colorMode);
renderGradientStops();

function renderModifierRow(mod) {
  const def = MODIFIER_DEFS[mod.type];
  const row = document.createElement("div");
  row.className = "mod-row";
  if (!mod.enabled) row.classList.add("disabled");
  if (mod.collapsed) row.classList.add("collapsed");
  if (mod.overlay) row.classList.add("overlay-active");
  if (mod.type === "cohesion") row.classList.add("gpu-unsupported");
  row.dataset.modId = String(mod.id);

  const head = document.createElement("div");
  head.className = "mod-head";
  const labelSuffix = mod.type === "cohesion" ? `<span class="mod-type-note">GPU 模式不支持</span>` : "";
  head.innerHTML = `
    <div class="mod-head-left">
      <input type="checkbox" class="mod-toggle" ${mod.enabled ? "checked" : ""} title="启用 / 禁用" />
      <span class="mod-type">${def.label}</span>${labelSuffix}
      <span class="mod-collapse">${mod.collapsed ? "▸" : "▾"}</span>
    </div>
    <button type="button" class="mod-delete" title="删除">×</button>
  `;
  row.appendChild(head);

  const body = document.createElement("div");
  body.className = "mod-body";

  if (mod.type !== "cohesion") {
    const overlayLabel = document.createElement("label");
    overlayLabel.className = "switch-row mod-overlay-row";
    overlayLabel.innerHTML = `
      <input type="checkbox" data-overlay ${mod.overlay ? "checked" : ""} />
      <span>叠加模式 <small>投影到合力切平面</small></span>
    `;
    body.appendChild(overlayLabel);
  }

  for (const schema of def.paramSchema) {
    const v = mod.params[schema.key];
    const label = document.createElement("label");
    label.className = "control-row";
    label.innerHTML = `
      <span>${schema.label}</span>
      <input type="range" min="${schema.min}" max="${schema.max}" step="${schema.step}" value="${v}" data-param="${schema.key}" />
    `;
    body.appendChild(label);
  }

  const falloff = document.createElement("div");
  falloff.className = "mod-falloff";
  falloff.innerHTML = `
    <div class="mod-falloff-head">
      <span>Falloff</span>
      <select data-falloff="type">
        <option value="none" ${mod.falloff.type === "none" ? "selected" : ""}>无</option>
        <option value="sphere" ${mod.falloff.type === "sphere" ? "selected" : ""}>球形</option>
      </select>
    </div>
  `;
  if (mod.falloff.type === "sphere") {
    falloff.insertAdjacentHTML("beforeend", `
      <label class="control-row"><span>中心 X</span><input type="range" min="-3" max="3" step="0.05" value="${mod.falloff.center[0]}" data-falloff="cx" /></label>
      <label class="control-row"><span>中心 Y</span><input type="range" min="-3" max="3" step="0.05" value="${mod.falloff.center[1]}" data-falloff="cy" /></label>
      <label class="control-row"><span>中心 Z</span><input type="range" min="-3" max="3" step="0.05" value="${mod.falloff.center[2]}" data-falloff="cz" /></label>
      <label class="control-row"><span>内半径</span><input type="range" min="0" max="5" step="0.05" value="${mod.falloff.inner}" data-falloff="inner" /></label>
      <label class="control-row"><span>外半径</span><input type="range" min="0.05" max="6" step="0.05" value="${mod.falloff.outer}" data-falloff="outer" /></label>
    `);
  }
  body.appendChild(falloff);

  row.appendChild(body);
  return row;
}

function renderModifierStack() {
  modifierStackEl.innerHTML = "";
  for (const mod of modifiers) {
    modifierStackEl.appendChild(renderModifierRow(mod));
  }
}

function populateModifierTypePicker() {
  modifierTypePicker.innerHTML = "";
  for (const [type, def] of Object.entries(MODIFIER_DEFS)) {
    const opt = document.createElement("option");
    opt.value = type;
    opt.textContent = def.label;
    modifierTypePicker.appendChild(opt);
  }
}

function findModifierForElement(el) {
  const row = el.closest(".mod-row");
  if (!row) return null;
  const id = Number(row.dataset.modId);
  return modifiers.find((m) => m.id === id) || null;
}

modifierStackEl.addEventListener("input", (event) => {
  const target = event.target;
  const mod = findModifierForElement(target);
  if (!mod) return;
  const paramKey = target.dataset.param;
  const falloffKey = target.dataset.falloff;
  if (paramKey) {
    mod.params[paramKey] = Number(target.value);
  } else if (falloffKey === "cx") mod.falloff.center[0] = Number(target.value);
  else if (falloffKey === "cy") mod.falloff.center[1] = Number(target.value);
  else if (falloffKey === "cz") mod.falloff.center[2] = Number(target.value);
  else if (falloffKey === "inner") mod.falloff.inner = Number(target.value);
  else if (falloffKey === "outer") mod.falloff.outer = Number(target.value);
});

modifierStackEl.addEventListener("change", (event) => {
  const target = event.target;
  const mod = findModifierForElement(target);
  if (!mod) return;
  if (target.classList.contains("mod-toggle")) {
    mod.enabled = target.checked;
    target.closest(".mod-row").classList.toggle("disabled", !mod.enabled);
  } else if (target.hasAttribute("data-overlay")) {
    mod.overlay = target.checked;
    target.closest(".mod-row").classList.toggle("overlay-active", mod.overlay);
  } else if (target.dataset.falloff === "type") {
    mod.falloff.type = target.value;
    renderModifierStack();
  }
});

modifierStackEl.addEventListener("click", (event) => {
  const target = event.target;
  if (target.classList.contains("mod-delete")) {
    const row = target.closest(".mod-row");
    const id = Number(row.dataset.modId);
    modifiers = modifiers.filter((m) => m.id !== id);
    renderModifierStack();
    return;
  }
  if (target.classList.contains("mod-toggle")) return;
  const head = target.closest(".mod-head");
  if (!head) return;
  const mod = findModifierForElement(target);
  if (!mod) return;
  mod.collapsed = !mod.collapsed;
  const row = head.closest(".mod-row");
  row.classList.toggle("collapsed", mod.collapsed);
  const arrow = head.querySelector(".mod-collapse");
  if (arrow) arrow.textContent = mod.collapsed ? "▸" : "▾";
});

addModifierBtn.addEventListener("click", () => {
  const type = modifierTypePicker.value;
  if (!MODIFIER_DEFS[type]) return;
  modifiers.push(makeModifier(type));
  renderModifierStack();
});

populateModifierTypePicker();
renderModifierStack();

[
  controlsConfig.materialColor,
  controlsConfig.materialMetalness,
  controlsConfig.materialRoughness,
  controlsConfig.materialOpacity,
  controlsConfig.wireColor,
  controlsConfig.wireOpacity
].forEach((control) => control.addEventListener("input", applyModelRenderSettings));

[
  controlsConfig.keyLightColor,
  controlsConfig.ambientLightColor,
  controlsConfig.keyLightIntensity,
  controlsConfig.ambientLightIntensity,
  controlsConfig.fillLightIntensity,
  controlsConfig.rimLightIntensity,
  controlsConfig.lightAzimuth,
  controlsConfig.lightElevation,
  controlsConfig.exposure
].forEach((control) => control.addEventListener("input", updateLighting));

showModel.addEventListener("change", () => {
  modelRoot.visible = showModel.checked;
});

showGrid.addEventListener("change", () => {
  grid.visible = showGrid.checked;
});

function getCurrentPreset() {
  return {
    renderMode: controlsConfig.renderMode,
    emissionMode,
    particles: Number(controlsConfig.density.value),
    speed: Number(controlsConfig.speed.value),
    size: Number(controlsConfig.particleSize.value),
    sizeJitter: Number(controlsConfig.particleSizeJitter.value),
    lifetime: Number(controlsConfig.lifetime.value),
    lifetimeJitter: Number(controlsConfig.lifetimeJitter.value),
    tangentSpeed: Number(controlsConfig.tangentSpeed.value),
    modifiers: modifiers.map((mod) => ({
      type: mod.type,
      enabled: mod.enabled,
      overlay: !!mod.overlay,
      params: { ...mod.params },
      falloff: {
        type: mod.falloff.type,
        center: [...mod.falloff.center],
        inner: mod.falloff.inner,
        outer: mod.falloff.outer
      }
    })),
    color: {
      mode: colorMode,
      speedRef: Number(colorSpeedRefInput.value),
      fade: Number(colorFadeInput.value),
      stops: [...gradientStops]
        .sort((a, b) => a.pos - b.pos)
        .map((s) => ({ pos: s.pos, color: s.color }))
    },
    material: {
      color: controlsConfig.materialColor.value,
      metalness: Number(controlsConfig.materialMetalness.value),
      roughness: Number(controlsConfig.materialRoughness.value),
      opacity: Number(controlsConfig.materialOpacity.value),
      wireColor: controlsConfig.wireColor.value,
      wireOpacity: Number(controlsConfig.wireOpacity.value)
    },
    lighting: {
      keyColor: controlsConfig.keyLightColor.value,
      ambientColor: controlsConfig.ambientLightColor.value,
      keyIntensity: Number(controlsConfig.keyLightIntensity.value),
      ambientIntensity: Number(controlsConfig.ambientLightIntensity.value),
      fillIntensity: Number(controlsConfig.fillLightIntensity.value),
      rimIntensity: Number(controlsConfig.rimLightIntensity.value),
      azimuth: Number(controlsConfig.lightAzimuth.value),
      elevation: Number(controlsConfig.lightElevation.value),
      exposure: Number(controlsConfig.exposure.value)
    }
  };
}

function applyPreset(preset) {
  if (!preset || typeof preset !== "object") return;

  if (preset.renderMode) {
    controlsConfig.renderMode = preset.renderMode;
    renderModeControls.querySelectorAll("button").forEach((b) => {
      const sel = b.dataset.renderMode === preset.renderMode;
      b.classList.toggle("selected", sel);
      if (sel) renderModeLabel.textContent = b.textContent;
    });
  }

  if (preset.emissionMode) {
    emissionMode = preset.emissionMode;
    emissionModeControls.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("selected", b.dataset.emissionMode === preset.emissionMode);
    });
    sim.setEmissionMode(emissionMode);
  }

  const setIf = (input, val) => {
    if (val !== undefined && val !== null && input) input.value = String(val);
  };
  setIf(controlsConfig.density, preset.particles);
  setIf(controlsConfig.speed, preset.speed);
  setIf(controlsConfig.particleSize, preset.size);
  setIf(controlsConfig.particleSizeJitter, preset.sizeJitter);
  setIf(controlsConfig.lifetime, preset.lifetime);
  setIf(controlsConfig.lifetimeJitter, preset.lifetimeJitter);
  setIf(controlsConfig.tangentSpeed, preset.tangentSpeed);

  if (Array.isArray(preset.modifiers)) {
    modifiers = preset.modifiers
      .filter((m) => m && MODIFIER_DEFS[m.type])
      .map((m) => {
        const def = MODIFIER_DEFS[m.type];
        return {
          id: ++modifierIdSeq,
          type: m.type,
          enabled: m.enabled !== false,
          overlay: !!m.overlay,
          collapsed: false,
          params: { ...def.defaults, ...(m.params || {}) },
          falloff: {
            type: m.falloff?.type ?? "none",
            center: Array.isArray(m.falloff?.center) ? [...m.falloff.center] : [0, 0, 0],
            inner: m.falloff?.inner ?? 0.6,
            outer: m.falloff?.outer ?? 2.5
          }
        };
      });
    renderModifierStack();
  }

  if (preset.color) {
    if (Array.isArray(preset.color.stops) && preset.color.stops.length >= 1) {
      gradientStops = preset.color.stops.map((s) => makeStop(s.pos, s.color));
      renderGradientStops();
    }
    if (preset.color.speedRef !== undefined) colorSpeedRefInput.value = preset.color.speedRef;
    if (preset.color.fade !== undefined) colorFadeInput.value = preset.color.fade;
    if (preset.color.mode) setColorMode(preset.color.mode);
    else pushColorsToSim();
  }

  if (preset.material) {
    const m = preset.material;
    setIf(controlsConfig.materialColor, m.color);
    setIf(controlsConfig.materialMetalness, m.metalness);
    setIf(controlsConfig.materialRoughness, m.roughness);
    setIf(controlsConfig.materialOpacity, m.opacity);
    setIf(controlsConfig.wireColor, m.wireColor);
    setIf(controlsConfig.wireOpacity, m.wireOpacity);
    applyModelRenderSettings();
  }

  if (preset.lighting) {
    const l = preset.lighting;
    setIf(controlsConfig.keyLightColor, l.keyColor);
    setIf(controlsConfig.ambientLightColor, l.ambientColor);
    setIf(controlsConfig.keyLightIntensity, l.keyIntensity);
    setIf(controlsConfig.ambientLightIntensity, l.ambientIntensity);
    setIf(controlsConfig.fillLightIntensity, l.fillIntensity);
    setIf(controlsConfig.rimLightIntensity, l.rimIntensity);
    setIf(controlsConfig.lightAzimuth, l.azimuth);
    setIf(controlsConfig.lightElevation, l.elevation);
    setIf(controlsConfig.exposure, l.exposure);
    updateLighting();
  }

  rebuildParticles();
}

const PRESET_STORE_KEY = "particleStudio.presets.v1";

function loadPresetStore() {
  try {
    const raw = localStorage.getItem(PRESET_STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function savePresetStore(store) {
  try {
    localStorage.setItem(PRESET_STORE_KEY, JSON.stringify(store));
  } catch (e) {
    setStatus("保存失败：localStorage 不可用或已满");
  }
}

function escapePresetName(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[m]));
}

function renderPresetList() {
  const store = loadPresetStore();
  const names = Object.keys(store).sort((a, b) => a.localeCompare(b));
  presetListEl.innerHTML = "";
  for (const name of names) {
    const row = document.createElement("div");
    row.className = "preset-row";
    const safe = escapePresetName(name);
    row.innerHTML = `
      <span class="preset-name" title="${safe}">${safe}</span>
      <button type="button" class="preset-load" data-load>载入</button>
      <button type="button" class="preset-delete" data-delete>删除</button>
    `;
    row.dataset.presetName = name;
    presetListEl.appendChild(row);
  }
  presetEmptyEl.style.display = names.length === 0 ? "" : "none";
}

presetSaveBtn.addEventListener("click", () => {
  const name = (presetNameInput.value || "").trim();
  if (!name) {
    setStatus("请输入预设名");
    presetNameInput.focus();
    return;
  }
  const store = loadPresetStore();
  if (store[name] && !confirm(`预设「${name}」已存在，覆盖？`)) return;
  store[name] = getCurrentPreset();
  savePresetStore(store);
  renderPresetList();
  setStatus(`预设「${name}」已保存`);
});

presetNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    presetSaveBtn.click();
  }
});

presetListEl.addEventListener("click", (event) => {
  const row = event.target.closest(".preset-row");
  if (!row) return;
  const name = row.dataset.presetName;
  if (event.target.matches("[data-load]")) {
    const store = loadPresetStore();
    const preset = store[name];
    if (!preset) return;
    applyPreset(preset);
    presetNameInput.value = name;
    setStatus(`已载入预设「${name}」`);
  } else if (event.target.matches("[data-delete]")) {
    if (!confirm(`删除预设「${name}」？`)) return;
    const store = loadPresetStore();
    delete store[name];
    savePresetStore(store);
    renderPresetList();
  }
});

renderPresetList();

let mediaRecorder = null;
let recordedChunks = [];
let recordStartTime = 0;
let recordTimer = 0;
let recordExt = "webm";

function pickRecorderMime() {
  const candidates = [
    "video/mp4;codecs=avc1",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  for (const mime of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return null;
}

function formatRecordTime(ms) {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function startRecording() {
  if (typeof MediaRecorder === "undefined") {
    setStatus("浏览器不支持 MediaRecorder");
    return;
  }
  const mime = pickRecorderMime();
  if (!mime) {
    setStatus("浏览器不支持任何可用的视频编码");
    return;
  }
  recordExt = mime.includes("mp4") ? "mp4" : "webm";

  const stream = canvas.captureStream(60);
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16_000_000 });
  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) recordedChunks.push(event.data);
  };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `particles-${Date.now()}.${recordExt}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    recordedChunks = [];
  };

  recordStartTime = performance.now();
  mediaRecorder.start(1000);

  recordVideoBtn.classList.add("recording");
  const tick = () => {
    if (!mediaRecorder) return;
    recordVideoBtn.textContent = `● ${formatRecordTime(performance.now() - recordStartTime)} 停止`;
  };
  tick();
  recordTimer = setInterval(tick, 250);
}

function stopRecording() {
  if (!mediaRecorder) return;
  try { mediaRecorder.stop(); } catch (_) { /* noop */ }
  mediaRecorder = null;
  if (recordTimer) {
    clearInterval(recordTimer);
    recordTimer = 0;
  }
  recordVideoBtn.classList.remove("recording");
  recordVideoBtn.textContent = "开始录制";
}

recordVideoBtn.addEventListener("click", () => {
  if (mediaRecorder) stopRecording();
  else startRecording();
});

const exportSrgbColor = new THREE.Color();

function exportParticlesPly() {
  if (!sim || !sim.gpuCompute || !sim.posVar || !sim.velVar || !sim.count) {
    setStatus("仿真未初始化，无法导出");
    return;
  }
  const count = sim.count;
  const tex = sim.texSize;
  const slots = tex * tex;

  setStatus(`正在读回 GPU 数据（${formatNumber(count)} 粒子）`);

  let posBuf, velBuf;
  try {
    posBuf = new Float32Array(slots * 4);
    velBuf = new Float32Array(slots * 4);
    const posRT = sim.gpuCompute.getCurrentRenderTarget(sim.posVar);
    const velRT = sim.gpuCompute.getCurrentRenderTarget(sim.velVar);
    renderer.readRenderTargetPixels(posRT, 0, 0, tex, tex, posBuf);
    renderer.readRenderTargetPixels(velRT, 0, 0, tex, tex, velBuf);
  } catch (err) {
    console.error(err);
    setStatus("GPU 数据读回失败");
    return;
  }

  sortGradientStops();
  const speedRef = Math.max(Number(colorSpeedRefInput.value), 1e-3);
  const invSpeedRef = 1 / speedRef;
  const fadeAmt = Number(colorFadeInput.value);
  const mode = colorMode;

  const header =
    "ply\n" +
    "format binary_little_endian 1.0\n" +
    `element vertex ${count}\n` +
    "property float x\n" +
    "property float y\n" +
    "property float z\n" +
    "property uchar red\n" +
    "property uchar green\n" +
    "property uchar blue\n" +
    "end_header\n";
  const headerBytes = new TextEncoder().encode(header);

  const VERT_BYTES = 15;
  const body = new ArrayBuffer(count * VERT_BYTES);
  const view = new DataView(body);

  for (let i = 0; i < count; i += 1) {
    const ix = i * 4;
    const x = posBuf[ix];
    const y = posBuf[ix + 1];
    const z = posBuf[ix + 2];
    const age = posBuf[ix + 3];
    const vx = velBuf[ix];
    const vy = velBuf[ix + 1];
    const vz = velBuf[ix + 2];
    const lifetime = velBuf[ix + 3];

    let u = 0;
    if (lifetime > 1e-5) {
      u = age / lifetime;
      if (u < 0) u = 0;
      else if (u > 1) u = 1;
    }

    let t;
    if (mode === "speed") {
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz) * invSpeedRef;
      t = sp > 1 ? 1 : sp;
    } else if (mode === "fixed") {
      t = 0;
    } else {
      t = u;
    }
    sampleGradient(t, tmpColor);
    const fade = 1 - u * u * fadeAmt;
    exportSrgbColor.setRGB(
      Math.max(0, tmpColor.r * fade),
      Math.max(0, tmpColor.g * fade),
      Math.max(0, tmpColor.b * fade)
    );
    exportSrgbColor.convertLinearToSRGB();

    const r = Math.min(255, Math.max(0, Math.round(exportSrgbColor.r * 255)));
    const g = Math.min(255, Math.max(0, Math.round(exportSrgbColor.g * 255)));
    const b = Math.min(255, Math.max(0, Math.round(exportSrgbColor.b * 255)));

    const off = i * VERT_BYTES;
    view.setFloat32(off + 0, x, true);
    view.setFloat32(off + 4, y, true);
    view.setFloat32(off + 8, z, true);
    view.setUint8(off + 12, r);
    view.setUint8(off + 13, g);
    view.setUint8(off + 14, b);
  }

  const blob = new Blob([headerBytes, body], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `particles-${Date.now()}.ply`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  setStatus(`已导出 ${formatNumber(count)} 粒子 PLY`);
}

exportPlyBtn.addEventListener("click", exportParticlesPly);

document.querySelectorAll(".inspector .panel").forEach((panel) => {
  const head = panel.querySelector(":scope > .panel-head");
  if (!head) return;
  const indicator = document.createElement("span");
  indicator.className = "panel-collapse";
  indicator.textContent = "▾";
  head.appendChild(indicator);
  head.addEventListener("click", (event) => {
    if (event.target.closest("input, button, select, textarea, label")) return;
    panel.classList.toggle("collapsed");
    indicator.textContent = panel.classList.contains("collapsed") ? "▸" : "▾";
  });
});

window.addEventListener("resize", updateRendererSize);

updateRendererSize();
updateLighting();
createDemoModel();
animate();

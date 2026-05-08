# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running

No build step, no `package.json`, no `node_modules`. Just a static server:

```bash
node server.js                  # serves on http://localhost:5173
PORT=8080 node server.js        # override port
```

Opening `index.html` directly via `file://` partially works but breaks ES module / model loading in stricter browsers — always prefer the dev server.

`server.js` is intentionally minimal (Node built-ins only) and enforces a `resolve()`-based path-traversal guard, so any new file types served must be added to its `types` map.

## Dependencies

Three.js is loaded **via `<script type="importmap">` in `index.html`** from `cdn.jsdelivr.net`, pinned to `three@0.164.1`. There is no bundler. Consequences:

- All ES imports in `app.js` must resolve through that import map (bare `"three"` and `"three/addons/..."` only).
- Adding a new addon means it must exist under `three@0.164.1/examples/jsm/...` on jsDelivr — no npm install path will work without introducing a build system.
- The import map version and `three/addons/` prefix must move together when upgrading three.js.

## Architecture

Everything lives in `app.js` as a single module — no framework, no state library, no router. **The model is an emitter**: particles are born at random points on the model's surface, flow under wind + turbulence + drag with a per-particle lifetime, then respawn at a new sample point. The model is a *source*, not a destination — there is no "rest pose" the particles return to.

The data pipeline:

```
loaded model → collectSurfaceSamples() → samplePositions / sampleNormals  (unique vertices)
                                         triVerts / triNormals             (per-triangle, 9 floats each)
                                         triCDF / triCount                 (area-weighted CDF for triangle pick)
                                                ↓
                                       spawnParticle(i)   (branches on emissionMode)
                                                ↓
                              particlePositions    (live xyz; backs the BufferAttribute directly)
                              particleVelocities   (absolute velocity, integrated each frame)
                              particleAges         (elapsed seconds since this slot's last spawn)
                              particleLifetimes    (assigned at spawn; lifetime * (1 ± jitter))
```

`spawnParticle(i)` synthesises (px, py, pz, nx, ny, nz) from one of three sources, selected by `emissionMode`:

- **`vertex`** — random index into `samplePositions / sampleNormals`. The pool is unique vertices from the *original* (indexed) geometry, so visual coverage clusters at mesh corners.
- **`surface`** (default) — `pickTriangleByArea()` does a binary search on `triCDF` (normalized to [0,1]) to pick a triangle weighted by its area; barycentric `(u, v)` is sampled with the standard `if (u+v>1) reflect` trick to give a uniform interior point. Position and normal are interpolated from the three triangle corners and the normal is renormalized.
- **`edge`** — same triangle pick by area, then a random edge `e ∈ {0,1,2}` and a random `t ∈ [0,1]`; position/normal are linearly interpolated between the two endpoints. This gives a true wireframe-along-edges look (different from picking vertices).

Then 0.002 normal-epsilon offset is applied to the position, and velocity is seeded from **the wind vector projected onto the local tangent plane** (`v0 = (wind − (wind·n)n) * tangentSpeed + n*0.05`). That tangent projection is what makes particles look like they slide along the surface for a beat before being carried away.

Switching `emissionMode` calls `rebuildParticles()` so the change is visible immediately rather than phasing in over one lifetime cycle.

Per-frame, `updateParticleFrame(delta)` ages every particle, respawns dead ones, and for live ones integrates a single force: `force = (wind - v) * drag + turbulence(p, t) + randomKick - gravity·ŷ`. There are no animation "modes" — this is the only path. Color is sampled from a multi-stop **gradient ramp** (`gradientStops[]`) using a t value selected by `colorMode`: `age` → `age/lifetime`, `speed` → `|v| / colorSpeedRef` clamped, `fixed` → 0. The result is multiplied by `1 - u² * fadeAmt` (age-driven brightness falloff, controllable). With `AdditiveBlending` that fade reads as opacity fade for free.

**Turbulence uses live position `(px, py, pz)` as the noise domain, not a per-particle seed.** This is deliberate: a per-particle seed makes each particle jitter independently, which looks like static; sharing the position domain means neighboring particles see correlated flow, which looks like wind. If you ever add a particle-local random phase, do it in addition to the position domain, not instead of it.

### Control → rebuild dependency

The DOM controls in `index.html` are wired in `app.js` with handlers split by cost. When adding new controls, match this pattern or you will either over-rebuild or stop responding to changes:

| Control(s) | Effect |
| --- | --- |
| `density`, `emissionMode` (surface/vertex/edge) | Full `rebuildParticles()` (reallocates all per-particle Float32Arrays). Emission mode triggers it because already-alive particles otherwise keep their old spawn source until natural death |
| Gradient stops, color mode (`age`/`speed`/`fixed`), `colorSpeedRef`, `colorFade` | Read live each frame inside `updateParticleFrame`; `gradientStops` is sorted in place once per frame. Stop edits update each stop's cached `THREE.Color` and the preview `<div>` background. No rebuild |
| `materialColor/Metalness/Roughness/Opacity`, `wireColor/Opacity`, render-mode buttons | `applyModelRenderSettings()` only |
| Lighting block + `exposure` | `updateLighting()` only — no geometry touched |
| `speed`, `particleSize`, wind/turbulence/randomness, `tangentSpeed`/`drag`/`gravity`, `lifetime`/`lifetimeJitter` | Read live each frame inside `updateParticleFrame` / `spawnParticle` — no rebuild |

`particleSize` is the one cosmetic control that intentionally leaks into the per-frame loop because `PointsMaterial.size` has to be reassigned every frame.

`lifetime` and `lifetimeJitter` only affect particles **on their next respawn** — already-alive particles keep the lifetime they were assigned at birth. So changing the slider doesn't immediately retire all current particles; the new value phases in over one lifetime cycle.

### Model render modes

`material` / `wireframe` / `hybrid` are not implemented by toggling `material.wireframe`. Instead, `prepareModelMaterials()` builds **two materials per mesh** (`baseMaterial` + `wireMaterial`) and attaches a child `Mesh` reusing the same geometry as a `wireOverlay` (marked with `userData.isWireOverlay = true`). `applyModelRenderSettings()` swaps `mesh.material` and toggles the overlay's visibility. Anything that traverses meshes (notably `collectSurfaceSamples`) must skip `userData.isWireOverlay` nodes, otherwise the wire overlay's vertices get sampled and double the spawn pool.

### Model normalization

`normalizeModel(root)` rescales every loaded model so its largest axis = 2.35 and recenters it at the origin, then caches `modelBounds`. Sample positions are collected *after* normalization, so they're in the normalized world space. If you bypass `normalizeModel`, very large or off-center models will spawn particles outside the camera's near/far range or off-screen.

### Loading multi-file glTF

`createLoadingManager()` rewrites all relative URLs that the GLTFLoader requests to `URL.createObjectURL` blobs by stripping to the basename. This is why the file input is `multiple` — for split `.gltf + .bin + textures`, the user must select **all** files at once or the loader's relative references will 404.

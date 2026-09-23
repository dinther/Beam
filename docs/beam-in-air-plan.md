# Light in air: one integrand for beams, projectors and lasers

Status: draft for review, 2026-09-23. Nothing here is built.

## Goal

Mover beams look harsh and fake. Projector shafts, laser sheets, LED glows and
the ambient pass each scatter light through the same haze with their own
formula, and they disagree about phase, extinction, occlusion and texture.

The plan: one shader body that says how much light a piece of air throws at
the eye, called by every renderer that draws light in air. Beams get the
projector's integrand, which is the most complete one in the codebase. Haze
density stays what it is for now and gets its own plan later.

Constraints set for it:

- Markedly better, not incrementally.
- Not much more GPU time than today. Twelve screen-filling beams cost ~1 ms;
  the target for the same scene is under 3 ms, measured, and the ambient pass
  does not change.
- Works for every fixture kind, including hundreds of movers.
- Gobos and prisms, animated, on any beam.

## Why the mover beam reads as fake

All four causes are in `shaders/beam.fragment.glsl`, none is the haze field.

1. **Top-hat profile.** Brightness is the chord through a uniformly dense
   cone, which has a vertical tangent at the rim. The penumbra smoothstep only
   softens the last stretch, so a focused fixture draws a pipe.
2. **No phase function.** Brightness is `2 * beamProfile` whatever the view
   angle. Only the laser has the two-lobe Henyey-Greenstein.
3. **Haze on the skin.** One field sample at the cone surface, at half depth.
   The same texture everywhere along the shaft, so it reads as a wrapped decal.
4. **Invented attenuation.** `2 / (1 + a*d + angle*d^2)` depends on nothing
   the haze does. A real beam pays inverse square in cone radius and
   Beer-Lambert extinction in the haze, so thick air makes short fat beams.

The mesh is only a proxy: the shader already solves the ray against the cone
analytically, so nothing above needs new geometry beyond a wider proxy.

## What the projector shaft already does

`projector_pass.js` marches 32 jittered steps along the view ray, confined to
the frustum span, and per step:

- projects the sample through the lens matrix and reads the picture at a
  blurred mip that grows with distance (`SHAFT_LOD`, `SHAFT_BLUR_PER_METRE`);
- discards where the lens cannot see, from the depth atlas;
- pays inverse square with a 3 m near clamp (`SHAFT_NEAR`);
- pays Beer-Lambert extinction scaled by haze density (`SHAFT_FADE_PER_METRE`);
- softens the frame edge in the air only (`SHAFT_EDGE`);
- reads the shared haze field.

It has no phase function. Its constants were set by eye against a real venue.
A gobo beam is this with a round aperture and a coloured monochrome picture.

## The shared body

One GLSL function in the prelude that `hazeShaderPrelude()` already hands to
every renderer, so no renderer can drift from another:

```
vec3 inScatter(vec3 point, vec3 toEye, Fixture f)
```

Inputs per fixture: aperture position and axis, lens matrix (symmetric cone or
asymmetric frustum), depth-atlas tile, aperture texture and its transform
(gobo index, rotation, prism count and spread, or a video slice), colour,
intensity, beam and field angle.

Per sample:

1. Project `point` through the lens matrix. Outside the aperture: zero.
2. Radial profile: the pool's own falloff, full to the inner cone and a
   smoothstep to nothing at the stated angle, from the same penumbra the
   SpotLight gets. Air and pool end at the same place with the same edge.
3. Aperture texture at that projection, blurred with distance. Gobo rotation
   is a 2D rotation of the lookup; a prism is N offset lookups summed, or one
   pre-composited texture rebuilt when the prism state changes.
4. Depth atlas: past the first surface the lens sees, zero. No tile yet: the
   z = 0 floor plane, as today.
5. Irradiance: inverse square in distance from the aperture with the near
   clamp, times extinction from the aperture along the axis, scaled by haze.
6. Phase: the laser's two lobes, moved here unchanged.
7. Density: haze amount times the baked field at `point`. Later, times a
   body field from hazer fixtures; that is the haze plan, not this one.

Result is density times irradiance times phase. Two beams add the way light
does, which is what keeps the crossing line away.

## Three integrators

Each renderer keeps its own geometry and its own scalability; only the body is
shared.

- **Mover cone.** Instanced proxy mesh, widened to the field angle plus a
  small tail. `beamProfile` already computes the ray's entry and exit; the
  shader takes N samples along that chord and sums `inScatter`. N is a dial,
  default set by measurement. The `(length + 20) / 1.5` displacement hack goes
  once the proxy is drawn to the field angle directly.
- **Projector shaft.** The full-screen march stays as it is and calls the
  shared body. Converting it to a proxy frustum is a later option if more than
  six projectors are ever needed.
- **Laser sheet.** One call per fragment. The laser is the reference for phase
  and for atlas occlusion, so it should look the same after.

The LED glow's marched box and the ambient pass read the same density
function. They are not changed in this plan beyond that, which also removes
the glow's private `mix(1, churn, turbulence)` asymmetry.

## Depth atlas for hundreds of movers

`DepthAtlas` in `projector_depth.js` already refreshes per tile: each slot
holds a key from a scene hash plus the fixture camera, and only changed tiles
are redrawn, scissored. Two things change for movers:

- **Scheduling.** The scene hash includes every instanced mesh's matrix
  version, and mover bodies are instanced, so one head panning dirties every
  tile. Today a dirty tile is drawn at once. Instead: a changed key marks the
  tile dirty, and a queue drains a fixed number per frame. A dirty tile stays
  in use until replaced.
- **Priority by prominence, not age.** Per dirty beam, once per frame on the
  CPU: project the apex and the far disc into the camera for an approximate
  screen area, times intensity, times how far the head has turned since its
  tile. Off-screen or dark beams score zero and may never refresh, which is
  correct. Movement below a threshold does not dirty a tile.
- **Size.** A new atlas instance for movers with small tiles. A cut against a
  truss needs far less resolution than a laser figure on a wall; 128 px tiles
  in a 2048 texture give 256 slots. Static beams cost one tile draw at load and
  again on scene edits, never in a show.

Static versus moving is therefore a consequence of the dirty rule, not a
fixture type. Animated versus non-animated gobos is whether per-instance
attributes change per frame, not a second renderer.

## Per-instance data

Everything per beam goes in the instance buffer, never in a uniform array;
that was the 100-mover cap. Gobos live in one texture array holding the
library, indexed per instance. Prism count and spread, gobo rotation, beam and
field angle, atlas slot: all instance attributes.

## What stays out

- **The surface pool.** Movers light the floor with a three.js `SpotLight`.
  A gobo on the floor cannot come from a `SpotLight`, and six full-screen
  projector slots do not scale to hundreds of movers. How hundreds of movers
  paint gobos on geometry is open and is not solved here.
- **Multiple-scattering halo.** Bloom and the profile tail stand in for it.
- **Haze bodies, hazer and smoke-burst fixtures.** The density function is
  the seam they plug into. Separate plan.

## Order, with a gate on each step

Each step is measured on `laser.beam` with a parked camera before and after,
draws and triangles checked equal, and screenshotted for comparison. No step
starts until the previous one is accepted.

1. **Profile and phase on the mover cone.** Cheapest, most visible. No
   integrator change yet. Gate: edges soft, view-dependent brightness, GPU
   time unchanged.
   *Built 2026-09-23, awaiting review.* Widening the cone exposed two
   faults the thin cone had hidden, and both had to go in this step: the
   closest approach was inferred from chord length, so every oblique ray
   read as central, and the open double-sided tube shaded rays twice and
   creased where its back wall dipped under the floor. The cone is now a
   closed solid drawn back-face only with no depth test, one fragment per
   ray, with the lit stretch clipped against the scene depth. That also
   removes the surface fade and the wall's line into the floor. GPU time is
   within launch noise of before on the one-mover scene.
   Two more things settled while reviewing it. The fixture's stated angle is
   the **field**, the edge of the light, because that is the angle the floor
   pool has always been drawn to and the lit air must end where the pool
   does; the 50% cone sits inside it at the focus ratio. And the profile is
   averaged along the ray's chord at four points, because a single reading
   at the chord's midpoint lies near the axis for every oblique ray and lit
   the whole cone at full brightness from close up. That is step 3's march
   pulled forward for the profile only; the haze is still one sample.
   The hard edge that survived all of that was the rim window cutting the
   profile at whatever it happened to be where a fixed tail ended, and with
   that fixed the beam read thinner than its pool. Both went away with one
   rule Paul set: the air's falloff is the pool's falloff. The shaft uses
   the SpotLight's own curve, full to the inner cone and a smoothstep to
   nothing at the stated angle, driven by the same penumbra the focus
   channel writes to the SpotLight, so air and pool cannot disagree. The
   GDTF 50%/10% profile is dropped. A per-fixture normaliser in the instance
   buffer keeps a cross-section at the old cone's light at every focus.
2. **The shared body in the prelude**, called by the laser first. Gate: the
   laser renders pixel-identical, or the difference is explained.
3. **Chord march in the mover cone**, calling the body. Gate: texture passes
   through the shaft; twelve screen-filling beams under 3 ms; the crossing
   line absent.
4. **Extinction and the wider proxy.** Gate: beams shorten as haze rises;
   fill cost measured.
5. **Mover depth atlas with the queue.** Gate: 200 movers in a chase hold
   60 fps; a beam through a truss is cut; the floor plane still holds for
   beams without a tile.
   *Built 2026-09-23, ahead of steps 2 to 4 because the wall scene showed
   it missing; awaiting review.* A `DepthAtlas` of 16 x 16 tiles of 128 px
   for the movers, a tile per lit head at its instance id, drawn from a
   camera at the beam's origin looking down its axis. The atlas engine
   gained a per-frame budget with priority (intensity, nearness, turn since
   the tile was drawn) so a chase across hundreds stays bounded, and holes
   for dark heads. The fragment shader projects each chord sample into the
   tile from the beam's own axes, so no matrix travels per instance, and
   drops samples past the first surface the lens sees. Verified on the
   two-mover wall scene: the air stops at the wall. The 200-mover chase and
   the truss cut are not yet measured. The floor pool still passes through
   obstacles, since it is three's spotlight without a shadow map.
6. **Gobos and prisms.** Texture array, instance attributes, rotation and
   prism in the aperture read. Gate: an animated gobo on a moving beam at no
   measurable cost over step 5.
7. **Projector shaft onto the shared body.** Gate: screenshot comparison
   against the current shaft, pixel for pixel, since its constants were set
   by eye and must survive.

## Risks

- ALU is what costs in this renderer, fetches nearly free. The body is
  fetch-heavy by design, but N samples times the octave stack is not; the
  chord march reads fewer octaves per sample, as the ambient pass does.
- The projector's tuned look must not move. Step 7 is last for that reason.
- The haze slider's meaning changes once extinction depends on it. Beams get
  shorter in thick air, which is right, but existing shows will look
  different at the same setting.
- `BEAM_FLOOR_Z` stays as the fallback and must not be removed when the atlas
  lands; a beam without a tile still needs to end somewhere.

## Open questions for review

- Default sample count for the chord march, and whether it scales with the
  cone's screen coverage.
- Whether beam and field angle come from GDTF for every mover, and what the
  generic mover uses when only one angle is known.
- Gobo library format and where it lives in the show or the library.
- Whether the mover atlas budget per frame is a preference or fixed.

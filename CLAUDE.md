# Beatline Beam

A real-time 3D visualiser for lighting rigs, driven by Art-Net and sACN.
Electron + Vue 3 (compat) + three.js 0.170 + postprocessing 6. "Beatline Beam"
in branding, "Beam" in prose. One branch, master.

## Where things are

**Electron main** -- `src/electron/`
- `main.js` windows, IPC, single-instance (a second launch forwards its argv).
- DMX in and out: `artnet.js`, `sacn.js`, `dmx_receiver.js`, `*_sender.js`, `*_wire.js`.
- Files: `documentstore.js` (.beam zips), `library.js`, `gdtfstore.js`,
  `objectstore.js`, `projectexport.js`, `paths.js`.
- Lasers: `etherdream.js`, `lasercube.js`, `idn.js`, `ponk.js`, `laser_hub.js`.
- Video: `ndi.js`, `videorecorder.js`.

**Model** -- `src/models/DMX/`
- `show.model.js` the show: load/save, fixtures, objects, structures, groups.
- `fixture.model.js` a placed fixture; `listingFor` gives an OFL-shaped listing
  for a GDTF type (channel names as strings).
- `object.model.js` placed 3D models and created shapes (scale per axis, sizes).
- `structure.model.js`, `group.model.js`, `scene_item*.js`, `selection.js`.
- `gdtf/` the GDTF pipeline: `gdtf_reader` -> `dmx_engine` (`stateAt`) ->
  `head_dispatch` (`gdtfAction`) -> the renderer. Name heuristics only in
  `name_rules.js`.
- `generic/` generated kinds (strobe, projector, display, laser, LED bar) and
  the MadMapper export (`madmapper.js`, `madmapper_layout.js`).
- `studio.js` studio cameras and shots.

**Renderer** -- `src/plugins/visualizer/`
- `visualizer.js` the scene, composer and passes, resize, recording frame, and
  all viewport navigation (orbit about the pointer, lens-shift pan, wheel,
  floor walk, lift) and the perspective/orthographic switch (`useCamera` lists
  everything that holds the camera).
- `controls.js` selection, the transform gizmo, framing and `flyTo`, view
  directions, keys.
- `light.js` / `moving_head.js` lights and movers; beams in
  `shaders/beam.*.glsl`; pools and depth-tile shadows in `light_field.js`.
- Screen passes: `ambient_haze.js`, `projector_pass.js`, `laser_pass.js`,
  `strobe_wash.js`, `selection_outline.js`.
- Others: `led_field.js` (strips), `led_panel.js` (grids), `scene_objects.js`
  (instanced 3D models), `nav_gizmo.js`, `grid.js`, `contact_shadows.js`,
  `recorder.js`, `perf_overlay.js`, `preferences.js`.

**Views** -- `src/views/activities/app/fragments/`: `visualizer/` (viewport and
its toolbar), `modifiers/` (the widgets: placement, object, fixture...),
`patch-bay/` (item list, popups), `studio/`.

## Session start

- List open pull requests and new issues (`gh pr list`, `gh issue list`) and
  bring them up before anything else. Do not merge, close or comment on them
  without being told to.

## Releases

- Immediately before `gh release create`, stop and ask "Upload to GitHub?".
  Every time, after the build and the push, whatever was agreed earlier. No
  answer, no upload.

## Running and checking

- Run: `powershell -File tools/dev/launch.ps1 [-Show x.beam]`, stop with
  `tools/dev/stop.ps1`. See `tools/dev/README.md` for eval, screenshot, perf
  and PNG comparison.
- Tests: `npm test` (esbuild bundles `test/*.test.js` into `test/dist/`, then
  runs them). One file: `node test/build.mjs && node test/dist/<name>.test.mjs`.
- Lint one file: `npx eslint <file>`. Ignore `import/no-unresolved` and
  "Resolve error" on three's examples and `?raw` imports -- the resolver cannot
  see them. Long-standing errors not to chase: a double blank line near the
  top of `controls.js`, and `class-methods-use-this` on `floorOffset` getters.
- three.js maths can be checked in plain node:
  `import * as THREE from 'file:///D:/Projects/beatline/Beam/node_modules/three/build/three.module.js'`.

## Editing

- The running app hot-reloads on every source save, and a reload loses an
  unsaved show. Check `tools/dev/probes/show-state.js` before editing while it
  runs.
- Files are mostly LF; `core.autocrlf` is true and there is no
  `.gitattributes`. Keep a file's existing endings. Avoid `git stash`; it
  flips endings and buries lint in CRLF errors.
- Multi-line patches: write a `.cjs` script to a file, match each anchor
  exactly once and fail otherwise, or use Edit. Piping node or heredocs
  through Git Bash mangles backslashes and backticks.
- GLSL inside JS template literals must not contain a backtick, not even in a
  comment. `.glsl` files imported with `?raw` may.
- Comments state current facts and the reason, not history or names.
- Commits: plain and technical, no AI attribution lines.

## Writing

Everything written for this project is plain and technical: commit messages,
code comments, changelog, release notes, docs, PR text and the manual. State
what the thing is or does, how, and the concrete reason. Numbers where they
exist. Nothing written for effect.

- A commit title is a plain statement of the change: "Laser stream counts as
  dead below a quarter of its declared rate". Not an aphorism or a balanced
  sentence: "A laser fed nothing is a laser that has gone dark, not one
  drawing thinly" is the wrong kind.
- A comment is one or two lines of current fact and reason. No story of how
  the bug was found, no measurements from one session, no quotes.
- No metaphor, judgement or flourish anywhere. The manual may be
  conversational but still plain.
- Contributions that arrive with essay comments or sentence titles are
  trimmed to this standard before they land.

# Draco decoder

The decoder `DRACOLoader` fetches at runtime, for glTF models compressed with
`KHR_draco_mesh_compression`.

Copied verbatim from `three/examples/jsm/libs/draco/gltf/` at three r170 —
the **glTF** build of the decoder, which is the one that targets the mesh
compression extension. Three ships two variations and either works with
`DRACOLoader`; the glTF one is the correct choice for `.glb` files.

Only the three files a decode needs are here:

| file | why |
|---|---|
| `draco_wasm_wrapper.js` | loads the WebAssembly decoder |
| `draco_decoder.wasm` | the decoder itself |
| `draco_decoder.js` | the fallback for a browser without WebAssembly |

`draco_encoder.js` is deliberately **not** included: nothing in Beam compresses
a model, and it is another 900 KB to ship.

## Why these are committed here

`DRACOLoader` is given a URL, so the decoder has to be somewhere the renderer
can reach. `electron.vite.config.js` copies `public/` into the renderer output,
so `public/libs/gltf/` is served over the dev server in development and over the
custom `static://` protocol in a packaged build. The two callers pass
`import.meta.env.VITE_STATIC_URL` as the prefix, which is what distinguishes
those two cases — see `setDecoderPath` in `src/plugins/visualizer/scene_objects.js`
and `src/plugins/visualizer/model_instancer.js`.

## Upgrading

Replace the three files with the contents of
`node_modules/three/examples/jsm/libs/draco/gltf/` when three is upgraded. They
are not edited, and nothing here should ever be patched by hand — the point of
committing them is that the path is stable, not that the code is ours.

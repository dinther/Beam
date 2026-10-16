# Shipped object library

Models that ship with Beatline Beam, mirroring the shape of the user's own
library at `Documents/Beatline/Beam/Library/Objects`: **one level of folders**,
a `.glb` or `.gltf` per model, and an optional `<name>.json` sidecar beside it
giving the scale, up axis and origin offset.

There is no index. The folder is the catalogue, exactly as it is for the user
library -- `objectstore.js` reads both and merges them.

A folder with nothing in it does not appear in the app, so the empty
categories here cost nothing until something is put in them.

**The user's library wins on a clash.** An object here and one of the same
`folder/name` in the user's library resolve to the user's, the same order
profiles follow: project-local, then user library, then shipped. That is what
lets somebody replace a supplied truss without deleting anything.

Nothing here is writable at runtime -- it lives inside the install. "Save to
library" always writes to the user's library.

## Sources

- `People/Female_*.glb`, `People/Male_*.glb`: Background Posed Humans by
  Quaternius (https://quaternius.com/packs/backgroundposedhumans.html), CC0 1.0.
  Licence file as shipped in the pack's download folder:
  `People/Quaternius_License.txt` (its header names another pack; the licence
  and credit line are this pack's). Each pose was joined with one of the
  pack's hairstyles, scaled to 1.78 m (men) and 1.66 m (women) and stood on
  z = 0, in Blender. `People/*_Crowd_*.glb` are new poses of the standing
  figures: the pack's meshes carry their skin weights but no skeleton, so a
  skeleton was rebuilt from the weights, posed, and baked to static meshes.

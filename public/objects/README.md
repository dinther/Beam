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

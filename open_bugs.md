- 
- Arrange to line. Aim: Along the line?
- I find the up down buttons for numbers clunky. We do a lot of number entry. The UI should be more helpful.

- Fixtures have a bright white lens like they are on while the are not.
- Export show file. Why is that not called "Save As"?
- Why is showfile.migrate.js in the source?
- What is live.model.js used for?run the app
## Why a 256 x 256 tile does not light fully (2026-08-19)

Two separate ceilings in two separate tools. Neither is Beam's, and neither
is an alignment bug -- both senders pack 170 pixels per universe correctly
and their data is continuous across every universe boundary.

A 256 x 256 RGB tile is 65,536 pixels, 196,608 channels, 386 universes at
170 pixels per universe.

**MadMapper: 65,535 channels per fixture.** Offsets in a `<PixelMapping>`
body are a 16-bit field, so a single `<LEDFixture>` stops at channel 65,535
-- 21,845 RGB pixels, exactly a third of the tile. On MadMapper's own
readout that is U128 CH 255 (128 x 510 + 255). Split a large tile into
several fixtures: four bands of 256 x 64 is 49,152 channels each, well under
it. The split must follow the scan axis, or a band's pixels are not
contiguous in the chain and its start address means nothing.

**LEDfx: 256 universes.** 131,072 channels at 512 each. It sends 43,520
pixels of a 65,536-pixel tile -- 66%, and the last universe carries the
pattern's tail rather than its continuation. 256 x 64 (97 universes) and
256 x 128 (193) are inside it and come through perfectly; 256 x 256 needs
386 and does not.

**Do not run two sources at once.** MadMapper and LEDfx both writing the
same universes made each one's limit look like the other's, and made
MadMapper's zeros past its wall look like LEDfx losing alignment mid-stream.
There is no misalignment. `tools/artnet-log.js --watch` shows the universe
count, which is how to tell one source from two.

Beam's own part in this was `UNIVERSE_COUNT` at 512 against a 777-universe
stream; raised to 2048.

Still open: creating a 256 x 256 fixture costs ~505 ms and ~240 MB, because
`prepareChannels` deep-clones the profile and then builds one `Channel`
object per DMX channel. The channel table in
`fixture.modifier.widget.model.vue` also `v-for`s over every channel, which
is 196,608 rows.

### Where the 256 x 256 got to, end of 2026-08-19

**Solved and shipped.** A tile over 65,535 channels is exported as several
MadMapper fixtures (commit `35525e1`); 256 x 256 becomes four 256 x 64 bands.
Confirmed working end to end on the wire:

- all 386 universes arrive, every one of the 65,536 pixels, ending exactly at
  the last one
- no discontinuity anywhere, including across all three band boundaries
- MadMapper's own fixture list agrees with Beam's addressing to the channel:
  band 1 ends U96 CH192, band 2 starts U96 CH193, and so on through
  U192 CH385 and U289 CH67
- band 1's Output reads Position 0,768 Size 1024x256, matching the layout's
  y=896 thickness=256

**Still open: no picture reaches the imported fixtures.** They output one
colour across all 65,536 pixels, which drifts over time as the media moves --
the signature of sampling a single texel rather than an area. Ruled out:
addressing (proven above), band placement (they tile the panel), and the
input/output rectangles (Paul checked; normal).

The clue worth starting from: Paul's *hand-made* `256 x 256` fixture does
render content properly. Ours does not. Same MadMapper, same media, so the
difference is in what we write. Two candidates:

- **Patching mode.** His is Matrix Mode with "Skip channels 511-512"; ours
  declare `patching="Fixed"`. Fixed was chosen because it is the only mode
  that honours an explicit per-pixel map -- but it may be why content is not
  sampled across the fixture.
- **Element type.** The layout writes `__FT__fixture_line` for everything,
  learned from a MadMapper export of a *strip*. A 256 x 64 matrix placed as a
  line may not sample in two dimensions.

**Next step:** MadMapper's "Export Fixtures" on (a) the project holding our
four bands and (b) a hand-made fixture with content working on it. Diff the
two. Whichever attribute differs is what the exporter has to write. That is
the same method that established 170 pixels per universe and the 65,535
ceiling.

### Resolved: `patching="Fixed"` was why no picture reached the fixtures (2026-08-19)

`patching` decides who owns the pixel-to-channel map, and that choice silently
decides whether media is sampled at all.

- **`Fixed`** — MadMapper uses the `<PixelMapping>` number list verbatim. It is
  the only mode that can express a start corner, a scan axis or serpentine
  wiring, because no attribute carries those; they exist only as the shape of
  that list. **But a Fixed fixture is never sampled.** MadMapper paints one
  texel across every pixel of it, which reads as a panel stuck on a single
  colour that drifts as the media moves.
- **`Matrix`** — MadMapper ignores the list and derives its own map from
  `width`, `height` and the start address. `Strip` is the same trade in 1D.

Measured on the wire, 256 x 256 tile in four bands, one Art-Net source, 386
universes: **Fixed carried 3 distinct RGB triples across all 65,536 pixels;
Matrix carried 248 per band.** Every channel moved in both cases, so Fixed was
live and rendering -- it was sampling one texel, not frozen or misaddressed.

**What Matrix costs here: nothing.** Its derived rule is serpentine rows, and
that is what our own map already describes. Captured with the media frozen,
even rows matched and odd rows were their exact mirror, 128 of 128. The proof
holds because the gradient is not perfectly symmetric -- 138 positions per row
differ from their own mirror, and those asymmetries flip on odd rows. A
symmetric image could not have shown this.

Confirmed end to end: exported from Beam with `Matrix`, imported into
MadMapper, content renders on all four bands with no manual mode change.

**The diff, finally done.** MadMapper's own Export Fixtures on a working
fixture (`profile_that_works.mmfl`) against ours as imported: identical in
every attribute -- group, product, favorite, avoidCrossUniversePixels, height,
type, width -- and identical across all 16,384 map entries. The only difference
is `patching="Matrix"` against `patching="Fixed"`. One attribute value was the
whole bug.

**Untested, and now cheap to settle.** MadMapper wrote the full pixel map even
in Matrix mode, byte-identical to ours. That is ambiguous: it either derived
the map from its own serpentine rule and matched us by luck of the same rule,
or it kept the map we imported and changed only the mode. If it keeps it,
Matrix honours an imported map and there is no risk at all.

Distinguish them without touching the wire: export a *non*-serpentine 256 x 64
bar from Beam as Matrix, import it, run Export Fixtures, and diff the map that
comes back. A straight map means the import is honoured. A serpentine map means
MadMapper overrode it -- and a straight-wired panel would render with every odd
row mirrored, a wrong picture rather than a dark one.

**Also untested by this capture:** absolute orientation. The test gradient is
vertically uniform and near-symmetric horizontally, so top-vs-bottom start
corner and left-vs-right handedness are both invisible to it. A bright single
corner, or a diagonal ramp, would pin all three properties in one capture.

Movers keep `Fixed` deliberately: a 1x1 `Custom` has no grid to derive, and its
channel meanings live in the `components` attribute.

Ruled out along the way, so nobody re-opens them: addressing (proven to the
channel), band placement, input/output rectangles, `__FT__fixture_line` as the
element type, and a stray MadMapper instance on another machine -- that last
one was suspected and excluded by capture, single source, 386 universes.

### Open: inbound Art-Net takes ~a minute to reach the 3D view (2026-08-19)

Changing the media in MadMapper takes about a minute to show up in Beam, with a
256 x 256 tile on the wire. Every inbound frame runs two paths:

- `dmx_store.write` -- one `data.set` into the universe texture. Cheap, and
  what the `led_panel` shader actually reads.
- `PatchSingleton.writeUniverse` -> `writeChannel` -> `fixture.setChannel` --
  per channel, and for this fixture that is 196,608 channels per full refresh.

Measured: the two Map lookups in `writeChannel` are *not* the problem -- a full
386-universe pass costs about 5 ms against the 25 ms a 40 fps sender allows.
The remaining suspect is `setChannel` itself, which per channel does a
`getCapability` lookup and a `capability.getValue` that allocates an object,
then writes into `_3DModel`. At 15,437 packets/s (measured) that is roughly
7.9 M allocations/s.

The sender's rate is measured, not assumed: `tools/artnet-log.js` recorded
154,377 packets in 10 s.

If it is a backlog, the delay grows the longer the app runs rather than
settling at a minute -- that is the cheap way to tell it from fixed overhead.
Worth checking whether the model fan-out is needed at all for a panel whose
pixels the shader reads straight from the texture.

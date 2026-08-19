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

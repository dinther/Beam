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

# Changelog

## 0.1.0-alpha.3

Almost entirely about large LED panels, which were slow in three separate
places. Every number below was measured rather than estimated.

### Big panels are usable

- **Adding one is about fourteen times faster.** A 128 x 128 panel took roughly
  a quarter of a second in the model layer alone and now takes under twenty
  milliseconds. A 256 x 256 went from over half a second to a fraction of it.

  A bar's channels are all the same thing -- an 8-bit colour intensity for one
  component of one pixel -- so a 256 x 256 was building 196,608 objects that
  differed only in an index and a colour name. They are a numbered range now.
  The profile is also no longer deep-copied for every fixture: that copy
  guarded one assignment a generated bar never makes, and was 46% of the cost
  of adding a panel.

- **Selecting one no longer stalls.** The channel map asked for a table row per
  channel -- 294,912 page elements for a 128 x 128, over a million for a
  256 x 256, every one saying the same thing about a different pixel.

  A generated bar now shows a summary instead: grid, components, channel count,
  address span, universes used, wiring, and whether pixels are kept whole, plus
  the first and last pixel as sample rows. **Copy map** still gives you every
  channel. Ordinary fixtures are unchanged -- the largest profile in the
  shipped library is 127 channels, so the full table was only ever a problem
  for panels.

- **Incoming Art-Net keeps up better.** A full refresh of a 128 x 128 went from
  20.2 ms to 9.3 ms, which is 37% of a 40 fps budget where it was 81%. A
  256 x 256 halved, 83.9 ms to 39 ms -- that one still cannot hold 40 fps, but
  it is viable to about 25 where it was about 11.

- **An empty scene ignores DMX it has no use for.** With a 256 x 256 tile on
  the wire and nothing in the show, Beam was pushing 7.5 MB/s to the graphics
  card for nobody to read. It now does nothing at all.

### The splash screen shows once

It reappeared on every New Project and every Open, because both reload the
application window internally. It now shows only when Beam starts. The version
panel still opens any time from the toolbar.

One consequence: the splash was also what covered a load and blocked input
while it ran, so New Project and Open now go straight through with no progress
messages. On a large show that means a short spell where the window responds
while fixtures are still being patched.

### Groundwork

3D models dropped into `Library/Objects` are now listed and served to the
renderer. Nothing uses them yet -- there is no way to place one in a scene.

### Known

Dragging multi-selected fixtures into a group can still lose them, and the loss
reaches disk. It is the one bug here that destroys work rather than merely
annoying you.

## 0.1.0-alpha.2

### Before you open an existing show

- **Matrix fixtures now reserve the channels they actually use.** OFL describes
  a grid once and lets a mode pull in the product of it, and Beam only
  understood modes that listed their channels one by one — so an Illusion Dotz
  4.4 claimed 10 channels where it needs 57 and whatever came next was
  addressed over the top of it. Ninety-three of the 485 shipped profiles were
  affected. If you patched two matrix fixtures next to each other, the second
  one will now report a collision.

- **Brightness is no longer a hundred times over.** A capability declaring
  `0%..100%` was read as a range ending at *100* rather than at 1, so anything
  spelling out what the format already implies drove its emitters far past
  full, saturated and clipped and unable to vary. Every generated LED bar was
  affected. 265 effect-speed channels were wrong the same way and now run to
  their full declared 360 rather than stopping at 100, so effects driven from
  them move faster than they used to.

### MadMapper export

#### One fixture arrives as several. This is deliberate.

Expect more fixtures in MadMapper than you have in Beam. A MAC Aura becomes
five; an Illusion Dotz 4.4 becomes three. Nothing has been duplicated — one
fixture has been described as the several different things it actually is.

A MadMapper fixture carries **one component type for all of its pixels**. A
moving head is not one type: it is a mechanism that aims, a set of emitters
that make light, and a handful of control channels that do neither. There is
no way to say that in a single MadMapper fixture, and trying to meant sending
the whole thing as one pixel with every channel a slider — which is why the
emitters never sampled any media.

So Beam walks a fixture's channels in order and cuts them into **islands**,
starting a new one each time the kind of thing changes:

| Island | What it is | How it is exported |
| --- | --- | --- |
| **Light** | emitters — red, green, blue, white | a grid, so media is sampled across it |
| **Movement** | pan and tilt | sliders, which you can point at a colour |
| **Control** | shutter, dimmer, macros, speed | sliders |

An Illusion Dotz 4.4 in its 59-channel mode comes out as:

```
Illusion Dotz 4.4 1
    Pan Tilt     channels 1–4     pan and tilt, 16-bit
    RGB          channels 5–52    16 emitters, a 4 × 4 grid
    Control      channels 53–59   shutter, dimmer, programs
```

They are grouped under the fixture's own name, so the fixture list stays
navigable however many parts a head comes apart into. Only the **light**
islands take media; movement and control arrive as sliders, live and
controllable from timelines and controllers, and you can point any of them at
a colour channel if you want the media driving them — aiming a head from a
gradient, for instance.

A fixture with mixed emitters comes apart the same way and for the same
reason: a run of RGB pixels followed by a white one is two islands, because
the component type changed, and MadMapper cannot hold both in one fixture.

The practical gain is that a MAC Aura's colour channels are now an island of
their own, so it takes media colour instead of sitting on dead sliders.

You can now also map your pan and tilt onto the Beatline Mover Wave material while
you obtain the light color from a different material.

#### The rest of the export

- **Fixtures arrive at the right size.** A grid states its width and height and
  a run states its length. Saying neither left MadMapper to invent a size: a
  128 × 128 tile came in as a hundred pixels in a single row, and a sixty-pixel
  bar came in as a hundred.
- **Panels are drawn as panels.** A profile now says whether it is a bar or a
  panel. A bar is a line with a thickness as before; a panel is the rectangle
  it occupies, drawn from its projected corners, so a tilted tile arrives
  tilted and keeps its proportions.
- **Names MadMapper refuses are handled.** A dot in a group name, a stray
  slash, or two groups alike anywhere in the tree each failed an import
  outright. A structure also gets a group of its own, with a group per mapping
  inside it, so a rig exported from two views stays legible.
- **A definition names its mode.** MadMapper's library outlives the project
  that filled it and its import only ever adds, so the same model in two modes
  needed telling apart.
- **Exporting asks once.** One dialog, for the layout; the definitions are
  written beside it under the same name. After that, every export goes straight
  back to the same pair of files, remembered per project for the session. The
  layout no longer carries a projection in its name, since one file can hold
  several.

### Fixtures

- **garageCube's LED bars ship with Beam**, in the fixture catalogue alongside
  every other manufacturer: LED 25, LED 50 and LED 100. Their pixel counts are
  cross-checked against MadMapper's own presets and garageCube's published
  specifications — the RGB bars wire their LEDs in threes, so a metre is twenty
  controllable pixels rather than sixty.
- A large tile is exported as several MadMapper fixtures, since one cannot
  address more than 65,535 channels.
- Grid fixtures are exported in Matrix mode. A Fixed fixture is never sampled:
  MadMapper paints one texel across the whole of it.
- Exported bands stack down a tile's face rather than up it.

### Library

- **A new install starts with something in it.** Three example structures are
  placed in your library on first run — **Fusion** and **Portal**, thirty LED
  bars each, and **ring burner**, twelve moving heads — so there is something
  to drop into a scene and take apart before you have built anything. The LED
  bar profile the first two are made of is installed with them; ring burner
  uses a Spica 250M from the fixture catalogue.
- They are given once and then left alone. Edit one, rename it, or delete it,
  and it stays the way you left it — nothing is put back on the next launch.
- Your library lives in `Documents\Beatline\Beam\Library`, as ordinary files
  you can open, copy to another machine, or send to somebody.

### Projects

- **A show has one name, and it is the project's.** The name stored inside a
  showfile predated projects being folders, and nothing updated it once a
  project was saved — so an export offered `untitled` however the project was
  named. It is gone; the folder is the name. Older showfiles still open.
- A structure is numbered from the first one, as fixtures already were.

### Fixed

- Haze stopped reaching LED bars and panels when the grid renderer took over
  drawing them. Moving heads were unaffected, which is what made it look like a
  fixture problem rather than a scene one.
- Deleting a structure with its members selected threw *"Cannot find fixture in
  pool"*. Deleting something already deleted is now an ordinary outcome.
- Inbound Art-Net lagged by about a minute on a large tile: one IPC message per
  packet, 15,437 a second, plus per-channel work for pixels that read their
  colour straight from the DMX texture and never looked at it.
- Beam holds 2,048 universes. At 512 it was quietly dropping a third of a large
  rig.

### Known issues

- Amber and UV channels are patched and consume addresses, but are not yet
  rendered or driven.
- A fixture's dimmer does not change the brightness of its beam in the 3D view.
- An LED bar shows a moving-head icon in the fixture browser.
- A grid wired straight rather than serpentine may come back from MadMapper
  with alternate rows mirrored.

# Changelog

## 0.1.0-alpha.6

A rig can be as big as a rig. The hundred-fixture ceiling is gone, inserting a
large structure takes seconds rather than five minutes, the floor is something
you can move or delete, and every number in the app is a value you drag rather
than a box you click at.

### Several hundred moving heads

- **The 100-mover ceiling is gone.** `MAX_INSTANCES` was allocated once and
  never checked, so the hundred and first head wrote past every instanced
  buffer -- silently, because three drops an out-of-range write. Its `count`
  then exceeded the capacity, which degenerates the whole draw: *every* head
  vanished, leaving the selection box around nothing, and a second large
  structure took the renderer down. Capacity now doubles on demand.
- **Lights live in a texture instead of a uniform array.** three compiles every
  light into every lit fragment shader, and at 198 heads `MeshStandardMaterial`
  stopped linking outright -- a program that will not link draws nothing, which
  is why the bodies went while the unlit beam caps stayed. Light parameters are
  now read from a float texture, so the count is bounded by texture size rather
  than by uniform slots.
- Measured on a ring burner plus two 99-mover structures under live Art-Net:
  **60 fps, 1.55 ms CPU and 3.0 ms GPU a frame**, at 4K.

### Inserting a structure

- **Four minutes forty-five became seconds.** Of 284,860 ms spent placing a
  115-member structure, the work itself -- every fixture built, named,
  addressed and patched -- was 48 ms. The rest was `await` handing control back
  to the renderer between members, and a frame mid-insert is not cheap. The
  profile cache the load path has always had now covers this path too, so the
  awaits resolve immediately and the loop runs to the end.

### The floor is an object

- **A plane in the show, not a cube in the renderer.** It was a 50 x 50 x 0.5
  box bolted to the scene that nobody could move, resize, replace or delete and
  the item list never knew about. Existing shows are given one on load.
- The **Floor** checkbox in Visualizer settings is gone with it -- it existed to
  hide something you could not otherwise be rid of.
- **Box selection ignores things bigger than the box.** Overlapping still
  counts, so dragging across half a truss takes the heads it touches; an item
  larger than the band has to be enclosed. Without it every band drawn near the
  middle of the stage picked up the floor.

### The grid

- **Each decade fades by how big its cells are on screen**, not by distance, so
  lines are gone before they can alias. Leaning in brings up a tenth of the
  unit; pulling back retires it. No setting to choose.
- Lines are measured properly now. `fwidth()` over-estimates by up to twice on
  a diagonal, so width varied with the angle a line made with the screen.
- **Grid brightness** and **Grid line width** are on the Visualizer panel.

### Numbers

- **Drag a number to change it.** Right and up raise it, the wheel nudges it on
  hover, and **Alt** is the fine control on both. The pointer locks while
  dragging, so a long pull does not end at the edge of the screen. The up/down
  arrows are gone.
- **No box until it is being typed into.** A border around every number is most
  of what made a panel look like a form to fill in rather than values to work
  with.
- A field given a colour marks itself with a rule underneath -- the axis fields
  in the position tool.
- **`step` is separate from `precision`.** Position Z showed one decimal, so a
  step *and* the resolution were both 0.1, and Alt asked for 0.01 only to have
  the rounding put it back. Positions now drag in tenths and hold hundredths.
- **Alt no longer opens the Windows menu bar.** It resized the window under a
  locked pointer, arriving as a single 1159-pixel movement that threw a fixture
  across the room mid-drag.

### Arrange

- **Aim is an angle**, and every shape aims the same way. Outward is zero from
  the radius, inward 180, along a line zero -- and ninety, which nothing could
  ask for before, is heads tangential to a circle or a row square to its line.
  Grids can be aimed at all now.
- Measured from the shape or from the world; from the world points a whole rig
  the same way wherever each fixture sits.
- **Keep heading** replaces Set heading and is off by default, so arranging a
  set aims it.

### Selection and the modifier panel

- **One guard for every kind.** Three per-kind checks were hardened one at a
  time and the object one never was, so two selected speakers showed a
  single-object editor beside the multi-item one -- and nudging it dropped the
  other speaker out of the selection.
- **`Controls.detach` drops the item it is handed** rather than the whole
  selection. Every per-axis write goes through it, so nudging one item of a
  multi-selection silently dropped the rest.
- **A selection can be typed into.** Position moves its centre and keeps the
  spread; rotation swings it about its own centre. The fields hold a running
  total and apply the difference, which is what makes a value committed twice
  -- on Enter and again on blur -- turn 45 degrees rather than 90.
- Structure members are selectable again; the panel had been assigning to
  computed properties, which Vue refuses.

### Objects

- **Create object asks how many**, and offsets copies as the fixture and
  structure paths do.
- A plane is **single sided**, so it works as a ceiling rather than hiding the
  room from any camera above it.
- Names follow the type until you have typed one.

## 0.1.0-alpha.5

Haze got about ten times cheaper and now fills the room rather than only the
beams, the scene finally has ambient light, and objects can be built, edited and
organised without leaving the app.

### Haze costs a tenth of what it did

- **About 10 ms of GPU time down to about 1 ms**, measured across twelve beams
  filling the screen.

  Every fragment of every beam was evaluating four octaves of simplex noise --
  a lattice permutation, eight gradient dots and a normalisation, four times
  over, for each pixel the beams covered. The same field is now baked once into
  a small tiling 3D texture and read back with four filtered fetches.

  Those four fetches cost what one did, which says the bottleneck was never
  bandwidth. There is room to spend on quality if it is ever wanted.

- **One field for every fixture type.** Beams, LED strips and panel halos read
  the same noise at the same scale through one shared shader. The glows had been
  sampling a flat slice with time standing in for the third axis, through a
  private feature size the haze scale control could not reach -- so a glow and a
  beam standing in the same air disagreed about how coarse that air was.

### The room has light of its own

- **Ambient light**, where there was none. A single directional lamp meant every
  surface facing away from one corner rendered pure black. An environment lights
  them now, which also gives metals something to reflect.

- **Haze in the air itself.** Everything that showed haze was geometry -- a beam
  cone, a glow billboard -- so the space between fixtures was perfectly clear. A
  depth-aware pass now walks each view ray through the same field, so the room
  has body.

- **House lights up clears the room**, the way work light does, while beams and
  LED glows keep theirs. The background lifts to a working grey and returns to
  the chosen colour when the house goes down.

### Objects

- **Build them in the app.** Cubes, cylinders, spheres and planes, with a name,
  a size in millimetres of a metre, and a colour.

- **They stay editable.** A created object keeps its parameters in the show, so
  it can be widened or recoloured whenever -- select it and the same fields that
  made it are there to change. Creating one used to mint a permanent library
  entry and freeze it, so a wider cube meant a second cube.

- **Save to library is a separate, deliberate act**, and it saves a template:
  the object in the scene keeps its own parameters, so editing it later cannot
  reach back and change everything else stamped from that entry.

- **Folders**, one level, in the object library. Objects are referenced by path
  now, so two folders may each hold a truss; shows written before folders
  existed still resolve.

- **A library that ships with the app**, merged with your own. Yours wins on a
  clash, so a supplied model can be replaced without deleting anything, and
  deleting yours brings it back.

- **A browser with pictures.** The Objects tab is folders of square tiles, and a
  preview is rendered for anything that has none and stored beside the model --
  once in the life of a library, not once per session.

### Fixed

- **Undo and redo have never worked.** They were declared static while the Edit
  menu called them on the show, so both threw the moment they were clicked.

- **Selection is one thing now.** It had been kept in three places at once --
  the route, an event and the 3D view -- with each consumer holding its own
  copy and nothing reconciling them. Adding several fixtures left the
  single-fixture panel up; an object picked in 3D never lit its row; selecting a
  fixture left another kind's widgets on screen. Everything that shows a
  selection now reads one source.

- **Everything added to the scene arrives selected** -- all of it, not just the
  first of a batch -- so the next step is available without selecting it again.
  Applying an arrangement keeps the selection too.

- **Screen recordings no longer leak.** Each one stayed in memory for the rest
  of the session, and the download threw on its way out.

## 0.1.0-alpha.4

Two things: DMX input got a great deal faster, and MadMapper finally takes our
LED panels the right way up.

### Inbound Art-Net keeps up now

- **60 fps on a 256 x 512 panel**, which previously could not keep pace with its
  own stream above about eleven.

  The same bytes were travelling two paths. One memcpys a universe into the
  texture the LED shaders actually read; the other fanned the identical bytes
  out one channel at a time, through two hash lookups each, into a second copy
  that nothing in the render path ever read. On a large panel that is tens of
  millions of lookups a second maintaining a duplicate for a consumer that does
  not exist.

  Fixtures are indexed as address spans rather than one entry per channel, so
  patching, unpatching and lookup no longer scale with channel count -- which
  also takes a large slice off the cost of creating a panel. A bar takes a
  single block copy per universe, because the write is cheaper than checking
  what changed.

- **Frames cross to the renderer once instead of twice.** Process isolation was
  costing two copies of every batch; a transferred message port removes one.

### MadMapper panels import the right way up

- **Panels export as line fixtures.** MadMapper flips a quad fixture vertically
  when it imports one -- including one of its own exports round-tripped through
  it -- while a line fixture imports correctly. Reported upstream; this is a
  workaround, and it will be reverted when a fix ships.

  Nothing is lost by it. A panel band was already described by its centreline,
  so the line form is the same rectangle with the band's height as its
  thickness, and it keeps its grid, so the pixel map is unchanged.

- **No more seams between the bands of a large tile.** A tile too big for one
  MadMapper fixture is split into bands, and the fitted layout was clamping
  their thickness -- a band drawn narrower than its neighbour is far away leaves
  a black line down the middle of the panel. A 128 x 256 panel was losing 24
  units per seam.

- **One definition per tile instead of one per band.** A grid fixture derives
  its dimensions from where it is placed, so the definitions the bands were
  each getting were identical. The `(1/4)` suffixes go with them, and so does
  `(Default)` on every generated LED profile -- it was a mode name, and a
  generated bar has exactly one mode.

### Smaller

- Creating a generic fixture: changing the type renames the fixture to match,
  until you have named it yourself.
- Fixture islands stack rather than sitting side by side on the canvas, so the
  same island of every fixture lands on one line and a single rubber-band takes
  the lot.

### Under the floor

- The layer beneath 3D scene objects: models are served over a privileged
  protocol so a .glb streams from disk rather than being marshalled across
  process boundaries. Nothing above it is finished -- there is no persistence
  and no import UI yet.

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

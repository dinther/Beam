# Changelog

## 0.1.0-alpha.9

Cameras became something to run a show from. Each one carries its own cut and
fly, selecting a camera no longer moves the viewport, a padlock keeps a framing
you have set, and a project reopens looking the way you left it. The recorder
captures the room's audio with the picture. And the version in the About box is
finally the version of the build.

### Studio cameras

- **Cut and fly, per camera.** Both sit on the camera's own row, so how you
  arrive is chosen at the moment you go. A mode set beforehand is a second
  action, and by the time it matters you cannot see what it is set to.
- **Fly eases in and out.** Smootherstep: zero velocity *and* zero acceleration
  at both ends, so a move neither kicks off nor jolts to a stop. The curve the
  view buttons had eased out only, starting at full speed.
- **It reuses the animator the view buttons already had** rather than growing a
  second one to drift apart from the first. Two faults had to be fixed for it to
  be usable. The ten-times-a-second sync writes the live view into whichever
  camera is active, so mid-flight it would have overwritten the destination with
  the journey. And the old loop stopped on the first frame past its duration
  without applying the end value, settling a little short of where it was sent --
  invisible on a view button, and with the sync running, enough to nudge a camera
  further from its framing on every single trip.
- **Selecting a camera no longer goes to it.** What the viewport shows and what
  the details panel edits are now two different things, because live you have to
  adjust a camera you are about to cut to without putting it on screen first.
  Typing a position only moves the view when the camera you are editing is the
  one you are looking through.
- **A padlock per camera.** A locked camera stops following the view: orbit all
  you like while it is live and it keeps the framing it was locked at, so cutting
  away and back returns to it. Three separate paths had to respect that, not just
  the obvious one -- the periodic sync, the capture taken when cutting away, and
  the capture taken when leaving studio mode.
- **A project opens where you left it.** The editor camera is saved with the show
  and assumed on load. Unlike a placed camera it has nowhere else to live, so
  closing a project used to lose it. Two things stood in the way: the opening
  view was chosen after the restore and flew straight over the top of it, and
  nothing wrote the editor camera while you work, since the sync only runs in
  studio mode.

### Recording

- **Desktop audio, with the picture.** The system audio mix is captured
  alongside the canvas and muxed into the same file, so a take of a show carries
  the track it was run to and needs nothing afterwards.
- **The constraints are not decoration.** Left to itself the loopback device
  arrives mono with echo cancellation, noise suppression and automatic gain all
  enabled -- sensible for a voice call, ruinous for music, which pumps under AGC
  and smears under noise suppression. Asked explicitly, it gives clean stereo.
- **Audio failing does not fail the take.** You get the picture and a note
  saying why there is no sound, rather than a silent file discovered later.

### Look and light

- **Bloom is on**, at a floor a good deal lower than it was carrying. At no haze
  it ran nearly twice the reference intensity with a gate low enough that
  anything past a third brightness bloomed before any air was involved. It stays
  tied to haze density rather than becoming a setting: it already answers to a
  control in the scene, and a second control over one quantity is how the LED
  glows once ended up with a private turbulence scale the slider could not reach.
- **Created cubes and planes answer the house lights.** They took diffuse light
  from the room only, which is a flat lift with no highlight anywhere -- and
  reads as no response at all.
- **The debug panel remembers.** Every control is stored and put back at startup.
  The constants in the source stay the single source of truth and only departures
  are kept, so a value changed in a later version still reaches anyone who has
  opened the panel.

### The version in the About box

- **It reads the version of the build now.** It came from the nearest git tag
  while the installer was named from `package.json`, and the two drifted apart
  for three releases -- because `gh release create` makes a tag on GitHub and
  never in the working copy, so the newest local tag sat twenty-eight commits
  behind. The file on disk said alpha.8 and the splash inside it said alpha.5,
  silently. Both read `package.json` now, so they agree by construction.


## 0.1.0-alpha.8

Beam projects. A generic projector throws a real picture onto the scene --
occluded by whatever is in the way, softened by the haze it crosses, and
photometrically honest about how much light a machine of that rating actually
puts on a wall. Displays became parametric panels that can be curved. The video
path grew a decode pass, pixel-exact slicing and a preview. And the MadMapper
export learned that a group is a thing worth naming.

### Projection mapping

- **Projectors put light on the scene.** A generic projector with a parametric
  body, a lens placed where the real one is, throw ratio, zoom and lens shift.
  The picture lands on geometry, is cut where something blocks it, and falls off
  with the angle it strikes at.
- **Its own projective pass, not a spot light.** Three's SpotLight very nearly
  fits -- the map projects, the shadow occludes -- and two things stop it. The
  renderer's shadow-caster budget is eight texture units shared with every mover
  in the show, and a mapping rig is three to six machines on one building; and a
  spot light's shadow camera is a symmetric frustum, which cannot express lens
  shift. A machine mapping a facade sits below it and shifts up, so a symmetric
  frustum draws the picture somewhere the real one would not.
- **One depth atlas, tiled.** Each projector renders what it can see into a tile
  of a single texture: one texture unit however many projectors there are, and
  the reason a church shadows its own facade.
- **Overlap is honest, and blendable.** Two machines on the same stone add up
  and read as a hotspot, which is what tells you where to blend. Four per-edge
  soft-edge widths ramp the picture down; the ramp is linear because this pass
  adds light the way projectors do, so a complementary pair sums to exactly one.
- **The beam is visible in haze.** The same frustum and occlusion test walked
  along the view ray instead of stopping at the surface, so the shaft and the
  picture cannot disagree -- an occluder that shadows the facade cuts the shaft
  above it too. It reads the shared haze volume the beams and LED glows use, so
  it churns with the same air, and it pays extinction: thicker haze scatters
  more towards the eye *and* swallows the beam sooner.
- **Lumens mean something.** Illuminance is lumens over the area the lens makes
  at that distance, so the rating, the throw ratio and the placement decide the
  picture between them. Narrowing the lens now brightens it, which it did not
  before. The widget reads the number back as lux at twenty metres.

### Displays

- **Parametric panels.** Width, height, depth, bezel, pixel count and emitter
  size, with a pixel-grid shader that dissolves to the plain bitmap as the panel
  gets small on screen.
- **Curved, convex or concave, on a radius.** The casing and the screen are both
  built from one surface function, so the frame, the recess walls, the sides and
  the picture all follow the same arc. The width is arc length, not chord:
  bending a panel does not cost it pixels, and two panels on one radius butt
  together continuing the same circle.
- **A casing with a hole in it.** The screen used to be a plane floated a
  millimetre in front of a plain box -- two parallel faces covering the same
  pixels. Depth resolution falls off with the square of the distance, so past
  about fifteen metres they landed in the same bucket and the casing punched
  through the picture in hard bands. The front is now four strips around an
  opening with the screen in a shallow recess: nothing overlaps anything.

### Video

- **A decode pass.** NDI's UYVY is unpacked once per arrived frame into an RGBA
  target with a full mip chain and anisotropic filtering, rather than being
  sampled as packed bytes by every surface that wants video.
- **Slices are pixel-exact.** A connector's rectangle is written in the pixels
  of the frame it was authored against, and the frame is stored beside it. A
  tenth of a percent of a 4K frame is nearly four pixels, so a percentage could
  not name an edge. Held as a fraction underneath, so a sender that switches
  from 4K to 1080p still scales.
- **The slicing editor shows what the device receives**, including what rotate
  and flip do to it, and connectors are named HDMI 1 after the socket a
  projector's source select actually cycles.

### The MadMapper export

- **A group is part of a definition's identity.** Two of the same model in
  different groups export as two definitions, named for what they belong to, so
  each can be driven by its own controller. A structure counts as a group --
  it is the tighter of the two.
- **Group-scoped definitions are filed under Beam Temp.** MadMapper's library
  outlives the project, and a definition scoped to one flank of a rig is not a
  product its manufacturer makes. Together under one obviously temporary name
  they can be found and thrown away as a set.
- **A structure names its own group in the layout.** A fixture that comes apart
  carried its own name as the outermost group, which is right when it belongs to
  nothing and wrong the moment it does. A moving head always comes apart, so a
  truss of nine exported as nine groups with the structure's name nowhere.
- **A failed export says so.** Windows refuses a write while another program
  holds the file open -- which is exactly what MadMapper does with a layout it
  is reading. The write is retried, and a real failure raises an error naming
  the file instead of returning quietly. A remembered path writes with no
  dialog, so a silent failure was indistinguishable from a success.

### Lighting

- **House lights off is dark, not absent.** The environment intensity carried a
  correction meant for three's RoomEnvironment -- a bright photographic studio
  that has to come down an order of magnitude -- and applied it to every
  environment, including the dark venue, which is already dim by design. House
  off with no haze measured a floor at 1 of 255 and everything else at 0. The
  correction is now per environment, and the venue's own light was evened out so
  a vertical surface is not five times darker than the ground.
- **Antialiasing is back on.** MSAA had been left at zero and the viewport was
  rendering at 0.8 and being stretched by 1.25 -- a non-integer resample of an
  unfiltered image, which is a regular hatch on anything finely detailed. Both
  restored, at 3.27 to 4.72 ms on a 500-mover show.

### Fixes

- A projector or display with no DMX channels no longer errors when patched, and
  a saved show containing one loads.
- The projector's frustum aid and its light disagreed on lens shift in opposite
  directions; the wireframe now follows the light.
- The depth atlas read its tiles with one size for both axes, on an atlas three
  across and two down -- so every lookup was stretched vertically and surfaces
  well inside the frustum were reported as blocked.
- Selecting a fixture no longer casts its gizmo into the projector's shadows.
  Hiding an object before a render does not hold if it manages its own
  visibility from updateMatrixWorld, which three's TransformControls does.
- The panel pixel grid was drawn on the connector's texture coordinate rather
  than the panel's own surface, so a narrow slice of a 60-pixel wall came out as
  eight stretched columns.

## 0.1.0-alpha.7

Beam listens to the other wire. sACN arrives beside Art-Net, sources have names
instead of addresses, and the MadMapper export knows which protocol you are on
and numbers its universes to match. Items copy and paste. And the beams stopped
speckling.

### sACN (E1.31)

- **A second protocol, receiving.** `sacn.js` parses E1.31 to the spec's own
  layout -- root, framing and DMP layers, offsets named rather than counted --
  and everything after the parse is shared with Art-Net.
- **Sources have names.** An sACN packet carries a CID, a 64-character source
  name and a priority, so two applications writing one universe can be named
  rather than suspected. Art-Net carries no identity at all; the sender's
  address is all there is. Highest priority wins, equal priority means last
  frame in, and a contended universe is logged once per pairing with both
  names. This is the failure that cost a whole evening when MadMapper and LEDfx
  were both on the wire and each one's ceiling looked like the other's fault.
- **Multicast joins follow the patch.** E1.31 arrives on a group per universe,
  and a group has to be joined before anything from it is seen. Joining the
  whole space would be 32,768 IGMP memberships where a real switch gives up in
  the hundreds, so `patchedUniverses()` reads the rig's own run list and joins
  only those -- rechecked every two seconds as fixtures come and go.
- **One receiver, two protocols.** Art-Net and sACN differ in a port and a
  packet; everything that took the tuning -- one reused buffer per universe, a
  dirty set, one packed message per display frame -- is now `dmx_receiver.js`
  and belongs to both. A 256 x 256 tile is 386 universes at 40 fps, 15,437
  packets a second, coalesced to about 60 messages carrying the same bytes.
- Receive only, both wires. Whatever drives the rig owns it; a second
  transmitter would only raise the question of which application to believe.
- `tools/sacn-send.js` and `tools/dmx-watch.js` for driving and reading either
  protocol without the app.

### The MadMapper export knows which wire

- **A protocol selector on the export.** Beam's address space counts universes
  from zero and so does Art-Net, so the number written was always the number
  the patch bay shows. E1.31 counts from one and MadMapper follows it, which
  put every fixture in an sACN project a universe early. The export popup now
  asks which wire MadMapper is driving and writes `__UN__` to match.
- Export-time only: nothing is stored on the show, both receivers keep
  listening, and Art-Net is the default -- so an unchanged export is byte for
  byte what it was.

### Grouping for MadMapper

- **A structure can be cut by island type instead of by fixture.** A head that
  comes apart is exported as a group holding its own `Pan Tilt`, `RGB` and
  `Control`, which is right for a rig and wrong for forty-eight heads in a
  grid: what anybody reaches for there is every head's movement, because that
  is what takes a material. Finding those meant opening forty-eight groups.
  One group per island type, one click, one material.
- **The vertical stack went with it.** Islands were stacked at each fixture's
  position so a rubber band could take one type across a row. On a grid that
  put every row's islands into the row below. One type to an island means one
  part per fixture, so each stands where it really is. Measured on a synthetic
  three by three: grouped by fixture, nine groups of three rows by one column
  -- the grid split nine ways; grouped by island, three groups of three by
  three, which is the grid.
- Bars and tiles stay whole. Their bands are slices of one continuous thing
  rather than different jobs, so cutting them by suffix would produce `(1/4)`
  groups standing for nothing anybody would select.

### Copy, paste and duplicate

- **Items copy and paste, in the list and the 3D view.** Ctrl+C, Ctrl+V and
  Ctrl+D over fixtures, groups, structures and objects. A paste is given fresh
  ids, unique names, and a free address found for every fixture in it, so it
  never lands on top of what it was copied from. Keys are ignored while a text
  field has focus.

### Beams

- **A beam cannot draw black, so every black pixel was a NaN.** Five hundred
  movers and the beams came apart into static. The material is additive with
  `depthWrite` off, so black is not a colour it can produce -- unless the
  fragment is NaN, which the half-float buffer stores, bloom's threshold
  rejects rather than spreads, and the tone mapper resolves to black. Three
  sources, each mapping onto something visible: a vertex normal normalising a
  cancelled cross product where a cone is edge-on (most of a thin beam's
  pixels); a view direction taken from what was actually the *clip* position,
  which collapses toward zero for anything near the 0.01 m near plane and
  wedged across the view as a cone swept the lens; and three uses of `pow`
  with a base that could be negative or zero. The distance term is `length`
  now, which is what it was computing all along, and drops six transcendental
  ops from the most overdrawn shader in the app.
- **The composer was blitting a depth buffer onto itself, sixty times a
  second.** `GL_INVALID_OPERATION` from the first frame until Chromium's
  per-context cap gave up -- which is the real damage, because every GL error
  in the session after the first few seconds was then thrown away silently.
  The three depth textures were one `DepthTexture` and two `clone()`s, and a
  clone shares the original's `Source` by reference, so three resolved them to
  one `WebGLTexture`: read and write were the same image. Measured over six
  minutes on the 33-fixture show, that error count is now zero against a
  continuous flood before.

### Smaller things

- **Aim is a real heading.** An arrangement's `aimZ` was written into Euler z,
  which is the item's *own* axis rather than the room's, so a head hanging at
  rotX 180 or an object tipped about y tumbled instead of swinging. It is a
  quaternion turn about the room's vertical now.
- **Item order could not be rearranged.** A list rebuild carried the selected
  row across by index, so inserting rows above it moved the mark to whatever
  now sat at that index rather than keeping the row picked out.
- **Numeric fields answer Shift and a sustained spin.** Shift is ten steps and
  Alt a tenth, on the wheel as on the arrow keys and the drag, and a wheel held
  in one direction accelerates up to ten notches after a short grace. A field
  with no step of its own now steps by one rather than by its display
  precision.
- **A placeholder name is called out before you file something under it.**
  Saving a group or structure to the library warns when its name is one it was
  handed -- `untitled 1`, `Group 3` -- rather than one you chose, because the
  name is how it is filed and how it is found again.
- **The auto-rotate takes twice as long to come round.** Twelve seconds a
  revolution was a turntable; it is about twenty-four now.

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

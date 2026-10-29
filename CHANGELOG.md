# Changelog

## 0.1.0-alpha.25

### Objects and structures

- Created objects have a **Truss** generator (2, 3 or 4 chords, five profiles, straight or arc, cross members, square or round end plates), a **Drape** generator (straight or arc, drop, floor gap, fullness, split or single panels, open amount) and a **Barrier** generator (stage, steel, plastic, water, jersey, fence, belt, rope and handrail, straight or arc runs). Generated shapes have UVs in metres.
- **Faces** per object: As model, Single sided or Inside out.
- Structures scale per axis from the Placement size fields and the gizmo.
- Structure members can be dragged into a new order.
- The move and rotate gizmo works in **world or local** axes, chosen on the toolbar or by pressing T or R again with the gizmo shown.
- Undo no longer leaves fixtures pointing at a structure or group that was exploded.

### Patching

- Lists show each fixture's first to last channel (13.123-132); Fixture settings shows **Ends at**.
- A **continue** button starts a fixture on the channel after the patched fixture above it, and the highlighted fixtures below after that. Under a strict patch a refused address stops the run and names the fixture holding the channels.
- A Pan or Tilt channel with no DMX address is set by hand from a Tilt field in Fixture settings, saved per fixture.
- Lenses that no channel tells apart are drawn as one light.

### GDTF Share

- Login, refresh and log out are on an account line under the fixture list in Add to Scene, visible without a search.
- The Share list is fetched again after 2 hours. Requests time out (30 s, downloads 120 s), and after a failure Beam waits 15 minutes before trying again.
- About shows Powered by GDTF, with the GDTF logo linked to GDTF Share.

### MadMapper and lasers

- MadMapper export writes a colour grid as a Matrix only when it is RGB, RGBW or CMY; MadMapper 6.1.7 crashes on other combinations. Other light islands go out as named 8-bit components.
- 8-bit colour components take their colour from the media; amber reads yellow and UV magenta.
- The Ponk receiver uses a 32 MB socket buffer, so dense outputs no longer drop frames.
- LaserCube Pro Wide Angle scans 80° and LaserCube Ultra Wide Angle 92.5°, as measured.

### Other

- The Studio view keeps the recording aspect when the editor view has a lens shift.
- Lists ignore presses on their scrollbar and scroll a row highlighted from elsewhere into view.

## 0.1.0-alpha.24

### People and colours

- 82 posed people ship in the object library: standing crowd poses, sitting poses and DJs, men and women, from Quaternius' Background Posed Humans (CC0).
- The **Colours** widget sets a tint and the colour of each part of a library model (top, trousers, shoes, skin, hair on a figure). **Vary** picks new colours; **vary pose** swaps a figure for another of the same type and gender. Colours are saved with the project and with structures.

### Placement and measuring

- Placement widget: **drop to ground** beside Position Z stands an item on the surface below it, or lifts it onto one it sits in. Each rotation field has a **turn 180°** button. The fields are laid out on a grid by axis.
- Measurements snapped to an item follow it when it is moved, turned or scaled, and are deleted with it. Copy, paste, duplicate and Save to Library carry measurements whose ends are all on the copied items.
- Every measurement has an angle. The Measure widget has an eye per measurement and toggles for length, angle and flipped angle labels.
- Move, rotate, scale and measure are one set of tools.
- **View filter** on the viewport toolbar: show or leave out objects, structures and each fixture type, and choose which measurements are drawn with the ruler off. Saved with the project.

### Viewport

- A navigation gizmo with X, Y and Z balls replaces the view cube. Click a ball to look along that axis, click again to look from the other side, drag to orbit.
- Contact shadows no longer stain the whole floor under a venue model that carries its own floor.
- A fixture deleted while selected no longer leaves its orange outline behind.

### LED bars

- The LED face shows its off-white dies when the bar is dark, and a red ring round pixel 1, so the start of each run is visible.
- LED faces seen from outside their beam angle dim gradually instead of going black.

### Projects and export

- Open Project and New Project ask to save unsaved changes first. Edits to objects, structures and groups now mark the project unsaved.
- **File → Open Recent** lists the last 8 projects opened or saved.
- MadMapper layout: **Squares** chooses **One per mapping**, where everything using a mapping shares one square at its place in the room, or **One per group or structure**, each fitted to its own square as before.

## 0.1.0-alpha.23

### Gobos and animation wheels

- 270 stock gobos at 256 px: small line-art gobos upscaled, metal gobos cleaned to black and white with smooth edges. They ship with the installer.
- Gobos are drawn from an atlas of 64 cells that loads images as fixtures need them and drops unused ones. Images are prepared in a background worker, so loading a rig no longer stalls the view.
- GDTF animation wheels and animation systems are drawn in beams and pools. 12 stock discs at 768 px ship with the installer.
- Glass animation discs draw a moving caustic web measured from the disc image: its size, stretch, direction and brightness. It moves with the disc's rotation and stops when the disc stops; part of it turns against the disc. Defocus washes it out. Metal discs are drawn as their image.
- Gobos and animation discs can be swapped per fixture, in a window opened from Fixture settings: stock images, images in your library, or an open slot. The swaps are saved with the project.
- Lens blur past the softest level fades a gobo or disc to its average brightness. Nearest focus is 2.5 m; a Focus(n)Distance channel sets the focus distance in metres.

### Beams

- Framing blades no longer draw copies of the cut beam inside it, except with a prism. Blade edges are at least as soft as the lens blur.
- A CTO or CTB channel linked to a filter is drawn as that filter.

### Export

- **Export** at the top of the patch bay writes a **MadMapper layout** or a **Patch sheet (PDF)**. Both cover the selection, or the whole scene when nothing is selected, and follow the selection while the dialog is open. File → Export Patch Sheet is gone.
- Patch sheet: each view on its own page, measurements on the page after the views, empty lists left out.
- Export Project suggests the project name with `_Export` added.

### Fixtures

- Tomshine 60W LED Mini Moving Head ships as GDTF. LaserCube GDTF files carry a thumbnail and channel names GDTF Share accepts. Elation Proteus Hybrid added as a test fixture.
- Fixture settings keep their scroll position per fixture model for the session.
- The placement widget follows gizmo drags with several items selected.
- The per-light shadow checkbox is removed. Removing an item from the library deletes its file.

## 0.1.0-alpha.22

### Lasers

- A laser's brightness comes from its watts, split over red, green and blue and turned into lumens at each colour's wavelength. A laser drawn from a GDTF file with a diode per colour uses each diode's watts and wavelength. Beams in air use the same haze scattering as mover beams: no haze, no beam.
- Equal red, green and blue in the content draw white: the stronger colours are held back as a real laser's colour balance does.
- A beam is drawn at its real width down to one pixel. A held dot is drawn as a continuous line, not beads.
- **Clip list** input: a laser plays built-in patterns and ILDA files (formats 0, 1, 2, 4 and 5) from Library/Lasers with nothing streamed. Each clip has its own point rate. The clip list window reorders, plays, adds files, saves the list as a card in Library/Lasers/Cards and exports it to an SD card as numbered files. Export Project packs the cards a project uses.
- Every laser has a **Test pattern** control that overrides its input, and **Mode** (As set, Standalone, Off) and **Clip** controls a console can drive.
- A hidden laser builds no beam or figure and offers no network input.
- The Wicked Lasers LaserCubes ship as GDTF files with their measured bodies: the Pro 2.5W is 100 × 145 × 100 mm, standing. The Ultra 7.5W and the Wide Angle models use measured optics, and a Wide Angle's beam starts at the lens glass.

### GDTF lasers

- A GDTF file is drawn as a laser when it has a laser channel (LaserCue, Scan_Rate, TestCue…), or names itself a laser and has a figure scale channel and no moving head. Most laser files on GDTF Share have no Laser geometry; these now draw as lasers with a box body.
- Channels read from the file: clip (cue, media content, gobo or object slot), page or folder, mode, test pattern, dimmer and its zone limit, X/Y size and its zone limit, zoom, X/Y position of the zone and of the cue (Pan/Tilt on a laser without a yoke), zone rotation, rotation, spin, scan rate and cue speed. A page and a cue make one clip number: (page − 1) × cues per page + cue.
- A channel's values come from the file: percentages or degrees named in its ranges, Min and Max, a range named Default, or the physical range. A channel whose ranges name choices, or that has several functions, is not read and stays adjustable by hand.
- The figure is placed as on the controller: the cue is turned, sized and moved within the zone, then the zone is turned, sized and moved within the scan field. Spin runs up to 360°/s, clockwise positive; Stop holds the angle and Reset puts the figure back.
- Scan rate and speed slow or quicken a playing clip from where it is.
- The DMX channel table names every channel of the file, and the quick guide no longer marks a laser's channels as having no effect.

### Patch sheet and measuring

- **File → Export Patch Sheet (PDF)**: one row per fixture grouped by universe, with mode, channels, Art-Net and sACN universe, addresses, position and mount; a fixture type summary; and views from above, front, back and both sides as hidden-line drawings with numbered fixtures. A dialog chooses notes, instructions, patch list, fixture types, measurements, unpatched fixtures, grid, mover arrows and paper size.
- **File → Project Details** holds author, version and notes, printed on the sheet.
- **Measure** tool: distance, angle and throw, snapping to vertices, fixture points, edges, faces and the floor. Shift on an axis locks it; Ctrl places a point without snapping. Measurements are saved with the project.
- Each save dialog opens in the folder that kind of file was last saved to.

### Structures

- Selecting a structure lists its members; highlighted members are edited together by the fixture widgets, with the patch bay's click, Ctrl, Shift and band selection. Alt-click on a member selects the structure with that member highlighted.
- Changing the selection no longer marks the project unsaved.

### Video inputs

- A projector or display showing an NDI input with no source on this machine shows a frame reading "No source for this input" instead of lighting white. The window and the manual call it a source.

### Haze and view

- Beams are dimmer looking towards the source and brighter side-on, and lose a quarter of the scattering per metre on their way.
- A lens face is lit only from inside its beam.
- The view is saved with its lens shift and orthographic mode.

### Fixes

- A fixture's DMX channel table is saved and loaded as it was left, for lasers, projectors and displays as for any fixture. A project no longer loads a device's DMX-driven values at zero.
- The DMX channel table no longer disappears in a full settings panel.
- Backspace no longer deletes; Delete does.
- Setting a DMX value by hand marks the project changed.
- Enter in a multi-line box no longer submits a popup.
- Import JSON Project is removed; it discarded what it loaded.

## 0.1.0-alpha.21

### LED fixtures

- LED bars and panels are drawn at their real luminance, worked out from the fixture's lumens. A definition can state **Lumens** in the create dialog; without it a strip LED counts as 4 lm (a WS2812B) and a tile as 1500 nits over its face. An LED smaller than a screen pixel is drawn about a pixel wide with its light kept. The glare comes from bloom. LEDs are dark from behind.
- LED bars and panels light the room. Each is a rectangle light the size of its face, coloured per point from its own pixels: a surface near the red end of a bar is lit red. No shadows yet.
- The LED debug sliders for gain, die size, halo strength, near dimming and back scatter no longer affect LED fixtures.

### Displays

- A display's light takes its colour from the part of the picture nearest each surface point, blurred with distance, instead of from the whole picture's average.
- **See-through** displays: a mesh screen with the LEDs on opaque strips along the rows and open space between them, in a frame with no back. **Transparency %** is the open share as quoted; 0 makes each strip as tall as its LEDs.

### Reflections

- Screen-space reflections trace a depth pyramid instead of a fixed march, so thin bars no longer break into dots in a reflection.
- The largest glossy flat surface is reflected as a mirror: the scene is drawn from below it, blurred by roughness and distance. Vertical glossy faces still use screen-space reflections.

### Fixtures

- Framing blades are drawn only when inserted. All blades at 0 no longer square the beam, and one inserted blade no longer draws all four.
- A gobo or colour wheel stops spinning when its channel leaves the spin range for a wheel mode or a range with no function.
- A lens face's brightness cap is 30 times higher, so an LED bar's lens and a discharge spot's no longer draw the same. Seen from behind, a lens face no longer glows.
- Full haze is 50 m visibility, was 10 m. A beam seen from across a large room no longer fades out while the floor behind it stays bright; beams seen over more than about 5 m are brighter than before.

### Interface

- **File → Save Project** sits under Open Project and saves without a dialog; **Save Project As…** opens the dialog on the current file.
- **View → Copy view to clipboard** copies the 3D view as a PNG, without the gizmo, view cube or timings.
- The channel range guide is always on; its preference is gone.

## 0.1.0-alpha.20

### Video inputs

- A project receives video through inputs: one NDI stream or one image or video file each. A display or projector picks an input and shows all of it; several can share one. Connectors and slicing are gone; send one NDI stream per output from the media server.
- **Create input…** at the bottom of a display's or projector's Input list, or Ctrl+Shift+I, opens the Video inputs window; the gear beside Input opens it on that device's input. It lists the inputs with their state and how many devices use each, and previews the selected one with its size and measured frame rate. It moved out of Preferences: inputs belong to the project. Senders are looked for again every few seconds while it is open. **Add NDI input** with a **Sender** chosen on this machine, or **Add file…**.
- A feed opens only while a device shows its input.
- Image and video files: PNG, JPEG, WebP, MP4, MOV or WebM, copied into `Library/Media`. A video plays muted and loops. A file belongs to the project: it is saved with it, Export carries it, and an opened export plays its own copy. An NDI sender stays a setting of the machine.
- A video file input has **Play**/**Pause**, a position slider and the time in the Video inputs window. Every device showing the file follows; pause and position are not saved.
- A **Test card** is built into every project: grey wedge, colour bars, a one-pixel grid, a circle and an F in one corner. It cannot be removed, and Export does not carry it, since Beam ships it.
- Displays and projectors have **Rotation**, **Mirror H** / **Mirror V**, **Crop** on each side in input pixels, **Scale** (Stretch, Fit, Fill, Native) and digital **Zoom**. Each is a control in the definition: Fixed, Adjustable or DMX. Fit shows a square video on a 16:9 screen with bars at the sides.
- Each projector shows its own input; up to six projectors draw at once, as before.
- A projected picture is read at the level of detail its size on the surface needs, so fine detail no longer breaks into moiré on a wall.
- A project saved with connectors opens with one input. A device on a whole-frame connector keeps its turn and mirrors; one on a smaller connector shows the whole picture and is listed once on opening.

### Preferences

- The default floor is a dark grey of about 10% reflectance, #595959, was #b9babb (about 49%). Existing projects keep their floor.
- The grid cancels the camera's exposure, so its lines look the same at any EV, and its lines are near white, #e6e9ed, was #7d858e.
- House lights up and down are set in lux on a white floor, to one decimal, on the same scale as projectors and fixtures. Defaults are 300 lux up and 6 lux down.
- Visualizer and Art-Net preferences are one window, **Edit → Preferences**, with a **Visualizer** and a **DMX** tab. A setting is one line with its explanation as a tooltip, and house up and house down share a row. **Reset all...** is at the bottom of the window. Ctrl+Shift+V opens the Visualizer tab, Ctrl+Shift+A the DMX tab.
- **Debug → Camera** has **house up EV** and **house down EV** sliders, the same stored preferences as the window.
- Each house state has its own camera exposure, **Exposure, house up (EV)** and **Exposure, house down (EV)**, defaults 7 and 6.5. A lit room at 300 lux and a dark show both read correctly. Each environment image is measured once, so a lux figure means the same light whichever image is chosen. Earlier percentages are not carried over.

### Reflections

- Glossy surfaces reflect what is on screen (screen-space reflections), on any surface: a floor, a deck, steps, a metal object. The reflection is blurred by the surface's roughness and the distance to what it reflects, and replaces the environment image's share of the reflection where something is found. Lens faces are reflected; beams in the air are not. **Preferences → Visualizer → Reflections**, on by default. While it is on, displays no longer add their rectangle highlight, since their picture is reflected.
- Regression set: a reflect scene, a glossy slab with the test card on a display, a grey cube and a head pointed down at it.

### View

- A **View** menu: **Full window** (F10) shows only the 3D view and its toolbar, also from a button at the right of that toolbar. **Full screen** (F11) is full window across the monitor, with the toolbar shown while the pointer is at the top edge; Escape leaves it before deselecting. **Stay on top** keeps the window above other applications and is remembered; the other two start off.

### Projectors

- The camera's exposure is an EV at ISO 100: a luminance of 1.2 x 2^EV cd/m² reaches the top of the tone curve. EV 5.25 is the old exposure of 1.0. The exposure multiplier in Debug → Camera is gone; exposure is set per house state in Preferences.
- Surfaces are lit in luminance: a matte surface under E lux has luminance reflectance x E / pi. Projected light and the house light now include the pi, as mover pools already did; at the same lux both are a factor of pi darker than before.
- Projected light is multiplied by the colour of the surface it lands on. A grey #808080 wall returns about 22% of what a white one does; before, every surface returned all of it.
- The generic projector defaults to 4000 lumens, was 10000.
- A projector's black level is its white over its contrast, across the frame; the soft edge dims only the picture above it, so blended overlaps show a brighter black.
- A display's full white is its nits. It used to be a fixed level of about 45 nits whatever the definition said.
- Displays light the room: an area light at the picture's average colour, which falls as 1 / (d² + R²) for a disc of the panel's area, with soft shadows from a depth tile. Up to 16 displays; one costs about 0.2 ms of GPU time. On standard materials a display is a rectangle (linearly transformed cosines), so a glossy floor reflects its shape, at the picture's average colour, rather than a point.
- A projector's light in the haze is sampled only where the frame holds picture. A cropped, fitted or zoomed-out picture no longer breaks into bands in the air.
- Changing a device value in Fixture settings marks the project as changed. Crop, zoom, shift and the other controls were lost on closing without a prompt.
- The Edit menu has Copy, Paste and Preferences. The Preferences menu is gone.
- Changing a model's size, in Placement or with the gizmo, keeps its lowest point where it was, so a model on the floor no longer grows into it.
- Framing blades from GDTF shaper channels: Blade(n)A and B, Blade(n)Rot and ShaperRot cut the pool and the beam alike. Up to eight blades per light; a blade with only A moves parallel. Seen in the Ayrton Diablo, Martin MAC Encore and Viper Performance, and Robe BMFL Blade profiles.
- The toolbar no longer has Auto-rotate, Auto-focus, the Visualizer title or Hide. The performance panel no longer shows the camera position.
- With Native scale a crop only blacks out the edges; the kept pixels stay in place. With Stretch, Fit and Fill the kept part is scaled to the picture.
- A projector's position is on its lens axis. A projector whose lens is off-centre keeps its position: its body moves by the lens offset and its picture is now centred on the position.

### Names

- A `.beam` file is a **project** and what it holds is the **scene**: the show is what MadMapper or Resolume plays. **Add to show** is **Add to scene**, **Import Showfile** is **Import JSON Project**, and messages and the manual say project.

### Development

- Regression set: a display scene, 40 nits showing the test card. The projector shows the test card at a dimmer of 70 on a grey screen, so its white sits below clipping; the laser draws a triangle with a red, a green and a blue side. The room uses house lights down at 2 lux.

## 0.1.0-alpha.19

### Viewport

- **Orthographic** on the toolbar swaps the camera for a plan or elevation view with no vanishing point. The view keeps its direction and target. The wheel scales the view about the cursor; Shift + right-drag turns about the target. Studio and recording stay perspective and switch back.
- Right-drag orbits about the point under the pointer, which stays under the pointer. Middle-drag is a lens shift: the picture slides and the camera does not move. Ctrl + middle-drag walks the camera along the floor with the grabbed spot staying under the pointer. The wheel moves toward the point under the cursor.
- The view cube is smaller, pinned to the viewport's corner, and is never recorded.
- Escape deselects and leaves the view where it is.
- Toolbar buttons sit closer together.

### 3D models

- A model from a file has Length (X), Width (Y) and Height (Z) in metres in the Placement widget, along the model's own axes, with its original size beneath. The show saves all three. Fixtures and created shapes do not scale.
- Scale tool (**S**, and a toolbar button) for one model at a time. The centre handle scales all three axes.
- Models compressed with Draco load. The decoder was missing from the build.
- The three shipped floors have thumbnails.

### Moving heads

- Focus is the distance the lens is focused at: the focus channel runs from 1 m to infinity, and a lens without one has **Focus at (m)** in its settings, default 5 m. The beam narrows from the lens to the image at the focus and widens past it; the pool's edge and the gobo are sharp at the focus and blur away from it.
- The beam's edge comes from the fixture's beam and field angles: the field angle is the edge, the beam angle sets how soft. A file stating the two equal draws a hard edge. A profile with one angle keeps the default edge. Two corpus files change width (B-EYE K20, Cuepix Blinder).
- A beam's soft edge stops at walls. A short focus or a big lens spread the edge past the depth tile and that fringe went through every surface.
- Pool shadows are soft by the lens's size: sharp where they meet what casts them, wider away from it.
- In haze, the air and the pool fade together with distance from the lens, and what the haze scatters out of the beam comes back as a glow around it. **Debug → Mover beam → scattered glow** compares with and without.
- A beam's edge is one continuous ramp; the samples along the ray no longer draw the edge twice near the focus.
- A strobing light stops at surfaces between flashes. It lit through walls on the frame after a flash.
- A light moved down a slot by a deletion kept the colour, angle, focus, gobos, prism and iris of the light that had been there. Fixed.
- A GDTF fixture drawn with the shipped body takes its lens size from the file.
- Gobo wheels turn: 44.5 degrees a slot, with an overshoot that settles. A shake rocks the whole wheel.
- GDTF: channel names use the attribute's pretty name; pan/tilt speed channels drive the head; DMX profiles are applied; a gobo shake's amplitude sets its swing; gobo thumbnails are drawn without a white backing.
- GDTF fixtures export to MadMapper by name. Every channel was named "[object Object]" and only the Pan/Tilt island was placed.

### DMX

- **Preferences → Art-Net → Mode** is Off, Receive or Send. Send puts the fixtures' own values on the wire as sACN multicast or Art-Net, to test real fixtures with the same controls. Every launch starts in Receive.

### Lasers

- A laser on the default address found no stream and drew nothing while points arrived. Fixed: the renderer kept overwriting the address the device was bound to.
- A stream delivering under a quarter of its declared point rate counts as stopped and the beam goes out. A host with nothing left to send kept a beam lit with a trickle.

### Selection

- A selected object shows the orange outline; a selected structure or group passes it to its members. The outline covers the whole silhouette, hidden parts included.

### Debug panel

- Double-click a control's name to put it back to its default. **Reset all** at the top does every control. The old button that cleared every preference is gone from the panel; it stays under **Preferences → Reset to defaults**.
- Camera folder: exposure, tone curve, glare strength and spread. Nothing is stored.
- Regrouped: Camera, Room (Light, Haze), LED (Die, Distance, Glow), Mover beam, Laser (Brightness, Shape, Diagnostics).
- The panel sits in the viewport's top-right corner, grows downwards as folders open and scrolls past the viewport's bottom. Which folders are open is remembered.
- Removed: Bloom, Scene haze (the same settings as Preferences → Visualizer), contour cycling and render passes.
- **Strict patch** moves to **Preferences → Art-Net**. A stored setting carries over.

### Fixes

- LED panels and bars drew only their glow after the orthographic change. Fixed.
- axios is replaced by fetch. It carried twenty-odd advisories, and its current version refuses the scheme a packaged build loads fixtures over.

### Development

- CLAUDE.md maps the code and the rules for working in it; tools/dev launches, probes, screenshots and times the dev build.
- Visual regression set: test scenes at four haze levels with a frozen clock, diffed against a stored set.
- Contributors: PolarAudio for the Draco decoder, the floor thumbnails and the laser stream fixes.

## 0.1.0-alpha.18

### GDTF fixtures

- Beam reads GDTF fixture files. **File → Import GDTF...** or dropping a .gdtf on the window copies it into `Library/Profiles/<manufacturer>/`, unchanged. A GDTF fixture replaces the OFL entry of the same name in Add to Show. Exports carry the file as it is.
- OFL profiles are translated to GDTF internally, so both kinds drive moving heads through the same DMX engine. 16-bit channels are read in full, and mode masters are honoured.
- Moving heads are built from the file's own meshes when it has them: base, yoke and head, placed where the file puts them. A file without meshes gets the shipped body at the file's height. GDTF primitives (base, yoke, head, conventional, scanner) are drawn as shapes of the model's size.
- Gobos use the file's own wheel images. Colour wheel slots use the filter's colour and transmission from the file.
- Speeds between named points (such as a gobo rotation that names its fast and slow ends) follow the line between those points.
- Pan/tilt speed overrides are removed; GDTF heads take their speed from the file.
- The range guide covers GDTF fixtures and shows each gobo slot's own image.

### Static lights

- A GDTF fixture that neither pans nor tilts is a static light: a par, a wash, a bar, a blinder. It is listed as **Static** and drawn standing still.
- A light with several lenses gives each lens its own beam and its share of the output. A mode that addresses the lenses separately lights each one on its own.
- A beam the file types None or Glow lights its face without throwing a beam into the haze.
- A lens face is drawn in the shape and size the file gives it: a rectangle for a box-shaped lens, a disc for a round one. It sits on the outside of the lens, where the light leaves.
- A light whose mode has colour channels but no dimmer runs at full, its colour channels the only control.
- A light with red, green and blue at zero is dark. It showed white.

### Brightness

- Moving head brightness follows from the fixture's lumens, with no gains set by eye. Zoom, frost and focus keep the total output.
- Beams in haze are computed from the haze's scattering along the ray. 100% haze is 10 m visibility.
- The light leaves at the lens. A thin fixture no longer lights its own back or shows its beam through its body.

### GDTF Share

- Searching in Add to Show lists your library first, then the fixtures on GDTF Share that your library does not have. Picking one fills the form from the Share; **download and add** downloads, imports and places it.
- Log in, refresh and log out from the panel beside the form. The account is stored encrypted by Windows and is never shown.
- A fixture type already in the library is asked about: keep both (default), replace, or skip. Saved shows keep the revision they were built with.
- **Newer on GDTF Share** marks a library file with a newer revision available.

### Add to Show

- Double-clicking an item in the item list opens Add to Show on its library entry: a fixture in its mode, an object, or a structure.
- Any library fixture or Share fixture can be marked as a favourite or as bad, with the heart and thumbs-down buttons in the panel above the form.
- The bad and favourite filters on the search line each have three states: all, only marked, not marked.
- The funnel button filters by type (moving head, static, matrix, LED bar, laser, strobe, projector) and by origin (GDTF, OFL, Generic), with counts.
- Every fixture row shows its origin in a column: GDTF, OFL or Generic.
- Removing a GDTF file from the library moves it to `Library/Removed/Profiles` instead of deleting it. Shows that use it still open. Importing it again lists it again. Replacing a file on import moves the old one there too.
- New icons for static lights, lasers and strobes. A fixture shows the same icon in the item list, the fixture panel and Add to Show.

### Selection

- A selected fixture is drawn as it is, with an orange outline. The white tint and the corner brackets are gone.
- The move and rotate gizmo is drawn on top of the picture, unaffected by light, haze and bloom, and is left out of recordings.

### Fixture panel

- Values a GDTF file left at the format's defaults are left out, when most of a beam's values are defaults.
- Selecting a light whose file gives it nothing to draw no longer breaks the scene.

### Fixes

- A dimmer change while the shutter was closed no longer lights the head for one frame.
- Changing mode resets the head's optics; a gobo or shake from the previous mode no longer stays in.
- Patching in a mode other than the first no longer patches the first mode.

## 0.1.0-alpha.17

### Brightness

- Recalibrated by eye at 50% haze: beam gain 0.5 (was 0.085), facing brightness 37% (was 11%), pool falloff 1.55 (was 2). Pool gain stays 0.01. At alpha.16's values, beams from low-output heads such as the Tomshine 80W were nearly invisible.
- The beam gain slider under **Debug → Mover beam** goes up to 2.
- Haze defaults: turbulence 33% (was 70%), scale 10 m (was 4 m). Density stays 50%.

### Preferences

- **Preferences → Reset to defaults** clears every stored preference and debug tuning value and reloads Beam. It asks first, and warns when the show has unsaved changes. The debug panel has the same button at the top.

## 0.1.0-alpha.16

### Brightness

- Pools from moving heads and strobes are on the projector's lux scale and fall off with the square of the distance. They fell off linearly before, which made long throws too bright.
- Calibration set by eye: pool gain 0.01, beam gain 0.085, facing brightness 11%. The values are under **Debug → Mover beam** for checking and are not stored.
- Bloom: lower strength (0.7–2.1 with haze), narrower spread (0.3–0.5) and a higher threshold (0.6–0.4). Bright pools no longer fill the dark between a gobo's bars or veil the frame.

### Beams

- Samples along a beam are spaced by the light, close together near the lens and further apart far out. A ray running down a beam no longer shows a bright curved sheet that jumps as the view moves.
- A side-on beam past the knee fades as 1/distance, so long throws stay visible to the floor.
- Gobos in the air are averaged along the ray and stay sharp across it, using anisotropic filtering. Gobo sheets in haze show as sheets instead of being blurred into their neighbours. Distance blur is a quarter of what it was.

### Fixture panel

- **Model** shows make, model, lumens and power for every fixture. For a moving head the lumens are the figure it is lit from, and an estimate from the power says so.
- **Specifications** (collapsed) lists lamp, colour temperature, zoom range, weight, size, connector, categories and modes, and for a moving head the peak candela at the narrowest and widest zoom.

### Manual

- Moving head beams: pools and specifications.

## 0.1.0-alpha.15

### Patch bay

- The **Patch Bay** title is gone. **export** joins structure and arrange as a button that acts on the selection, and **add** is a plain plus at the end of the row.
- Rows can be dragged into a new order, and a line shows where they will land. Dragging a selected row moves the whole selection in its current order. The order is saved with the show.
- A group member dropped between rows leaves its group.
- Band selection: press in the margin beside or below the rows and drag. Ctrl or Shift adds to the highlight. The list scrolls while the pointer is held past its edge.
- Shift-click selects a range and Ctrl-click adds or removes one row.
- Selected rows use a darker teal with white text.
- Fixture rows show the address in the chosen notation, or **unpatched**.

### Hiding items

- Each row has a hide toggle. A hidden fixture, object, structure or group is not drawn, gives no light, casts nothing and cannot be picked in the 3D view. Its row is dimmed.
- Hiding is saved with the show. DMX still arrives, so a hidden item shows its current state when it is shown again.
- Using the toggle on one of several highlighted rows hides or shows all of them.
- Hiding a structure or group hides its members. Members taken out of a hidden structure stay hidden.
- Orbit pivot, framing and box select ignore hidden items.

### Names

- A fixture, object, structure or group has a name and a separate instance number. The number is the lowest one not already used by another item of the same kind with the same name.
- The list shows the number only when another item of that kind has the same name. Exports always use the name with its number.
- Renaming gives the item the lowest free number under its new name. Renaming `Truss 3` to `Stage` makes `Stage 1`.
- Shows saved before this change have their numbers split from their names where the name is the profile's name followed by a number.

### Addresses

- **Art-Net settings → Addresses** sets how addresses are written: **Universe.Channel (2.37)**, **Universe:Channel (2:37)** or **Absolute (1061)**. Universes count from 0. The default is Universe.Channel.

### Fixture panel

- Selecting several fixtures of the same profile opens one settings panel for all of them. A field whose values differ shows `*`, and anything set is written to every fixture. Name and address are still set one fixture at a time.
- Checkboxes show a dash when the selected fixtures differ.
- **Copy** with several fixtures selected copies each fixture's channel sheet, with its name.
- The channel table has a **#** column (the fixture's own channel number). Long names and range text are cut off with the full text in a tooltip. The panel is 340 px wide.
- A channel without a device control shows the name of the range its value is in, taken from the profile.
- Channel range guide: while a DMX value changes, the channel's ranges are shown beside it as cards. Colour slots show their colours, a slot between two colours shows both, and gobo slots show the gobo image the beam draws.
- Clicking the value keeps the guide open. Click a slot to set it, or press and slide on a range. Dragging, the scroll wheel and the arrow keys step through ranges and slots, and every range gets enough travel to land on. **Visualizer settings → Channel range guide** turns it off.
- The quick guide describes pan/tilt speed and frost ranges. Beam now draws them, so they are no longer marked as not drawn.

### Arrange

- **Positions: Replace / Add**. Add offsets each item from where it stands, with the offsets centred so the set does not drift. Use it to stack layouts: a circle then a vertical line gives a helix. Add turns on **Keep heading**.
- The panel opens on the order of the last Apply and warns when an Add pass uses a different one.
- Circle: **End radius**. Setting it different from **Radius** makes a spiral: the radius steps per fixture and the last fixture lands on the end radius. It follows Radius while the two are equal.

### Moving heads

- Brightness comes from the profile's lumens over its stated beam angle. `bulb.lumens` is used if it works out to 5–150 lm/W against the stated power. Otherwise power × 22 lm/W is used, and without either the old 20,000 lm reference. Most heads are dimmer (median about 0.09×) and narrow-beam fixtures are brighter.
- Zoom concentrates the light instead of keeping the same brightness: from 50° to 4° is about 150× brighter. The widest zoom is the reference.
- A zoom channel runs from the lens's narrowest to its widest angle. Zoom stated in degrees is taken as degrees.
- Frost: a frost channel, a frost slot on a wheel, or a frost effect (ramp up, ramp down, pulse, random). Full frost widens the beam by half, softens the edge fully and blurs the gobo until only its average light is left.
- Pan/tilt speed channels work. A speed is a percent of the head's top speed, down to 2%. A duration is how long every move takes, from 0 to 30 s, with pan and tilt arriving together and never faster than the top speed.
- A profile can mark its lens as focused by hand (`physical.lens.focus: "manual"`). Each placement then has a **Focus %** setting, default 50, saved with the show.
- Tomshine 80W LED gobo moving head: 1750 lm (an estimate from its listed 2400 lux at 5 m), hand focus.

### Objects

- **import object** copies a GLB, OBJ, FBX or STL file into the object library, along with an OBJ's material library and textures. The dialog asks for **Units** (metres, centimetres, millimetres, inches, feet) and **Up axis**, and shows the model's size in metres. Files that could not be brought along are listed. Cancel removes the copy.
- OBJ, FBX and STL files placed in the library by hand also load. OBJ and FBX materials are converted to the standard material, and a mesh with several materials keeps one per face group. An STL with no colours is grey. Morph targets are dropped.
- New shape: **Tube**, with **Outer radius**, **Wall** and **Height**. Cylinders and tubes have an **Arc** angle from 1° to 360°. A partial arc is closed with end faces.
- A library object has its own **Name** and **Scale** per placement. The model file is not changed.
- Structures can hold objects as well as fixtures. Saved structures, placed structures and pasted structures keep their objects.
- New shipped objects in `assorted`: a big and a small gravestone.

### Display panels

- **Pixel (mm)** is replaced by **Fill factor**: **Auto**, which picks the LED package usually used at this pitch, **Manual** (a percentage), or a package from SMD 0808 to SMD 5050. The fill is stored as a share of the pitch, so resizing a panel keeps the emitter in proportion.
- Pitch is shown for both axes when the cells are not square.
- A panel whose emitter is smaller than LED walls use gets an **Unusual** warning in the creator and in **Model**.
- Small emitters are drawn brighter so the panel's average brightness matches its picture. A coarse-pitch wall of small emitters is no longer nearly black.
- An emitter narrower than 2.5 screen pixels is drawn at that width with lower gain, instead of smearing into a bright line per row and column.

### Projectors and haze

- Projector shafts are sampled the way mover beams are: 8 fixed samples along each projector's lit stretch, with no dither grain. A shaft starts at the lens, brightens as it faces the camera (**Mover beam → facing brightness %**), and has a harder frame edge.
- The room's haze uses blue noise that changes every frame instead of a 4×4 pattern, which showed as a fine grid on dark air. The haze turns with the beams' heading sweep instead of sliding along one axis.

### Export

- **File → Export MadMapper Layout** moved to the patch bay **export** button, which opens **Export selection** with an **Application** choice (MadMapper). It exports the selected fixtures, and structures and groups with their members. Hidden items are included.
- A single exported item names the file. The save dialog asks every time.

### Projects

- Saving an opened export writes only the profiles and objects the show uses. Items added since are collected from the library.
- **File → Refresh from Library** replaces the profiles and objects an exported project carries with the library's copies. The show reloads and is left unsaved. Items the library does not have keep their carried copy.

### Studio

- Fly time is saved with the show.
- Cutting or flying to the live camera returns the view to that camera's framing.
- Frame size, frame rate, quality and desktop audio are remembered between sessions.
- A 4K take at 30 fps encodes every frame. It managed 10 fps before.
- 4K above 30 fps records with the hardware encoder.
- When no hardware encoder takes the size and rate, the take falls back to software, and the recording widget says so for the whole take.
- Frames waiting on the encoder are capped at 2 GB. Past that, frames are dropped instead of the WebGL context being lost.
- A finished take reports frames recorded out of total, split into dropped (encoder behind) and held (scene too slow).

### Performance

- Beam asks for the discrete GPU. The Windows installer sets Beam's graphics preference to High performance and removes it on uninstall.
- The debug overlay shows which graphics adapter is drawing.

### Fixtures

- BeamZ LCB144 MKII, 8 sections.
- Shehds LED Flat Par 7x18W RGBWA+UV.

### Interface

- Dialogs are never taller than the window: the body scrolls and the header and buttons stay in place.
- The display creator keeps every field in place when warnings and summaries change.
- Scrollbars are full width.
- Pressing Enter in a number field commits the value and leaves the field.
- **Grid opacity** steps by 0.05.

### Manual

- New section: Arranging a selection. Moving head beams describes where brightness comes from.

### Fixes

- A strobe range that states no flash length no longer ramps the flash up to 1000 ms with the rate. The lamp went solid a third of the way up.
- A mover's flash covering half a frame was drawn at a quarter brightness instead of half.
- Raising a strobe rate takes effect from the last flash instead of waiting out the old gap.
- A zoom at 0 was a beam of no width.
- A low pool at a grazing angle on the floor is no longer cut into stair steps.
- A rotation such as Y 100 no longer shows as X 180, Y 80, Z 180. Editing one of those fields turned the item somewhere else.
- Rotation fields keep tenths of a degree. Typed decimals were rounded away.
- A structure or group made from a selection no longer moves every member when the gizmo is first let go.
- A number field could take the focus back on every click elsewhere after two quick presses.
- The patch bay buttons dropped to icons as soon as the column was narrowed, even with room left.

## 0.1.0-alpha.14

### Gobos

- The 46 gobo images from the Open Fixture Library replace the procedural patterns. A slot that names an image gets it; other slots get images by order. Credited in CREDITS.html.
- A wheel travels between slots at 7.5 slots per second instead of switching instantly, in the air and on the pool.
- Gobo shake, as a rocking wheel or a gobo turning in its holder, at the profile's angle where it states one.

### Colour wheels

- Colour slots take their colour from the slot's name, including gel names such as congo, lavender and minus green.
- A colour wheel set between two slots shows both colours, split across the beam.

### Prisms and iris

- A prism's facet count and whether it is linear come from the profile's text; three round facets when it says nothing.
- A linear prism lays its copies in a row along its angle.
- A prism costs 12% of the light.
- The iris channel closes the beam, in the air and on the pool.

### Fixture panel

- **Model** has a quick guide written from the profile: what to set before there is light, and what each channel's DMX ranges do. Channels Beam does not draw are marked.

### Fixes

- A fixture rotated 180° about Y no longer snaps to X 180°, Z 180° when the field loses focus.
- Changing the prism no longer clips the projected gobo until the view moves. A still head no longer re-uploads its matrices every frame, and a depth view that waits for its turn gains priority each frame.

## 0.1.0-alpha.13

### Moving head beams

- The beam is computed per view ray. Rays from inside the beam and looking down it are handled.
- The air uses the same falloff as the pool on the floor: full to an inner cone, soft to nothing at the stated angle.
- Focus sets the edge over its own range, nearly hard to soft. Fixtures without a focus channel default to a penumbra of 0.5, so overlapping pools no longer show dark curves.
- Beams are brighter facing the camera, from the haze's forward scattering. Debug panel: **Mover beam → facing brightness %**.
- Light falls off with distance from the lens and is absorbed by the haze. Dense haze shortens beams.
- The haze texture is sampled inside the beam, not on its surface.
- Beams stop at the first surface their lens sees, from a depth view per lit head. At most four views are redrawn per frame, most visible first. Debug panel: **Mover beam → stop at surfaces**.
- The pool on surfaces reads the same depth view, so objects cast shadows and walls stop the pool.
- Debug panel: **Mover beam → draw term** shows one shader term as greyscale.

### Gobos and prisms

- Every wheel in a profile is used: gobo slot, slot rotation, wheel scroll, prism and prism rotation.
- Twelve procedural gobo patterns. Seven match the OFL resource names in the shipped profiles; other slots get patterns by order.
- Focus blurs the gobo, blended between three baked blur levels.
- The gobo lines up between the air and the pool. In the air it blurs with distance.
- A prism draws copies of the whole cross-section; overlapping copies add.
- Rotation speeds map a profile's slow to fast onto a range per fixture.

### Objects

- Three 4290 truss models: a straight 2 m section and two arcs.

### Fixes

- A DMX range of a single value no longer produces NaN. A stated value of zero counts as a value.
- Rotation capabilities report only the speed or angle the profile states.
- A prism rotation channel no longer switches the prism on.

## 0.1.0-alpha.12

### Strobe

- New generic fixture kind: **Strobe**.
- Source: xenon or LED. Colour: white, RGB, or gel scroller with an editable gel string.
- Parameters: rated power, white colour temperature, flood angle H/V, rate range, flash length range, body and face size.
- Channels: Dimmer, Rate (Hz), Duration (ms), Strobe Mode, Red/Green/Blue or Gel, Blinder, Flash.
- Brightness follows rated power: each flash carries power divided by rate.
- A scroller position between two frames shows both gels, half the face each.
- Flashes are counted per video frame. A recording keeps every flash at any frame rate.

### Recording

- Files are standard MP4, H.264 video and AAC audio, constant frame rate. Accepted by WhatsApp, Facebook and phones.
- Encoding uses WebCodecs with the hardware encoder when available. Muxing by Mediabunny.
- A progress bar shows frames encoded of frames captured while a take is finished.

### Generic fixtures

- A generic fixture is created under a working name and lives in the show.
- **Save to library** in the Model widget asks for manufacturer and model. Manufacturer is a filter-as-you-type list, default **Generic**.
- A device control is one value, written by hand or by the wire. Nothing is greyed out.
- Fixture Settings has a **DMX Channels** table: address, channel name, DMX byte, value in units. Refreshes 10 times a second while driven. **Copy** puts the table on the clipboard.
- The Model widget keeps a channel map for LED bars only.
- Channel names come from the profile. Strobe controls use trade names.

### Library references

- An item that references a library entry shows a link badge on its icon, in the item list and in the Model widget header. Shipped and saved profiles and `.glb` models are library references. Definitions carried in the show have no badge.

### Fixes

- Moving head beams start at the scaled lens.
- The body font is set once at the app root. No widget falls back to serif.
- A combo box list is no longer clipped by the popup it sits in.

## 0.1.0-alpha.11

Laser and projector beams stopped in mid-air whenever a moving head in the show cast a shadow. Fixed. Also in this release: Export Project to… packs every profile and model a show uses into the `.beam` file, the DMX patch can be run without the overlap rules, moving head bodies take their size from the profile, and new fixtures for Tomshine and Wicked Lasers.

### Beams cut in mid-air

- **The cause.** Each laser and projector keeps a depth view of the scene in one tile of a shared atlas, and a beam ends where that tile says the first surface is. With a shadow-casting light in the scene, three.js runs its shadow-map pass inside every render call and restores the render target afterwards — with the target's own full-size viewport and no scissor. The tile bounds set for the pass were gone by the time the scene was drawn, so every tile covered the whole atlas, each fixture overwrote the others, and a laser read a corner of the last view drawn. That corner held whatever stood near the last fixture, at about a metre, which is where the beams stopped. No floor or room needed.
- **The fix.** Tile bounds now live on the render target itself, so anything that restores the target restores the tile. Shadow maps are not updated during the depth pass at all; an override material never reads them, and they were being redrawn once per tile. Pinned in the depth atlas test with a fake renderer that behaves like the real one.
- **Debug panel, Laser folder.** **Stop at surfaces** turns occlusion off for the session. **Log depth tiles** writes each laser's depth view to the console as a grid of metres plus an image, with the depth camera's position and aim. Neither is saved.

### Export Project to…

- **What a save is, and what an export is.** A save names profiles and models and leaves them in the library, so an edit to a profile reaches every project that uses it. **Export Project to…** (Ctrl+Shift+S, replacing Save As) freezes the project: every referenced profile, override and model — shipped ones included — is copied into the `.beam` zip under `Library/Profiles`, `Library/Overrides` and `Library/Objects`, the same layout as the user's library. `.gltf` companions and thumbnails go too. `.glb` files are self-contained.
- **Opening an export mounts it.** The packed library is unpacked to a per-file cache and consulted ahead of the user library and the shipped one while the document is open. The cache is cleared on close and at app start. Saving a mounted export keeps it an export.
- **Errors are named.** A write failure or a referenced item that could not be found is reported with the item's name rather than silently skipped.

### DMX patch

- **Strict patch can be turned off** in the debug panel. Off, any address is accepted as typed, overlaps are allowed, and a new or pasted fixture keeps the address it was given instead of moving to the first free one. Loading a show always places fixtures where the file says, since one refused overlap would leave the rest of the rig unpatched.

### Moving heads

- **Bodies scale to the profile.** The body's height comes from the profile's physical dimensions, and the model is scaled to match, clamped between 0.2 and 3 times the shipped model so a mistyped dimension can't produce a head the size of a truck. Yoke, head, lens and selection box scale together and the base stays on the floor. The beam is not scaled; its geometry comes from the profile's beam angle.
- **The lens shows the beam colour.** Dark glass when the head is off, the beam colour at full intensity, mixed in between.
- **Pan and tilt speed overrides** now come from `panSpeed` and `tiltSpeed` keys in the profile.

### Fixtures

- **Tomshine 80W LED Gobo Moving Head**, converted from the QLC+ definition.
- **Wicked Lasers LaserCube** 2.5W, 2.5W Wide Angle, 7.5W Ultra and 7.5W Ultra Wide Angle, each with power, scan angles, divergence and maximum point rate.

## 0.1.0-alpha.10

Laser support. Beam now shows up on the network as a laser device, takes the point stream MadMapper already outputs, and renders both the beams in the air and the figure where it lands on geometry. Each laser has its own protocol/address settings and a status line that says what it's receiving. Also in this release: manual channel values on any fixture, Alt+click to select inside a structure, and a haze rework.

### Lasers

- **Laser fixtures.** A laser fixture in Beam is a projector without the laser. Something else (MadMapper) draws the picture; Beam receives the points and renders the air beams plus the projected graphics on geometry. Nothing to install on the sending side — Beam advertises itself as hardware MadMapper already recognises.
- **Air beams are geometry.** Consecutive lit points sweep a triangle out from the aperture, so a scanned line is one continuous sheet rather than a row of separate blades. There's a jump guard so blanked travel between figures isn't bridged, and standalone points get a billboarded ribbon. Beams fade out over their last stretch instead of stopping abruptly.
- **Projected graphics.** Each laser rasterises its stream into a tile of a shared atlas. A full-screen pass projects it onto whatever the camera sees, depth-gated so it can't paint through walls. Stroke placement comes from pushing the beams' far points through the same matrix the pass uses, so the curve and handedness come out right automatically.
- **Three input protocols: Ponk, IDN and Ether Dream.** Ponk is the default and the one that scales — MadMapper names its outputs, so Beam maps each output to a laser. IDN and Ether Dream run at real point rates but support one laser per IP address: MadMapper doesn't send an IDN service ID, and Ether Dream identifies devices by address only.
- **Frame thinning.** Ponk's point density depends on the material — a circle arrives roughly 8× denser than a line, and one ring measured 8,146 points per frame. Cutting at a fixed capacity kept the first materials intact and dropped the last ones entirely. The thinning step is now derived from the frame's total length against the budget, floored at about one canvas pixel, so dense frames get slightly coarser everywhere and every path survives.
- **Dwell modelling.** Since Ponk sits upstream of the rasteriser, the point budget is distributed across the frame's paths by length, with dots taken off the top and MINIPNTS/SNGLPTIN honoured. Brightness now tracks how long the scanner would actually rest at a point rather than how many points happened to be sent.

### Laser setup

- **Protocol and address are per fixture.** A real laser has its own DAC, so its input settings live on the fixture.
- **Address clashes are refused.** Exclusivity comes from sharing an address, not from the protocol, so the address is a field rather than an assumption. Two Ether Dreams work if the second gets a second IP. A clash is rejected with the name of the laser that already holds the address.
- **Devices must own their ports.** A `reuseAddr` bind would succeed on a port another program already held, so a device could report itself as listening and receive nothing. Every device now probes without `reuseAddr` before binding and refuses to start if it can't own the port, naming the port. (This is what MadMapper holding the LaserCube command port looked like from the inside.)
- **Per-laser status line.** Distinguishes nothing connected / connected but no points for this laser / receiving. Also reports when a host is streaming to a laser it never armed, which otherwise looks healthy and draws nothing.
- **Device identity derived from address.** Hosts identify devices by what they advertise, not where they answer from, so two devices built from defaults appeared as one device seen twice. Fixed.
- **LaserCube removed from the dropdown.** Code kept. Its host binds the device's well-known ports, so a host and an emulated cube on one machine want the same UDP port. No address setting fixes that. Shows already set to it still display it.
- **IDN service ID proposal.** The case for MadMapper sending an IDN service ID is in `docs/madmapper-idn-service-map.md`, with a reference producer showing Beam's side already works: two named lasers through one unit at one address.

### Manual channel values

- **Every fixture's channels are listed in its settings with a number field each.** Place a light, aim it, open the shutter and see it — no patching, no console. This reverses an early project decision.
- **Manual values hold until DMX arrives; then DMX wins.** An unpatched fixture keeps its manual values permanently and numbers rows from 1, since it has no address to offset from.
- **Only touched channels are saved.** Unset channels stay absent rather than writing a zero over the profile default, and live DMX values never get saved into the show.

### Haze

- **Motion rework.** All four octaves drifted along the same axis at different speeds, which read as a flat sheet sliding past. Each octave now has its own direction and axis order, and directions sweep over time, so the displacement is a curve rather than a line with a wobble.
- **More turbulence range**, and turbulence now means the same speed regardless of haze scale. Previously the same setting behaved differently at different scales.
- **Swirl and heading sweep are now controls** in the debug panel's Room tuning. They were `#define`s that needed a source edit and restart.

### Selection

- **Alt+click selects inside a structure.** Hits on a member used to resolve up to the structure, so a fixture inside a truss couldn't be selected in the 3D view at all, which made its channel list harder to reach. Alt is the only modifier left; shift, ctrl and cmd all extend selection.
- **Member selection is for inspecting and setting, not moving.** Widgets follow the member; the move handle stays on the structure, which owns those coordinates. Band selection is unchanged.

### Rendering

- **Beams pointed at the camera render again.** The cone of a spot light is an open tube, so a ray entering through the open end (every ray, when the beam points at you) hit no face and the beam went hollow. It's double-sided now.
- **Forward scattering in haze.** A beam coming toward you is much brighter than one crossing your view, with a weaker backscatter lobe. Two Henyey-Greenstein lobes, anchored at the head-on peak so the control can only darken, never lift the whole scene.

### Settings widget

- **Wider.** Protocol plus address doesn't fit in 230 px. The body now follows the widget width instead of a hardcoded number.
- **Explicit rows instead of wrapping.** Controls had pixel widths chosen for the narrow widget, so widening just left a gap. Now: the two scales on one line, then the two positions, then the flips.
- **Mirror X/Y are square toggle icon buttons.** Both were missing from the widget's snapshot of device values, so reads returned undefined — the control never showed state and `!undefined` wrote true every time. The icon flips with the field so the button shows what it does, not just whether it's pressed.
- **Open dropdowns track their box on scroll.** They were placed in viewport coordinates while positioned against the document. Dropdown text now stops before the arrow instead of running under it.

### Internals

- **Depth tiles redraw only when their view changes.** The projector atlas redrew every frame and the laser atlas was all-or-nothing because the pass wiped the whole atlas first. Each tile now has its own key (scene walked once, each lens mixed in, projection matrix included so zoom counts) and is cleared inside its own scissor right before redraw. One projector zooming among six costs one scene pass.
- **Fixed a per-render warning on every button** about an undeclared property. The stylesheet set the background anyway, so it looked correct and only the console complained.
- **Cut and fly are on every camera row, including the live one.** Cutting to the camera you're already on is how you get back after looking around, and the button has to be where it was last time.


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

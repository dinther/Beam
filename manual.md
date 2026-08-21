<div align="center">

<img src="./Beatline_Beam_logo_master.png" alt="Beatline Beam" width="140"/>

# Beatline Beam

### The manual

*Alpha. Written while the software is still moving.*

</div>

---

## Contents

**Part one — what this thing is**
- [So what is it?](#so-what-is-it)
- [What it isn't](#what-it-isnt)
- [Why you'd want it](#why-youd-want-it)
- [What else you need](#what-else-you-need)
- [It's alpha, and what that means](#its-alpha-and-what-that-means)
- [What's coming](#whats-coming)

**Part two — the tutorial**
- [Installing](#installing)
- [First look around](#first-look-around)
- [Moving the camera](#moving-the-camera)
- [Step 1: two movers](#step-1-two-movers)
- [Step 2: the diamond](#step-2-the-diamond)
- [Step 3: put it where it belongs](#step-3-put-it-where-it-belongs)
- [Step 4: group it](#step-4-group-it)
- [Step 5: plug in the light](#step-5-plug-in-the-light)
- [Step 6: export the layout](#step-6-export-the-layout)
- [Step 7: over in MadMapper](#step-7-over-in-madmapper)
- [What you just did](#what-you-just-did)

**Part three — reference**
- [The patch bay](#the-patch-bay)
- [Building a generic LED fixture](#building-a-generic-led-fixture)
- [Addressing](#addressing)
- [Placing things](#placing-things)
- [Groups and structures](#groups-and-structures)
- [The visualizer](#the-visualizer)
- [Art-Net input](#art-net-input)
- [The MadMapper export in detail](#the-madmapper-export-in-detail)
- [Keyboard and mouse](#keyboard-and-mouse)
- [Menus](#menus)
- [Files and where they live](#files-and-where-they-live)
- [When something goes wrong](#when-something-goes-wrong)
- [Credits and licence](#credits-and-licence)

---
---

# Part one — what this thing is

## So what is it?

Beam is a **sandbox for lighting rigs**.

You build your rig in three dimensions — the movers where they'll really hang, the LED bars at the height they'll really sit, the panel at the angle it'll really be flown. You give every fixture a real DMX address in a real universe. Then you point some Art-Net at it and watch the whole thing light up, live, at whatever frame rate your machine can manage.

That's it. That's the whole idea. It's a room you can put lights in, before you have the room or the lights.

The word *sandbox* is doing real work in that sentence. This is a place to try things. Get it wrong, drag it somewhere else, get it wrong again. That's what it's for.

## What it isn't

Three things, and it's worth being blunt about all of them.

**It is not photo-realistic.** There's no ray tracing here. No measured photometrics, no IES profiles, no attempt to predict how a beam will actually look punching through real haze in a real room. The haze in Beam is an effect that just looks *plausible*. If you need a photo-realistic render you need a copy of Blender and an afternoon. Beam gives you sixty good enough frames a second rather than one beautiful lie.

What it *is* accurate about is the stuff that bites you on site: **which fixture is where, what it's addressed to, and what colour it's doing right now.** Position, orientation, patch, and response. Those are exact. The prettiness is approximate on purpose.

**It is not a lighting desk.** Beam has no programmer, no cue stack you'd want to run a show from, no submasters, no busking layout. It doesn't want to replace the thing you already program with, because you already have one and you're better at it than a fork of a web app is going to be. Beam *listens*. Something else drives.

**It is not finished.** See [alpha](#its-alpha-and-what-that-means), below.

## Why you'd want it

Here's the situation this was built for.

You're doing something with a lot of pixels — an LED wall, a bunch of strips on a frame, a rig where the interesting part isn't a single beam but the *pattern* across many fixtures. You're driving it with MadMapper, or something like it, because that's the sane way to push video and generative content at pixels.

And you hit the same wall every time, how to pitch your vision. How to try your vision: **MadMapper works on a flat canvas, and your rig is not flat.**

To map content onto your rig, you first have to flatten it — decide where each fixture sits on a 2D surface, so content sweeping across that surface hits your fixtures in an order that means something. Done by hand, that's an afternoon of dragging 2D points. And it's an afternoon you have to spend *again* the moment you want the content to wrap around the rig instead of sweeping across it, because the flattening **is** the effect. Same fixtures, completely different look.

Beam already knows where every fixture is in three dimensions. So it can do that flattening for you, mathematically, using several projections — front elevation, plan view, unrolled around a cylinder, unwrapped like a globe — and hand each one to MadMapper as a file with the addressing already baked in.

That's the pitch. **Build the rig once in 3D. Get many 2D mappings out of it.**

The preview is the other half. Because Beam listens to Art-Net, the same rig you exported is sitting right there responding to what MadMapper is sending. Change the content, watch the rig. No venue, no truss, no power. Great for practice and training too.

## What else you need

Beam is a receiver and a previewer. On its own it will show you a beautifully placed rig sitting in the dark. To see it *do* anything, you need something upstream sending Art-Net.

**The main event: MadMapper.** Beam's export is built specifically around it, and the workflow in the tutorial assumes it. MadMapper is commercial software that maps video and generative content onto physical fixtures and outputs Art-Net. If you're doing pixel work, you probably already have it. The export writes MadMapper's own fixture-library format (`.mmfl`) and a layout file it can import directly, using the same id encoding MadMapper's own export uses — this was learned by taking a file MadMapper exported and reading it byte for byte.

**Anything else that speaks Art-Net also works.** Beam doesn't care what's on the other end of the wire. A lighting desk, QLC+, Resolume, a Python script, an ESP32 — if it puts Art-Net on the network, Beam will render it. You just won't get the layout-export benefit, which is MadMapper-shaped.

**A machine with a real GPU.** All the per-pixel work happens on the graphics card. Integrated graphics will run it; a discrete GPU will run it comfortably with several thousand emitters.

**The desktop app, if you want Art-Net.** Browsers can't receive UDP, so Art-Net input only exists in the Electron build. The browser version is fine for building and exporting a rig — it just won't light up.

## It's alpha, and what that means

Genuinely alpha. Not "we're being modest" alpha.

Concretely: features move and get renamed. The showfile format is JSON and can change between versions without a migration. There are rough edges in the UI you will find within ten minutes. Some things are half-built and visible anyway — the **objects** tab in the patch bay has an "import object" button that's deliberately disabled, because the feature isn't there yet.

What it *does* do, it does properly. Art-Net in, 512 universes, accurate patching including pixels that straddle universe boundaries, and the MadMapper export are all real and working. It's the surrounding polish that's missing.

Save often. Keep your showfiles. Report the odd stuff.

## What's coming

The two big ones, both natural extensions of the same idea:

**Video fixtures.** Screens and LED walls as first-class fixtures, rather than approximating them with a dense grid of pixels.

**Laser projectors.** A different beast entirely — vector output rather than pixel output, ILDA rather than DMX — but the same fundamental job: place the device in 3D, see what it does, and get the geometry out in a form the driving software understands.

Neither is in this build. They're where this is going.

---
---

# Part two — the tutorial

We're going to build a small rig from nothing: two moving heads and a two-metre LED diamond. Then we'll export it and get it lighting up from MadMapper.

Give it half an hour. You'll have the whole workflow in your hands by the end, and everything after that is detail.

## Installing

### The easy way

Grab the installer for your platform from the releases page, run it, done. It's a normal desktop app.

### From source

You'll need [Node.js](https://nodejs.org/) 18 or newer.

```bash
git clone https://github.com/dinther/Beam
cd Beam
npm install
```

Then to run the desktop app in development:

```bash
npm run electron:start
```

Or the browser version, if you don't need Art-Net:

```bash
npm start
```

...and open <http://localhost:5173>.

To build an installer for yourself:

```bash
npm run dist:win     # Windows
npm run dist:mac     # macOS
npm run dist:linux   # Linux
```

## First look around

Start it up and you'll get a splash screen, then the main window.

The important bits:

- **The menu bar**, top left — File, Edit, Preferences, About.
- **The patch bay**, down the left — every fixture in your show. Empty right now.
- **The viewport** — the big 3D view, with a checkered floor, a grid and an axis indicator at the origin.
- **The view cube**, in a corner of the viewport — click a face to snap the camera to that elevation.
- **The modifier panel** — appears when you select something, and holds that thing's settings.

If the reference floor and grid annoy you later, they're all switchable under **Preferences → Visualizer**.

## Moving the camera

Get this into your fingers first, because you'll do it constantly.

| Do this | Get this |
|---|---|
| **Right-drag** | Orbit |
| **Middle-drag** | Pan |
| **Scroll** | Zoom |
| **Left-drag** | Rubber-band select |
| **Left-click** | Select one thing |
| **Shift** or **Ctrl** + click | Add to the selection |

The left button is deliberately *not* a camera control. It's for selecting, because that's what you do most.

One detail worth knowing, because it makes the whole thing feel different: **orbiting pivots around whatever is under your cursor.** Point at a mover, right-drag, and the camera swings around *that mover*. Point at the sky and it falls back to the last sensible pivot. This is the difference between navigating comfortably and fighting a camera that insists on rotating about a point somewhere behind you.

Press **Escape** at any time to deselect everything and reset the view.

## Step 1: two movers

Down in the patch bay, hit **new**.

The patch dialog opens. On the left is a list with three tabs — **fixtures**, **objects**, **structures**. You want **fixtures**, which is where the library lives.

Find a moving head. The list is filterable, so type into it. Pick anything you like — a generic spot or wash is ideal for this.

Now the form on the right:

- **Name** — call it `Mover`.
- **Amount** — set this to **2**. Rather than repeating yourself, ask for two at once. They'll be numbered for you.
- **Fixture mode** — pick a mode. Fixtures have several, and the mode decides how many channels each one eats and what they do. A basic RGB or CMY mode is fine.
- **Universe** — `0`.
- **Channel** — `1`.

Note what happens as you set the mode: the address arithmetic sorts itself out. Ask for two fixtures starting at universe 0 channel 1, and the second one lands immediately after the first, automatically.

Hit submit. Two movers appear in the viewport at the origin, sitting on top of each other. We'll move them shortly.

## Step 2: the diamond

This is the interesting one, because there's no such thing as a "2 × 1 metre diamond" in any fixture library. You're going to describe one.

Open **new** again, stay on the **fixtures** tab, and this time hit **create generic**.

This dialog builds a fixture from scratch — a rigid body carrying a grid of emitters. It's how you describe LED bars, strips, panels, tiles, and anything else that's really just "pixels arranged on a thing".

Fill it in like this:

| Field | Value | Why |
|---|---|---|
| **Type** | LED bar | The only generic kind for now |
| **Manufacturer** | `Beatline` | Free text, it's yours |
| **Model** | `Diamond 2x1` | What it'll be called in the library |
| **Length** | `2.0` | Two metres, in metres |
| **Width** | `1.0` | One metre across |
| **Height** | `0.05` | How thick the body is |
| **Columns** | `32` | Pixels along its length |
| **Rows** | `16` | Pixels across its width |
| **Margin L/R** | `0.02` | Dead space at the ends |
| **Margin T/B** | `0.02` | Dead space at the sides |
| **Size (mm)** | `12` | How big each emitter draws |
| **Beam °** | `120` | Emission cone. 120° is a normal 5050 LED |
| **Wire order** | `RGB` | Component order down the wire |
| **Starts at** | top-left | Which corner pixel one is in |
| **Runs along** | row | Rows first, or columns first |
| **Serpentine** | off | On if your strip snakes back on itself |
| **Prevent cross universe pixels** | **on** | See below |

That's 32 × 16 = **512 pixels**, three channels each, so **1536 channels** — a bit over three universes.

**About that last checkbox.** Three channels don't divide evenly into 512. Left alone, pixel 171 in a universe would have its red on channel 511, its green on 512, and its blue over in the *next universe*. Some controllers do exactly that. Most pixel gear doesn't — it starts each universe cleanly and wastes the last two channels. Ticking **Prevent cross universe pixels** does the polite thing: 170 pixels per universe, channels 511 and 512 left empty. It matches what MadMapper expects, so leave it on unless you know your hardware disagrees.

Create it. It now exists in the fixture library as a definition — you haven't patched one yet.

Back in the patch dialog, find your `Diamond 2x1` in the list and patch **one** of them:

- **Name** — `Diamond`
- **Amount** — `1`
- **Universe** — `1`
- **Channel** — `1`

Starting it at universe 1 keeps it clear of the movers. It'll fill universes 1, 2 and 3, plus a bit of 4.

Submit. There's your panel.

## Step 3: put it where it belongs

Everything's at the origin, in a heap. Time to fix that.

Select a fixture — click it in the viewport, or in the patch bay list. The **modifier panel** appears with its settings, and a **transform gizmo** appears on the fixture itself.

Two ways to move things, and you want both:

**By hand.** Press **T** for translate, **R** for rotate, then drag the gizmo arrows or rings. Fast, good for roughing out. Press **H** to hide the gizmo when it's in the way.

**By numbers.** Open the **Position Tool** in the modifier panel and type exact values. Position X/Y/Z in metres, Rotation X/Y/Z in degrees. The fields are **colour-coded by axis** so you can see at a glance which is which.

Set them like this:

- **Mover 1** — Position `-1.5, 0, 3`
- **Mover 2** — Position `1.5, 0, 3`
- **Diamond** — Position `0, 0, 2.5`

Three metres up for the movers, two and a half for the panel, a metre and a half either side of centre.

Now make it a diamond. Select the panel and rotate it **45°** about the axis that points at the audience — try **Rotation Y** first. If it tips away from you instead of spinning in its own plane, you've got the wrong axis; undo and try X or Z. Watch the viewport, it's obvious immediately.

That's your rig: two movers flanking a diamond panel.

> **Tip.** When fixtures are patched in a run, the position fields also take an **offset** — a per-fixture step applied along the run. Patch eight bars at once, set an offset, and they space themselves out. Much faster than placing eight things by hand.

## Step 4: group it

Groups matter more than they look, because **groups are what carry export mappings**.

Select both movers — click one, Shift-click the other — and hit **group** in the patch bay. Name it `Movers`.

Then select the panel and group it on its own. Name it `Diamond`.

A single-fixture group looks silly until you see why: in the next step, each group gets to choose **how it's flattened for MadMapper**, independently. Your diamond wants to be seen face-on. Your movers might want a plan view. Groups are how you say so.

In a group's widget you'll find:

- **Name**
- **Export mappings** — a tick list. Each ticked mapping exports this group *again*, flattened that way. Tick two and the group appears twice in the layout, mapped two different ways.
- **save as structure** — stores the group as a reusable assembly you can patch again later, from the **structures** tab.
- **ungroup**

Tick **Front** on the `Diamond` group. Leave `Movers` unticked for now — anything with no mapping of its own falls back to the default you pick at export time.

## Step 5: plug in the light

Time to make it move.

Open **Preferences → Art-Net** (**Ctrl+Shift+A**) and set **Receive** to **enabled**.

It'll say *Listening on UDP 6454*. If instead it says *Unavailable in the browser*, you're running the web version — you need the desktop app for this.

That's the entire configuration. There isn't any more. Beam listens on the standard Art-Net port and renders whatever arrives, on whatever universe it arrives on.

Now send it something. In MadMapper — or any Art-Net source — output to your machine's IP on universe 0, and your movers will respond. Universe 1 and up, and the diamond lights.

If nothing happens, jump to [when something goes wrong](#when-something-goes-wrong).

## Step 6: export the layout

The good bit.

**File → Export MadMapper Layout.**

The dialog tells you what it's about to write: how many patched fixtures, how many groups, and how many **squares** — one 1024-unit square per group per mapping, plus one for anything in no group.

- **Default mapping** — set this to **Front**. It's used for groups that ticked nothing of their own, which right now is `Movers`.
- **Perspective** — leave it off for now. It's for the camera views, and there's a note on it below.
- **Also write fixture definitions** — **leave this ticked.** Crucial, and explained in a moment.

Hit export. You get **two files**: the layout, and a `.mmfl` fixture-definitions file.

**Why two files, and why the order matters.** MadMapper resolves a layout's fixtures **by name**. The layout says "there's a Diamond 2x1 here" — it doesn't say what a Diamond 2x1 *is*. That's in the definitions file. So MadMapper has to learn the definitions **before** it reads the layout that refers to them. Import them the wrong way round and you get a layout full of fixtures it can't resolve.

Both files come from the same source inside Beam, so a fixture can't end up called one thing in one file and something else in the other.

## Step 7: over in MadMapper

You don't need to know MadMapper deeply. You need to know four things.

**One — import the definitions first.** In MadMapper's fixture library, import the `.mmfl` file Beam wrote. Your `Diamond 2x1` is now a fixture MadMapper knows about.

**Two — then import the layout.** Your rig appears on the canvas: the diamond as a grid of pixels at the angle you exported it from, the movers as their own shapes, each group in its own square.

**Three — the addressing came with it.** You don't re-patch anything. Universe and channel numbers are encoded in the element ids, in MadMapper's own format:

```
Name__UN__10__CH__121__FT__fixture_line__FD__Beatline - 60 LED Bar GRB
```

Universe 10, channel 121. MadMapper reads that on import. What you addressed in Beam is what MadMapper outputs.

**Four — point the output back at Beam.** Set MadMapper's Art-Net output to your machine's IP. Drop any content onto the mapped fixtures.

And now the loop is closed: content in MadMapper, Art-Net over the network, your rig lighting up in Beam in real time. Change the content, watch the rig change.

That's the whole workflow. Everything else is refinement.

## What you just did

Worth being explicit, because it's the point of the tool:

You described a rig **once**, in three dimensions, with real addresses. From that one description you got a 2D mapping with the patch baked in, ready for content — and a live preview of the result. When you want a different mapping, you don't rebuild anything. You tick a different box and export again.

---
---

# Part three — reference

Everything Beam does, as completely as it can be documented today. This section is explicitly a **work in progress** — the software is moving, and some of this will drift. If something here doesn't match what you're seeing, trust the software.

## The patch bay

The list down the left side, holding every fixture in the show. Two buttons at the top: **group** and **new**.

**new** opens the patch dialog, which has three tabs:

- **fixtures** — the fixture library. Real profiles plus any generics you've built. Filterable.
- **objects** — non-emitting scenery. Trusses, staging, decks. A truss has no channels, so nothing here gets addressed. *The "import object" button is disabled — this feature isn't finished.*
- **structures** — saved groups, ready to patch again as a unit. You put things here with **save as structure** in a group's widget.

Two more buttons live under the fixtures list:

- **create generic** — the generic fixture builder, below.
- **export .mmfl** — writes the *selected* fixture as a MadMapper definition, in the selected mode. Handy when you want one definition without exporting a whole layout.

## Building a generic LED fixture

Open with **create generic**. Describes a rigid body carrying a grid of emitters, and covers bars, strips, panels, tiles and battens.

This exists because fixture libraries describe *what a channel does*, not *where an emitter physically sits* — and for pixel fixtures, position is the whole point. So you describe the geometry directly. What comes out is shaped exactly like a library profile, so everything downstream treats it identically.

**Physical**

| Field | Meaning |
|---|---|
| Length, Width, Height | Body size in metres |
| Margin L/R, Margin T/B | Dead space between the body edge and the first pixel |
| Columns, Rows | Pixel grid |
| Size (mm) | How large each emitter draws |
| Beam ° | Emission cone, full angle. 120° for a typical 5050 |

**Electrical**

| Field | Meaning |
|---|---|
| Wire order | Component order down the wire — `RGB`, `GRB`, `RGBW`… Cheap strips are usually GRB |
| Starts at | Which corner holds pixel one |
| Runs along | Row-first or column-first |
| Serpentine | Whether alternate lines reverse direction |
| Prevent cross universe pixels | Keeps every pixel whole within one universe |

Four corners × two axes × serpentine on/off gives **sixteen** wiring arrangements, which covers essentially every real bar without having to name any of them.

Components available: **R**ed, **G**reen, **B**lue, **W**hite, **A**mber, **UV**.

The default is a metre of 60-pixel GRB strip in an aluminium profile — a very common object, and a sensible starting point to edit.

## Addressing

Universes are 512 channels, numbered as everyone else numbers them. Beam holds **512 universes** at once — 262,144 channels.

Anything arriving above that is dropped, but *says so*: you get one warning per offending universe in the console, deliberately once rather than per frame, since a source repeating at 40 Hz would bury the console in seconds. A rig going half-dark with no explanation is the thing this is designed to prevent.

**Straddling.** A fixture whose channel count doesn't divide neatly into 512 will run off the end of a universe and continue into the next. That's handled properly. **Prevent cross universe pixels** is the opposite choice: waste the last few channels so every pixel stays whole. It's a property of the fixture model, not of any one patch of it, because a strip lays its channels out the same way wherever you address it.

**Amount.** Patching several at once addresses them consecutively for you, each starting where the last one ended.

## Placing things

**The gizmo.** Select something and it appears. **T** for translate, **R** for rotate, **H** to hide it, **Escape** to drop the selection and reset the view.

**The Position Tool.** In the modifier panel. Exact numeric entry:

- **Position X / Y / Z** — metres
- **Rotation X / Y / Z** — degrees
- **Offset X / Y / Z** and **Rotation Offset X / Y / Z** — per-fixture step applied along a patched run, so a row of bars can space and fan itself

Fields are **colour-coded by axis**, consistently, so you can see which is which without reading labels.

**Selection.** Left-click for one, left-drag for a rubber band, Shift or Ctrl to add. The band drag survives leaving the canvas, so you can start inside the viewport and finish outside it.

## Groups and structures

A group is a named set of fixtures. It gives you:

- **Name**
- **Export mappings** — the tick list that decides how this group is flattened for MadMapper. Each ticked mapping exports the group again, flattened that way, in its own square on the canvas. Groups with nothing ticked use the export dialog's default.
- **save as structure** — stores the arrangement for reuse, and it shows up in the **structures** tab of the patch dialog.
- **ungroup**

Groups have their own transform handle, so you can move and rotate a whole assembly as one object.

Each group owns its mappings independently — one group can go out as a front elevation while another is unrolled around a cylinder, in the same export.

## The visualizer

**Preferences → Visualizer** (**Ctrl+Shift+V**).

**Fogging**
- **State** — on or off
- **Density** — 0–100, how thick the haze is
- **Turbulence** — 0–100, how much it moves over time

**Lighting**
- **Global Brightness** — 25–200. Scales the whole scene. Turn it down for a dark rig, up for a bright one.

**Reference** — turn these off for a clean render
- **Floor** — the checkered ground plane
- **Grid** — the infinite reference grid
- **Axes** — the origin indicator
- **Background** — colour behind the scene
- **Debug** — frame timings and the emitter tuning panel

**The view cube.** Click a face to snap to that elevation. Faster than orbiting when you want a straight-on view — and straight-on views are what you want before exporting a camera projection.

**How it draws.** Every emitter's colour is looked up per-frame on the GPU, from a texture holding all 512 universes. Nothing per-LED happens on the CPU, so the cost is set by how many universes you're running rather than how many individual LEDs are lit. Thousands of emitters is normal.

## Art-Net input

**Preferences → Art-Net** (**Ctrl+Shift+A**). One switch: **Receive**, enabled or disabled.

- Listens on **UDP 6454**, the standard Art-Net port.
- **Desktop app only.** Browsers can't receive UDP. The web build says so rather than failing quietly.
- Universe numbers are read from the full 15-bit Art-Net field, so any universe a source can address, Beam will accept — up to the 512 it can hold.
- No configuration beyond the switch. No IP to set, no subscription to manage.

Output to hardware is a separate matter and goes via the WSC protocol inherited from ASLS Studio — see the README.

## The MadMapper export in detail

**File → Export MadMapper Layout.**

### The projections

Eight ways to flatten a three-dimensional rig onto a two-dimensional canvas.

**Camera views** — what a plan or an elevation would show. The rig still looks like itself.

| | |
|---|---|
| **Front** | As seen from the front. Fixtures behind others land on top of them |
| **Back** | From behind |
| **Left**, **Right** | From the sides |
| **Top** | A plan view. Fixtures above others land on top of them |
| **Bottom** | Plan view from below |

**Unwraps** — don't look like anything, but never put one fixture on top of another.

| | |
|---|---|
| **Cylindrical unwrap** | Unrolled about the vertical axis, so content travels *around* the rig rather than through it |
| **Spherical unwrap** | Unrolled by longitude and latitude. Suits a rig shaped roughly like a ball |

The choice matters more than it sounds. **The flattening is the effect.** Content sweeping across a front view behaves nothing like content wrapping around a cylinder, even though the fixtures never moved. This is why you can export the same rig several ways and pick between them in MadMapper.

### Perspective

Available on the camera views only, with an **Eye (radii)** distance from 1.1 to 20.

Flattening along an axis loses anything lying *on* that axis — a bar aimed straight at the view keeps its pixels but has nowhere to put them. A camera at a finite distance has no such direction: bring the eye in close and the near face opens out while the far one nests inside it.

Useful for rigs with depth. Unnecessary for flat ones.

### The edge-on warning

If fixtures point straight at your chosen view, the dialog names them.

A bar pointing at the viewer projects to a point, and MadMapper silently discards a zero-length line — the fixture would vanish from the import without telling you. Instead they're exported at a token length. The direction is a fiction, but a fixture in the wrong place can be dragged; one that never arrived has to be *noticed* first.

Treat the warning as a nudge to either place those by hand afterwards, or pick a view that suits them better.

### Fixture definitions

**Also write fixture definitions** writes a `.mmfl` file alongside the layout — plain XML, one `<LEDFixture>` per definition.

**Import the definitions before the layout.** MadMapper resolves fixtures by name, so the definitions must already be in its library when the layout referring to them arrives.

### What's in the files

- **One 1024-unit square per group per mapping**, plus one square for anything belonging to no group.
- **200 SVG units per metre**, fixed, so two exports of the same rig stay comparable.
- Addressing encoded in element ids in MadMapper's own format, learned from a file MadMapper exported.
- CRLF line endings, because that's what MadMapper writes and its own files are read back byte for byte.

## Keyboard and mouse

**Mouse**

| | |
|---|---|
| Left-click | Select |
| Left-drag | Rubber-band select |
| Shift / Ctrl + click | Add to selection |
| Right-drag | Orbit, pivoting on whatever is under the cursor |
| Middle-drag | Pan |
| Scroll | Zoom |

**Keyboard**

| | |
|---|---|
| **T** | Translate gizmo |
| **R** | Rotate gizmo |
| **H** | Hide the gizmo |
| **Escape** | Deselect everything and reset the view |
| **Ctrl+Z** | Undo |
| **Ctrl+Y** | Redo |
| **Ctrl+S** | Save showfile |
| **Ctrl+O** | Load showfile |
| **Ctrl+Shift+S** | Export showfile |
| **Shift+N** | New showfile |
| **Ctrl+Shift+V** | Visualizer preferences |
| **Ctrl+Shift+A** | Art-Net preferences |

## Menus

**File** — New Showfile, Load Showfile, Save Showfile, Export Showfile, Export MadMapper Layout

**Edit** — Undo, Redo

**Preferences** — Visualizer, Art-Net

**About** — Manual, License, Credits, Contact

## Files and where they live

**Showfiles are JSON.** **Save Showfile** keeps the show in the application's own storage — that's your working save, and it's what comes back when you reopen. **Export Showfile** writes a `.json` file wherever you want it, which is what you hand to someone else or keep as a backup.

**Fixture profiles** come from the built-in library, with generics you build stored alongside them.

**Exports** — the MadMapper layout and its `.mmfl` definitions go wherever you point them.

Being alpha, the showfile format can change between versions. Keep exported copies of anything you'd be annoyed to lose.

## When something goes wrong

**Nothing lights up.**
Check, in order:
1. Is Art-Net input **enabled** in Preferences?
2. Are you running the **desktop app**? The browser can't receive UDP.
3. Is your source pointed at this machine's IP, on **port 6454**?
4. Do the **universe numbers match**? A source on universe 1 lights nothing patched to universe 0.
5. Firewall. UDP 6454 inbound. This one catches people constantly on Windows.

**Some fixtures light up, others don't.**
Probably addressing. Open the console (**Debug** in Visualizer preferences) and look for dropped-universe warnings — anything above universe 511 is refused, and it'll say so once per universe.

**A fixture vanished from the MadMapper import.**
It was edge-on to your export view. Beam warns about this before exporting, and gives such fixtures a token length so they survive — but if you exported past the warning, they may be somewhere odd on the canvas. Re-export from a view that suits them, or move them by hand in MadMapper.

**MadMapper imported the layout but the fixtures are wrong or missing.**
You imported the layout before the definitions. Import the `.mmfl` first, then the layout.

**Colours are wrong — red and green swapped.**
Wire order. Most cheap strips are **GRB**, not RGB. Change it in the generic fixture's definition.

**Pixels are one channel out at universe boundaries.**
The **Prevent cross universe pixels** setting doesn't match your hardware. If your controller starts each universe cleanly, tick it. If it packs channels continuously, untick it.

**The viewport is slow.**
Turn down fog **Density** and **Turbulence** first — they're the most expensive things on screen. Then turn off **Floor** and **Grid**.

## Credits and licence

Beam is built on **[ASLS Studio](https://github.com/ASLS-org/studio)** by Timé Kadel, released under the GPL-3.0. Its patching, scene, effect and chase engines, its UI kit and the first version of its visualizer are the foundation this stands on. Beam adds Art-Net input, a rebuilt visualizer, generic LED fixtures, per-group export mappings, and the MadMapper layout and library export.

Beam is likewise **GPL-3.0**. See [`COPYING`](./COPYING) for the full terms, and [`CREDITS.html`](./CREDITS.html) for third-party libraries, fonts and data.

Copyright © 2026 Paul van Dinther. Portions copyright © ASLS-org / Timé Kadel, 2021.

---

*This manual is a work in progress, like the software it describes. If something here is wrong, or something you needed isn't here, that's worth an issue.*

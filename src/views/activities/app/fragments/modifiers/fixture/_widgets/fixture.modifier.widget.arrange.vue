<template>
  <uk-widget
    class="arrange_tool"
    dockable
    :header="{ title: 'Arrange', icon: 'move' }"
  >
    <uk-flex
      col
      class="arrange_body"
      :gap="10"
    >
      <uk-flex :gap="4">
        <uk-button
          v-for="mode in modes"
          :key="`${mode.kind}-${kind}-${pickTick}`"
          square
          icon-only
          :value="false"
          toggleable
          :icon="mode.icon"
          :label="mode.label"
          :model-value="kind === mode.kind"
          color="var(--accent-blue)"
          style="flex: 1"
          @click="setKind(mode.kind)"
        />
      </uk-flex>

      <uk-flex class="arrange_count">
        <span>Selected</span>
        <span style="flex: 1" />
        <b>{{ items.length }} {{ items.length === 1 ? 'item' : 'items' }}</b>
      </uk-flex>

      <!-- LINE -->
      <uk-flex
        v-if="kind === 'line'"
        col
        :gap="7"
      >
        <uk-num-input
          v-model="line.x"
          color="var(--axis-x-field)"
          label="Spacing X"
          :precision="2"
          :min="-1000"
          :max="1000"
        />
        <uk-num-input
          v-model="line.y"
          color="var(--axis-y-field)"
          label="Spacing Y"
          :precision="2"
          :min="-1000"
          :max="1000"
        />
        <uk-num-input
          v-model="line.z"
          color="var(--axis-z-field)"
          label="Spacing Z"
          :precision="2"
          :min="-1000"
          :max="1000"
        />
      </uk-flex>

      <!-- CIRCLE -->
      <uk-flex
        v-if="kind === 'circle'"
        col
        :gap="7"
      >
        <uk-num-input
          v-model="circle.radius"
          label="Radius"
          :precision="2"
          :min="0"
          :max="1000"
        />
        <uk-num-input
          v-model="circle.sweep"
          label="Sweep °"
          :min="-720"
          :max="720"
        />
      </uk-flex>

      <!-- GRID -->
      <uk-flex
        v-if="kind === 'grid'"
        col
        :gap="7"
      >
        <uk-num-input
          v-model="grid.columns"
          label="Columns"
          :min="1"
          :max="512"
        />
        <uk-num-input
          v-model="grid.gapAcross"
          label="Gap across"
          :precision="2"
          :min="-1000"
          :max="1000"
        />
        <uk-num-input
          v-model="grid.gapDown"
          label="Gap down"
          :precision="2"
          :min="-1000"
          :max="1000"
        />
        <span class="arrange_derived">{{ gridShape }}</span>
        <uk-checkbox
          v-model="grid.snake"
          label="Snake rows"
        />
      </uk-flex>

      <!-- AIM: shared by every shape, because it means the same thing in all
           of them. It used to be a dropdown per shape with its own words --
           "Along the line", "Outward" -- which could not say "tangential" or
           "square to the line", and gave the grid no aim at all. -->
      <uk-flex
        v-if="kind !== 'align'"
        col
        :gap="7"
        class="arrange_aim"
      >
        <uk-checkbox
          v-model="aim.keep"
          label="Keep heading"
        />
        <!-- Greyed rather than hidden: the fields are what the section is,
             and taking them off the panel makes it jump and leaves nothing
             saying what the checkbox is refusing to do. -->
        <uk-num-input
          v-model="aim.angle"
          label="Heading °"
          :disabled="aim.keep"
          :min="-360"
          :max="360"
        />
        <uk-select-input
          v-model="aim.fromIndex"
          label="Measured from"
          :disabled="aim.keep"
          :options="aimFromLabels"
        />
        <span
          class="arrange_derived"
          :class="{ arrange_derived_off: aim.keep }"
        >{{ aimHint }}</span>
      </uk-flex>

      <!-- ALIGN -->
      <uk-flex
        v-if="kind === 'align'"
        col
        :gap="7"
      >
        <uk-select-input
          v-model="align.x"
          label="X"
          :options="axisLabels"
        />
        <uk-select-input
          v-model="align.y"
          label="Y"
          :options="axisLabels"
        />
        <uk-select-input
          v-model="align.z"
          label="Z"
          :options="axisLabels"
        />
        <uk-select-input
          v-model="align.to"
          label="Align to"
          :options="alignToLabels"
          :disabled="!alignsAnything"
        />
      </uk-flex>

      <!-- Ordering means nothing to Align: it leaves every fixture where it
           already is, so there is no first and no last. -->
      <uk-flex
        v-if="kind !== 'align'"
        col
        :gap="7"
      >
        <uk-select-input
          v-model="order"
          label="Order"
          :options="orderLabels"
        />
        <uk-checkbox
          v-model="reverse"
          label="Reverse"
        />
      </uk-flex>

      <uk-spacer />

      <span class="arrange_note">{{ summary }}</span>
      <!-- Together, and cancel first, as every popup in the app puts it: one
           throws the preview away and the other commits it, so they are two
           answers to the same question and belong side by side. Apply used to
           sit in the widget's header, a panel's length from what undoes it. -->
      <uk-flex :gap="6">
        <uk-button
          label="Cancel"
          style="flex: 1"
          :disabled="!previewing"
          @click="cancel"
        />
        <uk-button
          icon="tick"
          label="Apply"
          style="flex: 1"
          :disabled="!previewing"
          @click="apply"
        />
      </uk-flex>
    </uk-flex>
  </uk-widget>
</template>

<script>
import * as THREE from 'three';
import Controls from '@/plugins/visualizer/controls';
import { SCENE_ITEM_KINDS, kindOf } from '@/models/DMX/scene_item';
import {
  LAYOUT,
  AIM_FROM,
  AXIS,
  ALIGN_TO,
  ORDER,
  arrangeTransforms,
  aimedRotation,
  alignAxes,
  boundsCentre,
  orderIndices,
} from '@/models/DMX/arrangement';

/**
 * Align is a mode of this panel but not a layout: it shapes nothing, it tidies
 * what is already there. Keeping it out of LAYOUT stops `arrangement.js` from
 * having to pretend the two are the same kind of thing.
 *
 * @constant {String} ALIGN_KIND
 */
const ALIGN_KIND = 'align';

/**
 * Scratch maths for previewing a structure. Reused rather than allocated
 * because a preview runs on every keystroke, once per member.
 */
const previewMatrix = new THREE.Matrix4();
const previewPosition = new THREE.Vector3();
const previewQuaternion = new THREE.Quaternion();
const previewEuler = new THREE.Euler();
const previewScale = new THREE.Vector3(1, 1, 1);
const memberMatrix = new THREE.Matrix4();
const memberPosition = new THREE.Vector3();
const memberQuaternion = new THREE.Quaternion();
const memberEuler = new THREE.Euler();

/**
 * uk-select-input works in indices rather than values, so every select needs
 * its options and the things they mean side by side.
 */
const AIM_FROMS = [AIM_FROM.SHAPE, AIM_FROM.WORLD];
const AXIS_MODES = [AXIS.LEAVE, AXIS.ALIGN, AXIS.SPREAD];
const ALIGN_TARGETS = [ALIGN_TO.AVERAGE, ALIGN_TO.MIN, ALIGN_TO.MAX, ALIGN_TO.FIRST, ALIGN_TO.LAST];
const ORDERS = [ORDER.ADDRESS, ORDER.NAME, ORDER.SELECTION];

/**
 * @component ArrangeToolWidget
 *
 * Shapes a whole selection at once.
 *
 * The maths lives in `arrangement.js` and is tested there. What this file owns
 * is the part that cannot be tested headlessly: when to touch the renderers,
 * when to touch the show, and how to put everything back.
 *
 * One rule shapes the whole file: **preview writes to the renderers, Apply
 * writes to the model.** Every property set on a Fixture goes through the
 * Proxify trap onto the undo stack, and that stack's hash regenerates on every
 * mousedown and mouseup -- so previewing through the model would push two
 * dozen entries per keystroke and split one spinner drag across several undo
 * steps. Writing straight to the renderers costs nothing, leaves the show
 * untouched, and makes Cancel a matter of pushing the model back out.
 *
 * @namespace views/activities/app/fragments/modifiers
 */
export default {
  name: 'FixtureModifierWidgetArrange',
  compatConfig: {
    MODE: 3,
  },
  props: {
    /**
     * Every item in the current selection.
     *
     * An item is whatever was selected, at the granularity it was selected at:
     * a fixture standing on its own, or a whole structure. A structure counts
     * once, which is the difference between laying three trusses along a line
     * and laying out every fixture inside them.
     */
    items: {
      type: Array,
      default: () => [],
    },
  },
  data() {
    return {
      /**
       * Which mode the panel is in. Null until mounted so the picker's first
       * highlight arrives as a change rather than an initial value.
       */
      kind: null,
      /**
       * Bumped on every mode click, purely to re-key the picker buttons.
       * uk-button flips its own toggle on click, so without a remount the
       * active mode un-highlights when it is clicked again.
       */
      pickTick: 0,
      line: {
        x: 1, y: 0, z: 0,
      },
      circle: { radius: 3, sweep: 360 },
      grid: {
        columns: 4, gapAcross: 1, gapDown: 1, snake: false,
      },
      align: {
        x: 0, y: 0, z: 0, to: 0,
      },
      order: 0,
      reverse: false,
      /**
       * Where every item stood before the tool touched anything. Null means
       * nothing is being previewed.
       */
      baseline: null,
      modes: [
        { kind: LAYOUT.LINE, icon: 'line', label: 'Line' },
        { kind: LAYOUT.CIRCLE, icon: 'circle', label: 'Circle' },
        { kind: LAYOUT.GRID, icon: 'grid', label: 'Grid' },
        { kind: ALIGN_KIND, icon: 'adjust', label: 'Align' },
      ],
      aimFromLabels: ['The shape', 'The world'],
      /**
       * One aim for every shape.
       *
       * `keep` is separate from the angle on purpose: "leave the fixtures
       * facing where they face" is not an angle, and zero is a real heading.
       *
       * Stated as what it refuses rather than what it does, and off by
       * default, so arranging a set aims it -- which is what arranging a set
       * is usually for. The old wording made not-aiming the default and read
       * as a feature to switch on rather than one to decline.
       */
      aim: { keep: false, angle: 0, fromIndex: 0 },
      axisLabels: ['Leave', 'Align', 'Spread'],
      alignToLabels: ['Average', 'Lowest', 'Highest', 'First', 'Last'],
      orderLabels: ['Address', 'Name', 'Selection'],
    };
  },
  computed: {
    /**
     * The aim to hand the layout, or undefined to leave facings alone.
     *
     * Undefined rather than an angle of zero, because zero is a real heading:
     * a layout used only to move things must not turn them all to face east.
     *
     * @public
     * @return {Object|undefined}
     */
    aimOption() {
      if (this.aim.keep) return undefined;
      return {
        angle: Number(this.aim.angle) || 0,
        from: AIM_FROMS[this.aim.fromIndex] || AIM_FROM.SHAPE,
      };
    },
    /**
     * What zero means for the shape on screen, since it differs per shape and
     * an angle with no stated origin is a guess.
     *
     * @public
     * @return {String}
     */
    aimHint() {
      if (this.aim.fromIndex === 1) return '0° faces +X, whatever the shape';
      if (this.kind === LAYOUT.CIRCLE) return '0° outward, 90° tangential, 180° inward';
      if (this.kind === LAYOUT.LINE) return '0° along the line, 90° square to it';
      return '0° across the grid, 90° down it';
    },
    /**
     * Whether fixtures are standing somewhere the show does not know about.
     *
     * @property {Boolean} previewing
     */
    previewing() {
      return this.baseline !== null;
    },
    /**
     * Rows and columns the grid actually works out to.
     *
     * @property {String} gridShape
     */
    gridShape() {
      const columns = Math.max(1, Math.floor(this.grid.columns) || 1);
      const rows = Math.ceil(this.items.length / columns);
      const spare = columns * rows - this.items.length;
      return `${columns} × ${rows}${spare ? `, last row ${columns - spare} of ${columns}` : ''}`;
    },
    /**
     * Whether any axis is set to Align, which is all "Align to" governs.
     *
     * @property {Boolean} alignsAnything
     */
    alignsAnything() {
      return [this.align.x, this.align.y, this.align.z]
        .some((index) => AXIS_MODES[index] === AXIS.ALIGN);
    },
    /**
     * One line saying what the current settings come out as, so the numbers
     * mean something before Apply is pressed.
     *
     * @property {String} summary
     */
    summary() {
      const n = this.items.length;
      if (n < 2) return '';
      if (this.kind === LAYOUT.CIRCLE) {
        const sweep = Number(this.circle.sweep);
        const closed = sweep !== 0 && Math.abs(sweep) % 360 === 0;
        const step = sweep / (closed ? n : n - 1);
        return `${step.toFixed(1)}° apart`;
      }
      if (this.kind === LAYOUT.LINE) {
        const step = Math.hypot(Number(this.line.x), Number(this.line.y), Number(this.line.z));
        return `spans ${(step * (n - 1)).toFixed(2)} m`;
      }
      if (this.kind === LAYOUT.GRID) {
        const columns = Math.max(1, Math.floor(this.grid.columns) || 1);
        const rows = Math.ceil(n / columns);
        const across = ((columns - 1) * Number(this.grid.gapAcross)).toFixed(2);
        const down = ((rows - 1) * Number(this.grid.gapDown)).toFixed(2);
        return `${across} m × ${down} m`;
      }
      const touched = [this.align.x, this.align.y, this.align.z]
        .filter((index) => AXIS_MODES[index] !== AXIS.LEAVE).length;
      return touched ? 'axes left alone are not touched' : 'no axis set to change';
    },
  },
  watch: {
    // A change of selection abandons the preview: the items it was moving may
    // not even be selected any more.
    items() {
      this.restore();
      this.baseline = null;
    },
    kind() { this.preview(); },
    line: { handler() { this.preview(); }, deep: true },
    circle: { handler() { this.preview(); }, deep: true },
    grid: { handler() { this.preview(); }, deep: true },
    align: { handler() { this.preview(); }, deep: true },
    // Aim is not part of any one shape, so it needs its own line here. Every
    // shape's fields already had one and a new field that is not a shape is
    // exactly the sort of thing this list forgets.
    aim: { handler() { this.preview(); }, deep: true },
    order() { this.preview(); },
    reverse() { this.preview(); },
  },
  mounted() {
    this.kind = LAYOUT.LINE;
  },
  beforeUnmount() {
    // Leaving with items mid-preview would strand them somewhere the show has
    // never heard of.
    this.restore();
  },
  methods: {
    /**
     * Switches layout, previewing it straight away.
     *
     * Showing the answer before anything has been typed is the point of the
     * tool: the shape appears, and the fields become a steering wheel rather
     * than a specification.
     *
     * @public
     * @param {String} kind one of LAYOUT, or ALIGN_KIND
     */
    setKind(kind) {
      this.pickTick += 1;
      this.kind = kind;
    },
    /**
     * Remembers where every fixture is, and takes the gizmo out of the way.
     *
     * The transform handle re-parents each selected fixture's 3D dummy under a
     * group of its own, so a position written to a renderer while that group
     * is live lands in the group's local space rather than the world's.
     * Flushing commits any drag already made -- which is what deselecting
     * would have done anyway -- and puts the dummies back in the scene.
     *
     * @public
     */
    capture() {
      if (this.baseline) return;
      if (Controls.pooledInstances && Controls.pooledInstances.length) {
        Controls.applyTransformation();
      }
      this.baseline = this.items.map((item) => ({
        item,
        position: { ...item.position },
        rotation: { ...item.rotation },
      }));
    },
    /**
     * Abandons the preview and puts every fixture back where it started.
     *
     * The flush has to come first, and it is not optional. Selecting fixtures
     * re-parents their 3D dummies under the gizmo's own node *and* rewrites
     * their coordinates relative to the selection's bounding box, so a world
     * position written to a renderer while that is live lands at roughly the
     * box's centre plus itself -- which is how a fixture flies off and looks
     * deleted. Flushing puts every dummy back in the scene in world space.
     *
     * Flushing also commits whatever the dummies are holding, and mid-preview
     * that is an arrangement nobody asked to keep, so the baseline goes back
     * into the model straight afterwards. Writing through the model rather
     * than at the renderers is what makes that correction stick: the setters
     * push it onward, and the show ends up holding what it held before the
     * tool was ever touched.
     *
     * @public
     */
    restore() {
      if (!this.baseline) return;
      if (Controls.pooledInstances && Controls.pooledInstances.length) {
        Controls.applyTransformation();
      }
      this.baseline.forEach(({ item, position, rotation }) => {
        item.position = position;
        item.rotation = rotation;
      });
      // Cleared here rather than by each caller, so the invariant the preview
      // depends on holds everywhere: a baseline is only ever held while the
      // gizmo's helpers are down.
      this.baseline = null;
      Controls.showHelpers();
    },
    /**
     * Works out where everything would go, and shows it.
     *
     * @public
     */
    preview() {
      if (!this.kind || this.items.length < 2) return;
      this.capture();
      this.placements().forEach(({ item, position, rotation }) => {
        if (kindOf(item) === SCENE_ITEM_KINDS.STRUCTURE) {
          this.previewStructure(item, position, rotation);
          return;
        }
        if (!item._3DModel) return;
        item._3DModel.position = position;
        // Written every time, falling back to where the item actually faces --
        // the same thing `previewStructure` does, and for the same reason.
        // Skipping the write when the layout has no opinion looks equivalent
        // and is not: the renderer is still holding the heading the *previous*
        // preview gave it, so turning "Set heading" back off left the items
        // aimed and only cancelling put them back. The model is never written
        // during a preview, so `item.rotation` is still the original.
        const facing = rotation || item.rotation;
        item._3DModel.rotation = {
          x: (facing.x * Math.PI) / 180,
          y: (facing.y * Math.PI) / 180,
          z: (facing.z * Math.PI) / 180,
        };
      });
    },
    /**
     * Shows a structure where it would land, without moving it.
     *
     * A structure draws nothing itself -- its members are what is on screen --
     * so previewing one means working out where each member would stand and
     * writing that to the member's renderer. Writing to the structure instead
     * would go through its setters into the model, and the whole point of a
     * preview is that the show never hears about it.
     *
     * @public
     * @param {Object} structure the structure being previewed
     * @param {Object} position where its origin would be, in metres
     * @param {Object} rotation where it would face, in degrees, or null
     */
    previewStructure(structure, position, rotation) {
      const facing = rotation || structure.rotation;
      previewMatrix.compose(
        previewPosition.set(position.x, position.y, position.z),
        previewQuaternion.setFromEuler(previewEuler.set(
          THREE.MathUtils.degToRad(facing.x),
          THREE.MathUtils.degToRad(facing.y),
          THREE.MathUtils.degToRad(facing.z),
        )),
        previewScale.set(1, 1, 1),
      );
      structure.members.forEach((member) => {
        if (!member.localTransform || !member._3DModel) return;
        memberMatrix.multiplyMatrices(previewMatrix, member.localTransform);
        memberMatrix.decompose(memberPosition, memberQuaternion, previewScale);
        memberEuler.setFromQuaternion(memberQuaternion);
        member._3DModel.position = {
          x: memberPosition.x, y: memberPosition.y, z: memberPosition.z,
        };
        member._3DModel.rotation = {
          x: memberEuler.x, y: memberEuler.y, z: memberEuler.z,
        };
      });
    },
    /**
     * Where every fixture should end up, in world metres and degrees.
     *
     * @public
     * @return {Array} `{ fixture, position, rotation }`, rotation null wherever
     *                 the layout leaves facing alone
     */
    placements() {
      const baseline = this.baseline || this.items.map((item) => ({
        item,
        position: { ...item.position },
        rotation: { ...item.rotation },
      }));

      if (this.kind === ALIGN_KIND) {
        const moved = alignAxes(baseline.map((entry) => entry.position), {
          x: AXIS_MODES[this.align.x],
          y: AXIS_MODES[this.align.y],
          z: AXIS_MODES[this.align.z],
          alignTo: ALIGN_TARGETS[this.align.to],
        });
        return baseline.map((entry, i) => ({
          item: entry.item,
          position: moved[i],
          rotation: null,
        }));
      }

      const centre = boundsCentre(baseline.map((entry) => entry.position));
      const transforms = arrangeTransforms(baseline.length, this.layoutOptions());
      const sequence = orderIndices(
        baseline.map((entry) => entry.item),
        ORDERS[this.order],
        this.reverse,
      );

      return sequence.map((itemIndex, place) => {
        const entry = baseline[itemIndex];
        const step = transforms[place];
        return {
          item: entry.item,
          position: {
            x: centre.x + step.position.x,
            y: centre.y + step.position.y,
            z: centre.z + step.position.z,
          },
          // aimZ only spins an item about the room's vertical, so a head
          // hanging at rotX 180 keeps hanging and an object tipped about y
          // keeps its tilt -- both swing rather than tumble. The turn cannot
          // be written into z: in an XYZ Euler that is the item's own axis,
          // not the room's.
          rotation: step.aimZ === null ? null : aimedRotation(entry.rotation, step.aimZ),
        };
      });
    },
    /**
     * The current layout in the shape `arrangement.js` wants.
     *
     * @public
     * @return {Object} layout options
     */
    layoutOptions() {
      if (this.kind === LAYOUT.CIRCLE) {
        return {
          kind: LAYOUT.CIRCLE,
          radius: Number(this.circle.radius),
          sweep: Number(this.circle.sweep),
          aim: this.aimOption,
        };
      }
      if (this.kind === LAYOUT.GRID) {
        return {
          kind: LAYOUT.GRID,
          columns: Number(this.grid.columns),
          gapAcross: Number(this.grid.gapAcross),
          gapDown: Number(this.grid.gapDown),
          snake: this.grid.snake,
          aim: this.aimOption,
        };
      }
      return {
        kind: LAYOUT.LINE,
        spacing: {
          x: Number(this.line.x),
          y: Number(this.line.y),
          z: Number(this.line.z),
        },
        aim: this.aimOption,
      };
    },
    /**
     * Commits the preview to the show.
     *
     * The only place the model is written, and it happens in one pass so the
     * whole arrangement shares a single undo hash: one Ctrl-Z puts every
     * fixture back, rather than walking the circle apart one mover at a time.
     *
     * @public
     */
    apply() {
      if (!this.previewing) return;
      this.placements().forEach(({ item, position, rotation }) => {
        // Written through the item's own setter, whichever kind it is: a
        // structure's fans the move out to its members, a fixture's just moves
        // itself.
        item.position = position;
        if (rotation) item.rotation = rotation;
        // A fixture in a group keeps a transform relative to that group. Move
        // it without recapturing and the group still believes it is where it
        // was, so the next time the group moves the fixture snaps back.
        if (item.group && item.group.captureLocal) item.group.captureLocal(item);
      });
      // What was applied is the new truth, so the next edit starts from here
      // rather than from wherever the fixtures stood before.
      this.baseline = null;
      Controls.showHelpers();
      this.dismiss();
    },
    /**
     * Closes the panel, the way clicking empty scene would.
     *
     * Both buttons are the end of the job, so both let go of the selection
     * rather than leaving the panel open over work that is already finished.
     * Dropping the selection is what closes it: the panel is only ever up for
     * two or more selected items.
     *
     * @public
     */
    dismiss() {
      // Closes the panel without dropping the selection.
      //
      // This called `deselectAll`, which hid the panel only as a side effect:
      // the widget is gated on `showsManyItems`, so emptying the selection made
      // it disappear. The panel closing was the intent; losing the selection
      // was collateral -- and it threw away the very set that had just been
      // arranged, so nudging it, arranging it again or moving it all began with
      // selecting it a second time.
      //
      // Re-announcing the selection is what closes it: the patch bay closes the
      // arrange panel on any new selection, so a stale arrangement cannot act
      // on the next two things picked.
      Controls.emitSelection(
        Controls.pooledInstances.length === 1 ? Controls.pooledInstances[0] : null,
      );
    },
    /**
     * Abandons the preview and puts every fixture back.
     *
     * @public
     */
    cancel() {
      this.restore();
      this.baseline = null;
      this.dismiss();
    },
  },
};
</script>

<style scoped>
.arrange_tool {
  max-width: 200px;
  min-width: 200px;
}
.arrange_body {
  height: 100%;
  width: 100%;
  padding: 6px;
}
.arrange_count {
  font-size: 0.72rem;
  color: var(--secondary-light-alt);
  align-items: baseline;
}
.arrange_count b {
  color: var(--secondary-lighter-alt);
  font-weight: 500;
}
.arrange_derived {
  font-size: 0.7rem;
  color: var(--secondary-light-alt);
  font-style: italic;
}
/* Dimmed with the fields it describes, so the whole section reads as off
   together rather than leaving a live-looking caption over dead controls. */
.arrange_derived_off {
  opacity: 0.45;
}
.arrange_note {
  font-size: 0.7rem;
  color: var(--secondary-light-alt);
  line-height: 1.4;
  min-height: 1em;
}
</style>

<template>
  <uk-flex
    col
    :gap="8"
    class="object_params"
  >
    <uk-flex :gap="8">
      <uk-select-input
        v-model="groupIndex"
        style="width: 110px"
        label="Type"
        :options="groupLabels"
      />
      <uk-select-input
        v-if="isShape"
        v-model="formIndex"
        style="width: 110px"
        label="Form"
        :options="formLabels"
      />
      <!-- auto-update, because the name decides whether a create is allowed
           and the widget writes it through on every keystroke. Left to emit on
           blur, a warning describes the previous name while the box shows the
           new one. -->
      <uk-txt-input
        v-model="name"
        auto-update
        style="flex: 1"
        label="Name"
      />
      <!-- The dialog's, not the form's: how many to place is a question about
           adding, and the widget that edits a placed object has no answer to
           it. Offered as the end of this row rather than a row of its own so
           the shape's own fields stay together below. -->
      <slot name="row-end" />
    </uk-flex>

    <slot name="warning" />

    <template v-if="isTruss">
      <uk-flex :gap="8">
        <uk-select-input
          v-model="tubesIndex"
          class="object_params_field"
          label="Chords"
          :options="tubeLabels"
        />
        <uk-select-input
          v-if="truss.tubes === 2"
          v-model="ladderIndex"
          class="object_params_field"
          label="Ladder"
          :options="ladderLabels"
        />
        <uk-select-input
          v-model="profileIndex"
          class="object_params_field"
          label="Profile"
          :options="profileLabels"
        />
      </uk-flex>
      <span class="object_params_section">Profile (m)</span>
      <uk-flex :gap="8">
        <uk-num-input
          v-model="trussWidth"
          class="object_params_field"
          label="Width"
          :min="0.05"
          :max="5"
          :precision="3"
        />
        <uk-num-input
          v-model="trussChord"
          class="object_params_field"
          label="Chord ⌀"
          :min="0.01"
          :max="0.5"
          :precision="3"
        />
        <uk-num-input
          v-model="trussBrace"
          class="object_params_field"
          label="Brace ⌀"
          :min="0.004"
          :max="truss.chord"
          :precision="3"
        />
      </uk-flex>
      <span class="object_params_section">Shape</span>
      <uk-flex :gap="8">
        <uk-select-input
          v-model="shapeIndex"
          class="object_params_field"
          label="Run"
          :options="shapeLabels"
        />
        <uk-num-input
          v-if="truss.shape === 'straight'"
          v-model="trussLength"
          class="object_params_field"
          label="Length (m)"
          :min="0.1"
          :max="50"
          :precision="3"
        />
        <uk-num-input
          v-if="truss.shape === 'arc'"
          v-model="trussRadius"
          class="object_params_field"
          label="Radius (m)"
          :min="0.5"
          :max="50"
          :precision="3"
        />
        <uk-num-input
          v-if="truss.shape === 'arc'"
          v-model="trussAngle"
          class="object_params_field"
          label="Angle (°)"
          :min="1"
          :max="360"
          :precision="1"
        />
      </uk-flex>
      <uk-flex :gap="8">
        <uk-select-input
          v-model="plateIndex"
          style="width: 120px"
          label="End plates"
          :options="plateLabels"
        />
        <uk-checkbox
          v-model="trussCross"
          label="Cross members"
        />
      </uk-flex>
    </template>

    <template v-if="isDrape">
      <span class="object_params_section">Track</span>
      <uk-flex :gap="8">
        <uk-select-input
          v-model="drapeShapeIndex"
          class="object_params_field"
          label="Run"
          :options="shapeLabels"
        />
        <uk-num-input
          v-if="drape.shape === 'straight'"
          v-model="drapeWidth"
          class="object_params_field"
          label="Width (m)"
          :min="0.1"
          :max="100"
          :precision="3"
        />
        <uk-num-input
          v-if="drape.shape === 'arc'"
          v-model="drapeRadius"
          class="object_params_field"
          label="Radius (m)"
          :min="0.5"
          :max="100"
          :precision="3"
        />
        <uk-num-input
          v-if="drape.shape === 'arc'"
          v-model="drapeAngle"
          class="object_params_field"
          label="Angle (°)"
          :min="1"
          :max="360"
          :precision="1"
        />
      </uk-flex>
      <span class="object_params_section">Cloth</span>
      <uk-flex :gap="8">
        <uk-num-input
          v-model="drapeDrop"
          class="object_params_field"
          label="Drop (m)"
          :min="0.1"
          :max="50"
          :precision="3"
        />
        <uk-num-input
          v-model="drapeGap"
          class="object_params_field"
          label="Floor gap (m)"
          :min="0"
          :max="50"
          :precision="3"
        />
        <uk-num-input
          v-model="drapeFullness"
          class="object_params_field"
          label="Fullness (%)"
          :min="0"
          :max="200"
          :precision="0"
        />
      </uk-flex>
      <span class="object_params_section">Opening</span>
      <uk-flex :gap="8">
        <uk-select-input
          v-model="openingIndex"
          class="object_params_field"
          label="Panels"
          :options="openingLabels"
        />
        <uk-num-input
          v-model="drapeOpen"
          class="object_params_field"
          label="Open (%)"
          :min="0"
          :max="100"
          :precision="0"
        />
      </uk-flex>
    </template>

    <template v-if="isBarrier">
      <uk-flex :gap="8">
        <uk-select-input
          v-model="barrierKindIndex"
          class="object_params_field"
          label="Kind"
          :options="barrierKindLabels"
        />
        <uk-select-input
          v-if="barrier.kind === 'handrail'"
          v-model="infillIndex"
          class="object_params_field"
          label="Infill"
          :options="infillLabels"
        />
      </uk-flex>
      <span class="object_params_section">Run (m)</span>
      <uk-flex :gap="8">
        <uk-select-input
          v-model="barrierShapeIndex"
          class="object_params_field"
          label="Line"
          :options="shapeLabels"
        />
        <uk-num-input
          v-model="barrierLength"
          class="object_params_field"
          label="Length"
          :min="0.2"
          :max="500"
          :precision="3"
        />
        <uk-num-input
          v-if="barrier.shape === 'arc'"
          v-model="barrierRadius"
          class="object_params_field"
          label="Radius"
          :min="0.5"
          :max="500"
          :precision="3"
        />
      </uk-flex>
      <span class="object_params_section">Section (m)</span>
      <uk-flex :gap="8">
        <uk-num-input
          v-model="barrierSection"
          class="object_params_field"
          label="Length"
          :min="0.2"
          :max="10"
          :precision="3"
        />
        <uk-num-input
          v-model="barrierHeight"
          class="object_params_field"
          label="Height"
          :min="0.2"
          :max="5"
          :precision="3"
        />
        <uk-select-input
          v-model="fitIndex"
          class="object_params_field"
          label="Fit"
          :options="fitLabels"
        />
      </uk-flex>
      <span class="object_params_note">{{ barrierSummary }}</span>
      <uk-checkbox
        v-model="barrierFlip"
        label="Front faces the other way"
      />
    </template>

    <span
      v-if="!isTruss && !isDrape && !isBarrier"
      class="object_params_section"
    >Size (m)</span>
    <uk-flex
      v-if="!isTruss && !isDrape && !isBarrier"
      :gap="8"
    >
      <uk-num-input
        v-if="hasBox"
        v-model="sizeX"
        class="object_params_field"
        :label="type === 'plane' ? 'Width' : 'Length'"
        :min="0.001"
        :max="200"
        :precision="3"
      />
      <uk-num-input
        v-if="hasBox"
        v-model="sizeY"
        class="object_params_field"
        :label="type === 'plane' ? 'Depth' : 'Width'"
        :min="0.001"
        :max="200"
        :precision="3"
      />
      <uk-num-input
        v-if="type === 'cube'"
        v-model="sizeZ"
        class="object_params_field"
        label="Height"
        :min="0.001"
        :max="200"
        :precision="3"
      />
      <uk-num-input
        v-if="hasRadius"
        v-model="radius"
        class="object_params_field"
        :label="type === 'tube' ? 'Outer radius' : 'Radius'"
        :min="0.001"
        :max="100"
        :precision="3"
      />
      <uk-num-input
        v-if="type === 'tube'"
        v-model="thickness"
        class="object_params_field"
        label="Wall"
        :min="0.001"
        :max="100"
        :precision="3"
      />
      <uk-num-input
        v-if="hasArc"
        v-model="height"
        class="object_params_field"
        label="Height"
        :min="0.001"
        :max="200"
        :precision="3"
      />
    </uk-flex>

    <template v-if="hasArc">
      <span class="object_params_section">Arc (°)</span>
      <uk-flex :gap="8">
        <uk-num-input
          v-model="angle"
          class="object_params_field"
          label="Angle"
          :min="1"
          :max="360"
          :precision="1"
        />
      </uk-flex>
    </template>

    <span class="object_params_section">Colour</span>
    <uk-colour-input
      v-model="color"
      aria-label="Object colour"
    />

    <slot />
  </uk-flex>
</template>

<script>
import { PRIMITIVE_TYPES, arcDegrees } from '@/plugins/visualizer/primitive_geometry';
import { TRUSS_PROFILES, PLATE_STYLES, trussSize } from '@/plugins/visualizer/truss_geometry';
import { drapeSize } from '@/plugins/visualizer/drape_geometry';
import {
  BARRIER_KINDS, HANDRAIL_INFILLS, barrierSize, barrierLayout,
} from '@/plugins/visualizer/barrier_geometry';

/**
 * @file The fields that define a created object.
 *
 * One component, two users: the create dialog wraps it with OK and Cancel, and
 * the object modifier widget embeds it live against whatever is selected. They
 * are the same fields by definition -- a created object *is* its parameters --
 * so defining them twice guarantees the two drift apart the first time one
 * gains a field.
 *
 * Holds no state of its own. Everything comes in through `modelValue` and every
 * change goes straight back out, so the widget can write through to the scene
 * on each keystroke while the dialog can hold the value until OK.
 */

/** The shapes this can describe, in the order they are offered. */
export const OBJECT_TYPES = PRIMITIVE_TYPES;
const TYPE_LABELS = ['Cube', 'Cylinder', 'Tube', 'Sphere', 'Plane', 'Truss', 'Drape', 'Barrier'];

const TUBES = [2, 3, 4];
const TUBE_LABELS = ['2, ladder', '3, triangle', '4, box'];
const LADDERS = ['flat', 'upright'];
const LADDER_LABELS = ['Flat', 'Upright'];
const SHAPES = ['straight', 'arc'];
const SHAPE_LABELS = ['Straight', 'Arc'];
const PLATE_LABELS = ['None', 'Square', 'Round'];
const PROFILE_LABELS = [...TRUSS_PROFILES.map((p) => p.name), 'Custom'];
/**
 * The types as the form offers them: the plain shapes together under Shape,
 * picked by Form, and each built kind on its own.
 */
const SHAPE_TYPES = ['cube', 'cylinder', 'tube', 'sphere', 'plane'];
const TYPE_GROUPS = [
  { label: 'Shape', types: SHAPE_TYPES },
  { label: 'Truss', types: ['truss'] },
  { label: 'Drape', types: ['drape'] },
  { label: 'Barrier', types: ['barrier'] },
];
const OPENINGS = ['split', 'single'];
const OPENING_LABELS = ['Split centre', 'Single'];
const BARRIER_KIND_LABELS = BARRIER_KINDS.map((k) => k.label);
const INFILL_LABELS = ['Mid rail', 'Bars', 'Glass', 'Mesh'];
const FITS = ['whole', 'stretch'];
const FIT_LABELS = ['Whole sections', 'Stretch to fit'];

/** A neutral grey, so a new object reads as geometry rather than as a colour. */
export const DEFAULT_OBJECT_COLOR = '#b0b4b8';

/** Black for a drape, as masking is; grey for everything else. */
const DRAPE_COLOR = '#141414';

/**
 * The colour a new shape of this type starts with.
 *
 * @param {String} type
 * @returns {String}
 */
function colorFor(type) {
  return type === 'drape' ? DRAPE_COLOR : DEFAULT_OBJECT_COLOR;
}

/**
 * The parameters a shape of this type is defined by, at their defaults.
 *
 * Only the fields that mean something for the type: storing the others would
 * record numbers the user never saw, and a descriptor read back later could
 * not tell which were chosen and which were left alone.
 *
 * @param {String} type
 * @param {Object} [from] existing size values to carry across a type change
 * @returns {Object}
 */
export function defaultSize(type, from = {}) {
  const take = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  };
  switch (type) {
    case 'cylinder':
      return {
        radius: take(from.radius, 0.5),
        height: take(from.height, 1),
        angle: arcDegrees(from.angle),
      };
    case 'tube':
      return {
        radius: take(from.radius, 0.5),
        thickness: take(from.thickness, 0.05),
        height: take(from.height, 1),
        angle: arcDegrees(from.angle),
      };
    case 'sphere':
      return { radius: take(from.radius, 0.5) };
    case 'truss':
      return trussSize(from);
    case 'drape':
      return drapeSize(from);
    case 'barrier':
      return barrierSize(from);
    case 'plane':
      return { x: take(from.x, 1), y: take(from.y, 1) };
    case 'cube':
    default:
      return { x: take(from.x, 1), y: take(from.y, 1), z: take(from.z, 1) };
  }
}

/**
 * What a shape of this type is called before anybody names it.
 *
 * @param {String} type
 * @returns {String}
 */
function labelFor(type) {
  return TYPE_LABELS[OBJECT_TYPES.indexOf(type)] || TYPE_LABELS[0];
}

/** A whole parameter set for a new object of this type. */
export function defaultParams(type = 'cube') {
  return {
    type,
    name: labelFor(type),
    size: defaultSize(type),
    color: colorFor(type),
  };
}

export default {
  name: 'ObjectParamsForm',
  compatConfig: {
    MODE: 3,
  },
  props: {
    /** `{ type, name, size, color }` */
    modelValue: {
      type: Object,
      required: true,
    },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      groupLabels: TYPE_GROUPS.map((group) => group.label),
      formLabels: SHAPE_TYPES.map(labelFor),
      tubeLabels: TUBE_LABELS,
      ladderLabels: LADDER_LABELS,
      shapeLabels: SHAPE_LABELS,
      plateLabels: PLATE_LABELS,
      profileLabels: PROFILE_LABELS,
      openingLabels: OPENING_LABELS,
      barrierKindLabels: BARRIER_KIND_LABELS,
      infillLabels: INFILL_LABELS,
      fitLabels: FIT_LABELS,
    };
  },
  computed: {
    type() {
      return this.modelValue.type || OBJECT_TYPES[0];
    },
    isTruss() {
      return this.type === 'truss';
    },
    /** The truss fields, complete and in range. */
    truss() {
      return trussSize(this.modelValue.size || {});
    },
    tubesIndex: {
      get() { return Math.max(TUBES.indexOf(this.truss.tubes), 0); },
      set(index) { this.emitTruss({ tubes: TUBES[index] }); },
    },
    ladderIndex: {
      get() { return Math.max(LADDERS.indexOf(this.truss.ladder), 0); },
      set(index) { this.emitTruss({ ladder: LADDERS[index] }); },
    },
    shapeIndex: {
      get() { return Math.max(SHAPES.indexOf(this.truss.shape), 0); },
      set(index) { this.emitTruss({ shape: SHAPES[index] }); },
    },
    /** The standard profile these sizes match, or Custom. */
    profileIndex: {
      get() {
        const { width, chord, brace } = this.truss;
        const near = (a, b) => Math.abs(a - b) < 1e-6;
        const at = TRUSS_PROFILES.findIndex((p) => near(p.width, width)
          && near(p.chord, chord) && near(p.brace, brace));
        return at === -1 ? TRUSS_PROFILES.length : at;
      },
      set(index) {
        const profile = TRUSS_PROFILES[index];
        if (!profile) return;
        this.emitTruss({ width: profile.width, chord: profile.chord, brace: profile.brace });
      },
    },
    trussWidth: {
      get() { return this.truss.width; },
      set(value) { this.emitTruss({ width: value }); },
    },
    trussChord: {
      get() { return this.truss.chord; },
      set(value) { this.emitTruss({ chord: value }); },
    },
    trussBrace: {
      get() { return this.truss.brace; },
      set(value) { this.emitTruss({ brace: value }); },
    },
    trussLength: {
      get() { return this.truss.length; },
      set(value) { this.emitTruss({ length: value }); },
    },
    trussRadius: {
      get() { return this.truss.radius; },
      set(value) { this.emitTruss({ radius: value }); },
    },
    trussAngle: {
      get() { return this.truss.angle; },
      set(value) { this.emitTruss({ angle: value }); },
    },
    trussCross: {
      get() { return this.truss.cross; },
      set(value) { this.emitTruss({ cross: !!value }); },
    },
    plateIndex: {
      get() { return Math.max(PLATE_STYLES.indexOf(this.truss.plates), 0); },
      set(index) { this.emitTruss({ plates: PLATE_STYLES[index] }); },
    },
    isBarrier() {
      return this.type === 'barrier';
    },
    /** The barrier fields, complete and in range. */
    barrier() {
      return barrierSize(this.modelValue.size || {});
    },
    /** How many sections the run takes, and how long it comes out. */
    barrierSummary() {
      const { count, section, run } = barrierLayout(this.barrier);
      const metres = (n) => `${Math.round(n * 1000) / 1000} m`;
      return `${count} section${count === 1 ? '' : 's'} of ${metres(section)}, ${metres(run)} in all`;
    },
    barrierKindIndex: {
      get() { return Math.max(BARRIER_KINDS.findIndex((k) => k.kind === this.barrier.kind), 0); },
      set(index) {
        const kind = BARRIER_KINDS[index];
        if (!kind) return;
        // A new kind starts at its own section length and height.
        this.emitBarrier({ kind: kind.kind, section: kind.section, height: kind.height });
      },
    },
    barrierShapeIndex: {
      get() { return Math.max(SHAPES.indexOf(this.barrier.shape), 0); },
      set(index) { this.emitBarrier({ shape: SHAPES[index] }); },
    },
    fitIndex: {
      get() { return Math.max(FITS.indexOf(this.barrier.fit), 0); },
      set(index) { this.emitBarrier({ fit: FITS[index] }); },
    },
    infillIndex: {
      get() { return Math.max(HANDRAIL_INFILLS.indexOf(this.barrier.infill), 0); },
      set(index) { this.emitBarrier({ infill: HANDRAIL_INFILLS[index] }); },
    },
    barrierLength: {
      get() { return this.barrier.length; },
      set(value) { this.emitBarrier({ length: value }); },
    },
    barrierRadius: {
      get() { return this.barrier.radius; },
      set(value) { this.emitBarrier({ radius: value }); },
    },
    barrierSection: {
      get() { return this.barrier.section; },
      set(value) { this.emitBarrier({ section: value }); },
    },
    barrierHeight: {
      get() { return this.barrier.height; },
      set(value) { this.emitBarrier({ height: value }); },
    },
    barrierFlip: {
      get() { return this.barrier.flip; },
      set(value) { this.emitBarrier({ flip: !!value }); },
    },
    isDrape() {
      return this.type === 'drape';
    },
    /** The drape fields, complete and in range. */
    drape() {
      return drapeSize(this.modelValue.size || {});
    },
    drapeShapeIndex: {
      get() { return Math.max(SHAPES.indexOf(this.drape.shape), 0); },
      set(index) { this.emitDrape({ shape: SHAPES[index] }); },
    },
    openingIndex: {
      get() { return Math.max(OPENINGS.indexOf(this.drape.opening), 0); },
      set(index) { this.emitDrape({ opening: OPENINGS[index] }); },
    },
    drapeWidth: {
      get() { return this.drape.width; },
      set(value) { this.emitDrape({ width: value }); },
    },
    drapeRadius: {
      get() { return this.drape.radius; },
      set(value) { this.emitDrape({ radius: value }); },
    },
    drapeAngle: {
      get() { return this.drape.angle; },
      set(value) { this.emitDrape({ angle: value }); },
    },
    drapeDrop: {
      get() { return this.drape.drop; },
      set(value) { this.emitDrape({ drop: value }); },
    },
    drapeGap: {
      get() { return this.drape.gap; },
      set(value) { this.emitDrape({ gap: value }); },
    },
    drapeFullness: {
      get() { return this.drape.fullness; },
      set(value) { this.emitDrape({ fullness: value }); },
    },
    drapeOpen: {
      get() { return this.drape.open; },
      set(value) { this.emitDrape({ open: value }); },
    },
    hasBox() {
      return this.type === 'cube' || this.type === 'plane';
    },
    hasRadius() {
      return this.hasArc || this.type === 'sphere';
    },
    /** Swept about its axis, so it has a height and an angle. */
    hasArc() {
      return this.type === 'cylinder' || this.type === 'tube';
    },
    /**
     * Whether the name is still the one this type suggested.
     *
     * @type {Boolean}
     */
    nameIsSuggested() {
      const name = (this.modelValue.name || '').trim();
      return !name || name === labelFor(this.type);
    },
    /** Whether this is one of the plain shapes, offered together as Shape. */
    isShape() {
      return SHAPE_TYPES.includes(this.type);
    },
    groupIndex: {
      get() {
        return Math.max(TYPE_GROUPS.findIndex((group) => group.types.includes(this.type)), 0);
      },
      set(index) {
        const group = TYPE_GROUPS[index] || TYPE_GROUPS[0];
        if (!group.types.includes(this.type)) this.changeType(group.types[0]);
      },
    },
    formIndex: {
      get() {
        return Math.max(SHAPE_TYPES.indexOf(this.type), 0);
      },
      set(index) {
        this.changeType(SHAPE_TYPES[index] || SHAPE_TYPES[0]);
      },
    },
    name: {
      get() { return this.modelValue.name || ''; },
      set(value) { this.emit({ name: value }); },
    },
    color: {
      get() { return this.modelValue.color || DEFAULT_OBJECT_COLOR; },
      set(value) { this.emit({ color: value }); },
    },
    sizeX: {
      get() { return this.sizeField('x', 1); },
      set(value) { this.emitSize({ x: value }); },
    },
    sizeY: {
      get() { return this.sizeField('y', 1); },
      set(value) { this.emitSize({ y: value }); },
    },
    sizeZ: {
      get() { return this.sizeField('z', 1); },
      set(value) { this.emitSize({ z: value }); },
    },
    radius: {
      get() { return this.sizeField('radius', 0.5); },
      set(value) { this.emitSize({ radius: value }); },
    },
    height: {
      get() { return this.sizeField('height', 1); },
      set(value) { this.emitSize({ height: value }); },
    },
    thickness: {
      get() { return this.sizeField('thickness', 0.05); },
      set(value) { this.emitSize({ thickness: value }); },
    },
    angle: {
      get() { return arcDegrees((this.modelValue.size || {}).angle); },
      set(value) { this.emitSize({ angle: arcDegrees(value) }); },
    },
  },
  methods: {
    /**
     * Switches the object to another type.
     *
     * @param {String} type
     */
    changeType(type) {
      // Sizes carry across where the two shapes share a field, so switching
      // cube to plane keeps the footprint the user just typed.
      const change = { type, size: defaultSize(type, this.modelValue.size || {}) };
      // The name follows the type for as long as it is still the one the
      // type suggested, so picking Plane does not leave a plane called Cube.
      // Whether it was typed is asked of the value rather than remembered,
      // because this form deliberately holds no state -- and it answers the
      // same for the widget, where a placed object is "Cube 2" rather than
      // "Cube" and so counts as named.
      if (this.nameIsSuggested) change.name = labelFor(type);
      // The colour follows the type the same way, while it is still the one
      // the type started with.
      if ((this.modelValue.color || DEFAULT_OBJECT_COLOR) === colorFor(this.type)) {
        change.color = colorFor(type);
      }
      this.emit(change);
    },
    /**
     * One size value, or its default.
     *
     * @param {String} key
     * @param {Number} fallback
     * @returns {Number}
     */
    sizeField(key, fallback) {
      const value = Number((this.modelValue.size || {})[key]);
      return Number.isFinite(value) ? value : fallback;
    },
    /**
     * Emits the parameters with some fields replaced.
     *
     * A new object every time rather than a mutation: the value may belong to
     * a scene object that is being watched, and editing it in place would
     * change what is on screen without anything being told.
     *
     * @param {Object} changes
     */
    emit(changes) {
      this.$emit('update:modelValue', { ...this.modelValue, ...changes });
    },
    /**
     * Emits the parameters with some size fields replaced.
     *
     * @param {Object} changes
     */
    emitSize(changes) {
      this.emit({ size: { ...(this.modelValue.size || {}), ...changes } });
    },
    /**
     * Emits a truss size with some fields replaced, made complete and in range.
     *
     * @param {Object} changes
     */
    emitTruss(changes) {
      this.emit({ size: trussSize({ ...this.truss, ...changes }) });
    },
    /**
     * Emits a drape size with some fields replaced, made complete and in range.
     *
     * @param {Object} changes
     */
    emitDrape(changes) {
      this.emit({ size: drapeSize({ ...this.drape, ...changes }) });
    },
    /**
     * Emits a barrier size with some fields replaced, made complete and in range.
     *
     * @param {Object} changes
     */
    emitBarrier(changes) {
      this.emit({ size: barrierSize({ ...this.barrier, ...changes }) });
    },
  },
};
</script>

<style scoped>
.object_params {
  /* No padding of its own: the create dialog and the widget each provide their
     own, and a form that pads itself as well is inset twice in one of them. */
  width: 100%;
  white-space: normal;
}

.object_params_section {
  font-family: Roboto-Regular;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--secondary-light-alt);
}

.object_params_note {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-lighter);
}

.object_params_field {
  flex: 1;
}
</style>

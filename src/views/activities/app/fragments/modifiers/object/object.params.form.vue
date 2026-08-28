<template>
  <uk-flex
    col
    :gap="8"
    class="object_params"
  >
    <uk-flex :gap="8">
      <uk-select-input
        v-model="typeIndex"
        style="width: 140px"
        label="Type"
        :options="typeLabels"
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
    </uk-flex>

    <slot name="warning" />

    <span class="object_params_section">Size (m)</span>
    <uk-flex :gap="8">
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
        label="Radius"
        :min="0.001"
        :max="100"
        :precision="3"
      />
      <uk-num-input
        v-if="type === 'cylinder'"
        v-model="height"
        class="object_params_field"
        label="Height"
        :min="0.001"
        :max="200"
        :precision="3"
      />
    </uk-flex>

    <span class="object_params_section">Colour</span>
    <uk-flex
      :gap="8"
      class="object_params_colour"
    >
      <input
        v-model="color"
        type="color"
        class="object_params_swatch"
        aria-label="Object colour"
      >
      <uk-txt-input
        v-model="color"
        auto-update
        style="flex: 1"
        label="Hex"
      />
    </uk-flex>

    <slot />
  </uk-flex>
</template>

<script>
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
export const OBJECT_TYPES = ['cube', 'cylinder', 'sphere', 'plane'];
const TYPE_LABELS = ['Cube', 'Cylinder', 'Sphere', 'Plane'];

/** A neutral grey, so a new object reads as geometry rather than as a colour. */
export const DEFAULT_OBJECT_COLOR = '#b0b4b8';

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
      return { radius: take(from.radius, 0.5), height: take(from.height, 1) };
    case 'sphere':
      return { radius: take(from.radius, 0.5) };
    case 'plane':
      return { x: take(from.x, 1), y: take(from.y, 1) };
    case 'cube':
    default:
      return { x: take(from.x, 1), y: take(from.y, 1), z: take(from.z, 1) };
  }
}

/** A whole parameter set for a new object of this type. */
export function defaultParams(type = 'cube') {
  return {
    type,
    name: TYPE_LABELS[OBJECT_TYPES.indexOf(type)] || TYPE_LABELS[0],
    size: defaultSize(type),
    color: DEFAULT_OBJECT_COLOR,
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
      typeLabels: TYPE_LABELS,
    };
  },
  computed: {
    type() {
      return this.modelValue.type || OBJECT_TYPES[0];
    },
    hasBox() {
      return this.type === 'cube' || this.type === 'plane';
    },
    hasRadius() {
      return this.type === 'cylinder' || this.type === 'sphere';
    },
    typeIndex: {
      get() {
        const at = OBJECT_TYPES.indexOf(this.type);
        return at === -1 ? 0 : at;
      },
      set(index) {
        const type = OBJECT_TYPES[index] || OBJECT_TYPES[0];
        // Sizes carry across where the two shapes share a field, so switching
        // cube to plane keeps the footprint the user just typed.
        this.emit({ type, size: defaultSize(type, this.modelValue.size || {}) });
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
  },
  methods: {
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
  },
};
</script>

<style scoped>
.object_params {
  padding: 8px 0;
}

.object_params_section {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.6;
}

.object_params_colour {
  align-items: flex-end;
}

.object_params_swatch {
  width: 48px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--secondary-darker);
  border-radius: 3px;
  background: none;
  cursor: pointer;
}

.object_params_field {
  flex: 1;
}
</style>

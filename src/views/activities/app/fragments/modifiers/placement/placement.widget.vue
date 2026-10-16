<template>
  <uk-widget
    class="placement_widget position_tool"
    :class="{ position_tool_scaled: scalable }"
    dockable
    :header="{ title, icon: 'move' }"
  >
    <uk-flex
      v-if="fixture"
      col
      class="position_tool_body"
      :gap="8"
    >
      <!-- One row per axis: position, rotation, then size for a model. Every
           field has the same width and every row a button slot, so the
           columns line up whether or not a field has a button. -->
      <div class="position_tool_grid">
        <template
          v-for="axis in axes"
          :key="axis.name"
        >
          <uk-num-input
            class="col_position"
            :model-value="axisValue(axis.position)"
            :disabled="locked"
            :color="axis.color"
            :precision="2"
            :min="-1000"
            :max="1000"
            :label="`Position ${axis.name}`"
            @update:model-value="(value) => setAxis(axis.position, value)"
          />
          <button
            v-if="axis.name === 'Z'"
            type="button"
            class="drop_button col_position_button"
            :disabled="locked"
            title="Drop to ground: stand it on the surface below, or lift it onto one it sits in"
            @click="drop"
          >
            <uk-icon name="drop_floor" />
          </button>
          <span
            v-else
            class="col_position_button"
          />
          <uk-num-input
            class="col_rotation"
            :model-value="axisValue(axis.rotation)"
            :disabled="locked"
            :color="axis.color"
            :precision="1"
            :step="1"
            :min="-360"
            :max="360"
            :label="`Rotation ${axis.name}`"
            @update:model-value="(value) => setAxis(axis.rotation, value)"
          />
          <button
            type="button"
            class="drop_button col_rotation_button"
            :disabled="locked"
            :title="`Turn 180° about ${axis.name}`"
            @click="turn180(axis.rotation)"
          >
            <uk-icon name="turn180" />
          </button>
          <!-- A model from a file is sized along its own axes, in metres. A
               created shape is sized by its own dimensions instead, and a
               fixture keeps its size. -->
          <uk-num-input
            v-if="scalable"
            class="col_size"
            :model-value="axisValue(axis.size)"
            :disabled="locked || !sized"
            :color="axis.color"
            :precision="2"
            :min="0.01"
            :max="1000"
            :label="axis.sizeLabel"
            @update:model-value="(value) => setAxis(axis.size, value)"
          />
        </template>
      </div>
      <uk-flex
        v-if="scalable && sized"
        :gap="8"
        class="position_tool_model"
      >
        <span class="position_tool_note">Model: {{ modelSizeText }}</span>
        <uk-button
          icon="undo"
          label="original size"
          title="Put the model back to its own size"
          :disabled="locked || originalSize"
          @click="restoreSize"
        />
      </uk-flex>
      <p
        v-if="locked"
        class="position_tool_locked"
      >
        {{ lockedNote }}
      </p>
      <p
        v-if="dropNote"
        class="position_tool_locked"
      >
        {{ dropNote }}
      </p>
    </uk-flex>
  </uk-widget>
</template>

<script>
import EventBus from '@/plugins/eventbus';
import Controls from '@/plugins/visualizer/controls';
import dropToGround from '@/plugins/visualizer/drop_to_ground';

/** Axis fields, and which side of the transform each belongs to. */
const AXES = {
  posX: ['position', 'x'],
  posY: ['position', 'y'],
  posZ: ['position', 'z'],
  rotX: ['rotation', 'x'],
  rotY: ['rotation', 'y'],
  rotZ: ['rotation', 'z'],
  sizeX: ['size', 'x'],
  sizeY: ['size', 'y'],
  sizeZ: ['size', 'z'],
};

export default {
  name: 'PlacementWidget',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    /**
     * Handle to the item being placed: a fixture, or a structure.
     */
    fixture: {
      type: Object,
      default: null,
    },
    /**
     * Widget title. "Placement" for whatever single thing is selected -- a
     * fixture, an object, a structure -- because it is the same widget doing
     * the same job for each. Only where two sit side by side does one need a
     * different name: a structure and the member opened inside it.
     */
    title: {
      type: String,
      default: 'Placement',
    },
  },
  data() {
    return {
      /**
       * Bumped whenever the gizmo moves something, purely to make the fields
       * re-read. What a drag changes is not reactive -- the model is not
       * written until the drag ends, and the node that is moving is raw three
       * -- so there is nothing for Vue to track but this.
       */
      liveTick: 0,
      /** Whether a re-read is already queued for the next frame. */
      liveQueued: false,
      /** Why the last drop to ground left something where it was, or ''. */
      dropNote: '',
      /** One row per axis: its position, rotation and size fields. */
      axes: [
        {
          name: 'X',
          position: 'posX',
          rotation: 'rotX',
          size: 'sizeX',
          sizeLabel: 'Length X',
          color: 'var(--axis-x-field)',
        },
        {
          name: 'Y',
          position: 'posY',
          rotation: 'rotY',
          size: 'sizeY',
          sizeLabel: 'Width Y',
          color: 'var(--axis-y-field)',
        },
        {
          name: 'Z',
          position: 'posZ',
          rotation: 'rotZ',
          size: 'sizeZ',
          sizeLabel: 'Height Z',
          color: 'var(--axis-z-field)',
        },
      ],
    };
  },
  computed: {
    ...Object.keys(AXES).reduce((fields, name) => ({
      ...fields,
      /**
       * One axis field. Reads whatever is on screen -- the dragged node while
       * a drag is running, the model otherwise -- and always writes the model.
       */
      [name]: {
        get() {
          // Touched so this recomputes when the gizmo says something moved.
          // eslint-disable-next-line no-unused-expressions
          this.liveTick;
          if (!this.fixture) return 0;
          const [side, axis] = AXES[name];
          const live = Controls.liveTransform(this.fixture);
          if (live && live[side]) return Number(live[side][axis].toFixed(2));
          const value = this.fixture[name];
          return typeof value === 'number' ? Number(value.toFixed(2)) : value;
        },
        set(value) {
          if (this.fixture) this.fixture[name] = value;
        },
      },
    }), {}),
    /**
     * Whether this subject's transform belongs to something else.
     *
     * Asked of the subject rather than worked out here: reading
     * `fixture.structure` would let a *selection* answer "no" by not having
     * one, leaving the multi-item tool editable over members the single-item
     * tool greys out. Both subjects answer `locked`, which is why this widget
     * can be pointed at either.
     *
     * @property {Boolean} locked
     */
    locked() {
      return !!(this.fixture && this.fixture.locked);
    },
    /**
     * Whether the subject scales by axis.
     *
     * @property {Boolean} scalable
     */
    scalable() {
      return !!(this.fixture && this.fixture.isScalable);
    },
    /**
     * The model's own size, once it has loaded.
     *
     * @property {Object|null} modelSize
     */
    modelSize() {
      // eslint-disable-next-line no-unused-expressions
      this.liveTick;
      return this.scalable ? this.fixture.modelSize : null;
    },
    /** Whether the model has loaded, so has a size to show and set. */
    sized() {
      return !!this.modelSize;
    },
    /** The model's own size, as read under the fields. */
    modelSizeText() {
      const s = this.modelSize;
      return s ? `${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)} m` : '';
    },
    /** Whether the model is already at its own size. */
    originalSize() {
      // eslint-disable-next-line no-unused-expressions
      this.liveTick;
      return !!(this.fixture && this.fixture.isOriginalSize);
    },
    /**
     * Why the fields are greyed out, named so it can be acted on.
     *
     * @property {String} lockedNote
     */
    lockedNote() {
      const names = (this.fixture && this.fixture.lockedBy) || [];
      if (!names.length) return '';
      if (names.length === 1) {
        return `Held by ${names[0]}. Move the structure instead.`;
      }
      return `Held by ${names.length} structures. Move those instead.`;
    },
  },
  watch: {
    fixture() {
      this.dropNote = '';
    },
  },
  mounted() {
    EventBus.on('transform_changed', this.queueLiveRead);
  },
  beforeUnmount() {
    EventBus.off('transform_changed', this.queueLiveRead);
  },
  methods: {
    /**
     * Puts the model back to its own size.
     *
     * @public
     */
    restoreSize() {
      if (this.fixture) this.fixture.restoreSize();
    },
    /** @param {String} field an axis field, such as `posX` or `rotZ` */
    axisValue(field) {
      return this[field];
    },
    setAxis(field, value) {
      this[field] = value;
    },
    /**
     * Turns the subject half a turn about one axis, kept within -180 to 180.
     *
     * @public
     * @param {String} field `rotX`, `rotY` or `rotZ`
     */
    turn180(field) {
      if (!this.fixture) return;
      let next = (Number(this[field]) || 0) + 180;
      if (next > 180) next -= 360;
      this[field] = Math.round(next * 10) / 10;
      this.liveTick += 1;
    },
    /**
     * Stands the subject on the ground under it: each item of a selection on
     * its own, a structure as one piece.
     *
     * @public
     */
    drop() {
      if (!this.fixture) return;
      const items = Array.isArray(this.fixture.items) ? this.fixture.items : [this.fixture];
      const { refused } = dropToGround(items);
      if (!refused.length) this.dropNote = '';
      else if (items.length === 1) this.dropNote = refused[0].reason;
      else this.dropNote = `${refused.length} of ${items.length} left where they were: ${refused[0].reason}`;
      this.liveTick += 1;
    },
    /**
     * Schedules one re-read per frame.
     *
     * The gizmo reports every pointer move, which is more often than a number
     * can be read; coalescing to a frame keeps the fields honest without
     * re-rendering the panel dozens of times a second.
     *
     * @public
     */
    queueLiveRead() {
      if (this.liveQueued) return;
      this.liveQueued = true;
      requestAnimationFrame(() => {
        this.liveQueued = false;
        this.liveTick += 1;
      });
    },
  },
};
</script>

<style scoped>
.position_tool {
  max-width: 212px;
  min-width: 212px;
}
.position_tool.position_tool_scaled {
  max-width: 296px;
  min-width: 296px;
}
/* Position and rotation each take a 72 px field and an 18 px button; size,
   shown for a model, is a field alone. The 8 px columns between them stay
   empty, so a field sits 2 px from its own button and 8 px from the next. */
.position_tool_grid {
  display: grid;
  grid-template-columns: 72px 18px 8px 72px 18px;
  column-gap: 2px;
  row-gap: 8px;
  align-items: end;
}
.position_tool_scaled .position_tool_grid {
  grid-template-columns: 72px 18px 8px 72px 18px 8px 72px;
}
.position_tool_grid > .col_position { grid-column: 1; }
.position_tool_grid > .col_position_button { grid-column: 2; }
.position_tool_grid > .col_rotation { grid-column: 4; }
.position_tool_grid > .col_rotation_button { grid-column: 5; }
.position_tool_grid > .col_size { grid-column: 7; }
.position_tool_grid > :deep(.uikit_num_input) {
  width: 72px;
}
.position_tool_grid :deep(.label) {
  white-space: nowrap;
}
.position_tool_body {
  height: 100%;
  width: 100%;
  padding: 6px;
}
.position_tool > :deep(.body) {
  /* The note wraps, and a nowrap ancestor would keep it on one clipped line. */
  white-space: normal;
}
/* As tall as the field beside it. */
.drop_button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 25px;
  padding: 0;
  border: 0;
  background: var(--primary-light, #2a2a2e);
  cursor: pointer;
}
.drop_button:hover:not(:disabled) {
  background: var(--primary-lighter);
}
.drop_button:disabled {
  cursor: default;
  opacity: 0.4;
}
.drop_button :deep(svg) {
  width: 12px;
  height: 12px;
  fill: var(--secondary-lighter);
}
.position_tool_model {
  flex-wrap: wrap;
  align-items: center;
}
.position_tool_note {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-lighter-alt);
  white-space: nowrap;
}
.position_tool_locked {
  font-family: Roboto-Regular;
  font-size: 11px;
  line-height: 1.45;
  color: var(--secondary-lighter-alt);
  margin: 0;
  white-space: normal;
  width: 0;
  min-width: 100%;
}
.empty_text {
  display: flex;
  flex: 1;
  flex-direction: row;
  align-items: center;
  color: var(--secondary-light);
  justify-content: center;
}
</style>

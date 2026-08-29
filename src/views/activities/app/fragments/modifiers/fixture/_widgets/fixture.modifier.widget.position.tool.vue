<template>
  <uk-widget
    class="position_tool"
    dockable
    :header="{ title, icon: 'move' }"
  >
    <uk-flex
      v-if="fixture"
      col
      class="position_tool_body"
      :gap="8"
    >
      <uk-flex :gap="16">
        <uk-flex
          col
          :gap="8"
        >
          <uk-num-input
            v-model="posX"
            :disabled="locked"
            color="var(--axis-x-field)"
            :precision="1"
            :min="-1000"
            :max="1000"
            label="Position X"
          />
          <uk-num-input
            v-model="posY"
            :disabled="locked"
            color="var(--axis-y-field)"
            :precision="1"
            :min="-1000"
            :max="1000"
            label="Position Y"
          />
          <uk-num-input
            v-model="posZ"
            :disabled="locked"
            color="var(--axis-z-field)"
            :precision="1"
            :min="-1000"
            :max="1000"
            label="Position Z"
          />
        </uk-flex>
        <uk-flex
          col
          :gap="8"
        >
          <uk-num-input
            v-model="rotX"
            :disabled="locked"
            color="var(--axis-x-field)"
            :min="-360"
            :max="360"
            label="Rotation X"
          />
          <uk-num-input
            v-model="rotY"
            :disabled="locked"
            color="var(--axis-y-field)"
            :min="-360"
            :max="360"
            label="Rotation Y"
          />
          <uk-num-input
            v-model="rotZ"
            :disabled="locked"
            color="var(--axis-z-field)"
            :min="-360"
            :max="360"
            label="Rotation Z"
          />
        </uk-flex>
      </uk-flex>
      <p
        v-if="locked"
        class="position_tool_locked"
      >
        {{ lockedNote }}
      </p>
    </uk-flex>
  </uk-widget>
</template>

<script>
import EventBus from '@/plugins/eventbus';
import Controls from '@/plugins/visualizer/controls';

/** Axis fields, and which side of the transform each belongs to. */
const AXES = {
  posX: ['position', 'x'],
  posY: ['position', 'y'],
  posZ: ['position', 'z'],
  rotX: ['rotation', 'x'],
  rotY: ['rotation', 'y'],
  rotZ: ['rotation', 'z'],
};

export default {
  name: 'FixtureModifierWidgetPositionTool',
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
     * Widget title. A structure gets its own, so two of these side by side --
     * the structure and one of its members -- say which is which.
     */
    title: {
      type: String,
      default: 'Position Tool',
    },
  },
  data() {
    return {
      /**
       * Widget header data
       */
      header: {
        title: 'Fixture Settings',
        icon: 'move',
      },
      /**
       * Bumped whenever the gizmo moves something, purely to make the fields
       * re-read. What a drag changes is not reactive -- the model is not
       * written until the drag ends, and the node that is moving is raw three
       * -- so there is nothing for Vue to track but this.
       */
      liveTick: 0,
      /** Whether a re-read is already queued for the next frame. */
      liveQueued: false,
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
          if (live) return Number(live[side][axis].toFixed(2));
          return this.fixture[name];
        },
        set(value) {
          if (this.fixture) this.fixture[name] = value;
        },
      },
    }), {}),
    /**
     * Whether this subject's transform belongs to something else.
     *
     * Asked of the subject rather than worked out here. This used to read
     * `fixture.structure`, which only an item with that field can answer -- so
     * a *selection* answered "no" by not having one, and the multi-item tool
     * stayed editable over the very members the single-item tool greys out.
     * Both subjects answer `locked` now, which is the whole reason this widget
     * can be pointed at either.
     *
     * @property {Boolean} locked
     */
    locked() {
      return !!(this.fixture && this.fixture.locked);
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
  mounted() {
    EventBus.on('transform_changed', this.queueLiveRead);
  },
  beforeUnmount() {
    EventBus.off('transform_changed', this.queueLiveRead);
  },
  methods: {
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
  max-width: 170px;
  min-width: 170px;
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

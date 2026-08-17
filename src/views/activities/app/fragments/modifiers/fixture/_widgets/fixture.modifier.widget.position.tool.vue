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
            v-model="fixture.posX"
            :disabled="locked"
            color="var(--axis-x-field)"
            :precision="1"
            :min="-1000"
            :max="1000"
            label="Position X"
          />
          <uk-num-input
            v-model="fixture.posY"
            :disabled="locked"
            color="var(--axis-y-field)"
            :precision="1"
            :min="-1000"
            :max="1000"
            label="Position Y"
          />
          <uk-num-input
            v-model="fixture.posZ"
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
            v-model="fixture.rotX"
            :disabled="locked"
            color="var(--axis-x-field)"
            :min="-360"
            :max="360"
            label="Rotation X"
          />
          <uk-num-input
            v-model="fixture.rotY"
            :disabled="locked"
            color="var(--axis-y-field)"
            :min="-360"
            :max="360"
            label="Rotation Y"
          />
          <uk-num-input
            v-model="fixture.rotZ"
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
        Held by {{ fixture.structure.name }}. Move the structure instead.
      </p>
    </uk-flex>
  </uk-widget>
</template>

<script>
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
    };
  },
  computed: {
    /**
     * Whether this fixture's transform belongs to something else.
     *
     * A structure's members are placed by the structure. Their coordinates are
     * still absolute and still shown -- knowing where a fixture ended up is
     * exactly what this tool is for -- but they are not the user's to type.
     *
     * @property {Boolean} locked
     */
    locked() {
      return !!(this.fixture && this.fixture.structure);
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

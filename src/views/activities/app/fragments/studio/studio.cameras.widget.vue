<template>
  <uk-widget
    class="studio_cameras"
    dockable
    :header="{ title: 'Cameras', icon: 'focus' }"
  >
    <uk-flex
      col
      :gap="8"
      class="studio_cameras_body"
    >
      <uk-flex :gap="4">
        <uk-button
          square
          icon-only
          icon="add"
          label="Add camera"
          @click="addCamera"
        />
      </uk-flex>

      <uk-list
        class="studio_cameras_list"
        :items="items"
        :selected-id="activeCameraId"
        @select="select"
      />

      <p class="studio_cameras_note">
        Live cameras can be switched while recording
      </p>
    </uk-flex>
  </uk-widget>
</template>

<script>
import Studio from '@/models/DMX/studio';

export default {
  name: 'StudioCamerasWidget',
  compatConfig: { MODE: 3 },
  computed: {
    /**
     * The cameras as list rows.
     *
     * `uk-list` renders `name` and keys on `id`, which is the shape the store
     * already holds -- so this is a projection, not a second copy.
     *
     * @returns {Array<Object>}
     */
    items() {
      return Studio.state.cameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
      }));
    },
    /** @returns {String} */
    activeCameraId() {
      return Studio.state.activeCameraId;
    },
  },
  methods: {
    /**
     * Makes a camera live.
     *
     * @public
     * @param {Object} item the selected list row
     */
    select(item) {
      if (item && item.id) Studio.selectCamera(item.id);
    },
    /**
     * Places a new camera.
     *
     * Not built yet -- a camera needs a position and a target as well as a
     * lens, and where those come from (the current view, a click in the scene)
     * is not settled. The button is here so the shape of the widget is right.
     *
     * @public
     */
    addCamera() {
      console.warn('[studio] adding a camera is not implemented yet');
    },
  },
};
</script>

<style scoped>
.studio_cameras {
  max-width: 180px;
  min-width: 180px;
}
.studio_cameras_body {
  /* The widget shell centres its body vertically (`align-items: safe center`),
     which pads a short one top and bottom. Filling the height instead is what
     the other tools do, and it starts the content at the top. */
  height: 100%;
  width: 100%;
  padding: 8px;
  /* The shell sets white-space: nowrap and clips what overflows; prose in here
     has to opt back into wrapping. */
  white-space: normal;
}
.studio_cameras_list {
  /* Takes the space the note does not want, rather than a fixed height:
     min-height lets it shrink below its content so it scrolls instead of
     pushing the note off the bottom. */
  flex: 1;
  min-height: 0;
}
.studio_cameras_note {
  /* Named explicitly: a bare element inherits the document default, which is a
     serif. Every other widget here states the face for the same reason. */
  font-family: Roboto-Regular;
  font-size: 11px;
  line-height: 1.45;
  color: var(--secondary-lighter);
  margin: 0;
  /* Wraps to the widget's width rather than setting it. */
  width: 0;
  min-width: 100%;
}
</style>

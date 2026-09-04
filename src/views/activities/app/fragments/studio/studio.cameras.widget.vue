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
        <uk-button
          square
          icon-only
          icon="trash"
          label="Delete camera"
          :disabled="!canDelete"
          @click="deleteCamera"
        />
      </uk-flex>

      <uk-list
        class="studio_cameras_list"
        :items="items"
        :selected-id="selectedCameraId"
        @select="select"
      />

      <uk-num-input
        v-model="transitionSeconds"
        label="Fly seconds"
        :precision="1"
        :min="0.1"
        :max="20"
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
      // `cut` and `fly` per row rather than a mode set beforehand: live, the
      // choice of how to arrive belongs to the moment you go, and a mode is
      // invisible by the time it matters.
      return Studio.state.cameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
        actions: [
          // cut and fly are not offered for the camera already live: there is
          // nowhere to travel from and nothing to cut to. The padlock is, since
          // locking the camera you are looking through is the common case --
          // frame the shot, lock it, then keep looking around.
          ...(camera.id === Studio.state.activeCameraId ? [] : [
            { label: 'cut', callback: () => Studio.cutToCamera(camera.id) },
            { label: 'fly', callback: () => Studio.flyToCamera(camera.id) },
          ]),
          {
            icon: camera.locked ? 'lock' : 'lock_open',
            active: camera.locked,
            callback: () => Studio.toggleCameraLock(camera.id),
          },
        ],
      }));
    },
    /** @returns {String} */
    activeCameraId() {
      return Studio.state.activeCameraId;
    },
    /** @returns {String} which camera the details widget is editing */
    selectedCameraId() {
      return Studio.state.selectedCameraId;
    },
    /** @returns {Number} how long a fly takes */
    transitionSeconds: {
      get() { return Studio.state.transition.seconds; },
      set(value) { Studio.setTransitionSeconds(value); },
    },
    /**
     * Whether the selected camera can be deleted.
     *
     * The editor camera cannot: it is the view itself rather than a stored
     * one, and it is where deleting a live camera falls back to.
     *
     * @returns {Boolean}
     */
    canDelete() {
      return this.selectedCameraId !== Studio.SCENE_CAMERA_ID;
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
     * Places a camera where the view is now.
     *
     * The viewport is the viewfinder: fly to the shot and keep it. That is
     * where the position, the look-at point and the lens all come from, so
     * there is nothing to set up and nothing that can disagree with what is on
     * screen. The new camera becomes live and can be renamed in the camera
     * widget beside this one.
     *
     * @public
     */
    addCamera() {
      const handle = this.$show.visualizerHandle;
      if (!handle) return;
      Studio.addCamera({ ...handle.viewpoint, fov: handle.camera.fov });
      // Cameras are show data but live outside the proxy that notices edits.
      this.$show.touch();
    },
    /**
     * Removes the selected camera.
     *
     * No confirmation: a camera is five numbers and placing another takes one
     * click from the view it described, which is a cheaper undo than a dialog
     * on every delete.
     *
     * @public
     */
    deleteCamera() {
      if (!this.canDelete) return;
      Studio.removeCamera(this.selectedCameraId);
      this.$show.touch();
    },
  },
};
</script>

<style scoped>
.studio_cameras {
  /* Wider than the other studio widgets on purpose. Every row carries a name
     plus cut, fly and a padlock, and at the 180px the rest of them use the
     name was squeezed into what the buttons left over. The buttons are a fixed
     cost, so the extra width all goes to the name. */
  max-width: 280px;
  min-width: 280px;
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

<template>
  <uk-widget
    class="studio_camera"
    dockable
    :header="{ title: 'Camera', icon: 'adjust' }"
  >
    <uk-flex
      col
      :gap="8"
      class="studio_camera_body"
    >
      <uk-txt-input
        v-model.lazy="name"
        label="Name"
      />

      <!-- Metres, and coloured per axis like every other position tool here.
           These track the view as it is orbited rather than being a separate
           saved value: the live camera *is* the view. -->
      <uk-num-input
        v-model="x"
        color="var(--axis-x-field)"
        label="Position X"
        :precision="2"
        :min="-1000"
        :max="1000"
      />
      <uk-num-input
        v-model="y"
        color="var(--axis-y-field)"
        label="Position Y"
        :precision="2"
        :min="-1000"
        :max="1000"
      />
      <uk-num-input
        v-model="z"
        color="var(--axis-z-field)"
        label="Position Z"
        :precision="2"
        :min="-1000"
        :max="1000"
      />

      <!-- Not disabled while recording. Changing the lens mid-take is a shot,
           not a mistake -- unlike the frame size, which cannot change once the
           encoder has been told what it is receiving. -->
      <uk-num-input
        v-model="fov"
        label="FOV °"
        :precision="0"
        :min="LIMITS.minFov"
        :max="LIMITS.maxFov"
      />

      <p class="studio_camera_note">
        {{ hint }}
      </p>
    </uk-flex>
  </uk-widget>
</template>

<script>
import Studio from '@/models/DMX/studio';

/**
 * Roughly what a FOV corresponds to on a 35 mm still camera.
 *
 * Degrees mean little on their own; a focal length is the unit anyone framing a
 * shot already thinks in. Vertical FOV against a 24 mm frame height.
 *
 * @param {Number} fov degrees
 * @returns {Number} millimetres, rounded
 */
function focalLength(fov) {
  return Math.round(12 / Math.tan((fov * Math.PI) / 360));
}

export default {
  name: 'StudioCameraWidget',
  compatConfig: { MODE: 3 },
  data() {
    return { LIMITS: Studio.LIMITS };
  },
  computed: {
    /** @returns {Object} the camera being edited; never null */
    camera() {
      return Studio.selectedCamera;
    },
    name: {
      /** @returns {String} */
      get() { return this.camera.name; },
      set(value) { Studio.setSelectedName(value); },
    },
    x: {
      /** @returns {Number} */
      get() { return this.camera.position.x; },
      set(value) { this.moveTo('x', value); },
    },
    y: {
      /** @returns {Number} */
      get() { return this.camera.position.y; },
      set(value) { this.moveTo('y', value); },
    },
    z: {
      /** @returns {Number} */
      get() { return this.camera.position.z; },
      set(value) { this.moveTo('z', value); },
    },
    fov: {
      /** @returns {Number} */
      get() { return this.camera.fov; },
      set(value) { Studio.setSelectedFov(value); },
    },
    /** @returns {String} */
    hint() {
      return `About a ${focalLength(this.fov)} mm lens.`;
    },
  },
  methods: {
    /**
     * Moves the live camera along one axis.
     *
     * Writes the store *and* the view, in that order. The view is polled back
     * into the store ten times a second while a camera is live, so a value that
     * only reached the store would be overwritten by the unchanged view within
     * a tick -- the field would spring back and look broken.
     *
     * @public
     * @param {String} axis 'x', 'y' or 'z'
     * @param {Number} value metres
     */
    moveTo(axis, value) {
      Studio.setSelectedPosition(axis, value);
      // Only push the view when the camera being edited is the one on screen.
      // Typing a position for a camera you are not looking through must move
      // that camera, not the viewport.
      if (!Studio.editingLive) return;
      const handle = this.$show.visualizerHandle;
      if (handle) handle.viewpoint = Studio.viewpointOf(Studio.state.activeCameraId);
    },
  },
};
</script>

<style scoped>
.studio_camera {
  max-width: 180px;
  min-width: 180px;
}
.studio_camera_body {
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
.studio_camera_note {
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

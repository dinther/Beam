<template>
  <uk-flex class="studio">
    <studio-recording-widget />
    <studio-cameras-widget />
    <studio-camera-widget />
  </uk-flex>
</template>

<script>
/**
 * The studio's controls, in the widget bar.
 *
 * Studio mode replaces the modifier widgets rather than joining them: the
 * modifiers act on a selection, and a recording has no selection -- starting
 * one clears it and hides the gizmo that would edit it.
 */
import StudioRecordingWidget from './studio.recording.widget.vue';
import StudioCamerasWidget from './studio.cameras.widget.vue';
import StudioCameraWidget from './studio.camera.widget.vue';

export default {
  name: 'StudioFragment',
  components: {
    StudioRecordingWidget,
    StudioCamerasWidget,
    StudioCameraWidget,
  },
  compatConfig: { MODE: 3 },
};
</script>

<style scoped>
.studio {
  height: 100%;
}
</style>

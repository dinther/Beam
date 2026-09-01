<template>
  <uk-widget
    class="studio_recording"
    dockable
    :header="{ title: 'Recording', icon: 'goborotation' }"
  >
    <uk-flex
      col
      :gap="8"
      class="studio_recording_body"
    >
      <uk-select-input
        v-model="presetIndex"
        label="Resolution"
        placeholder="Custom"
        :options="presetLabels"
        :disabled="recording"
      />

      <uk-flex :gap="6">
        <uk-num-input
          v-model="width"
          label="Width"
          :precision="0"
          :min="LIMITS.minSize"
          :max="LIMITS.maxSize"
          :disabled="recording"
        />
        <uk-num-input
          v-model="height"
          label="Height"
          :precision="0"
          :min="LIMITS.minSize"
          :max="LIMITS.maxSize"
          :disabled="recording"
        />
      </uk-flex>

      <uk-button
        :key="`portrait-${portrait}`"
        square
        :label="portrait ? 'Portrait' : 'Landscape'"
        :value="false"
        toggleable
        :model-value="portrait"
        :disabled="recording"
        color="var(--accent-blue)"
        @click="setPortrait"
      />

      <uk-flex :gap="6">
        <uk-select-input
          v-model="rateIndex"
          label="Encoding"
          :options="rateLabels"
          :disabled="recording"
        />
        <uk-select-input
          v-model="qualityIndex"
          label="Quality"
          :options="qualityLabels"
          :disabled="recording"
        />
      </uk-flex>

      <p class="studio_recording_note">
        {{ encodingHint }}
      </p>

      <uk-button
        square
        :label="recording ? `Stop ${clock}` : 'Record'"
        :disabled="busy || !canRecord"
        :color="recording ? 'var(--accent-maroon)' : undefined"
        @click="toggle"
      />

      <uk-button
        square
        label="Show in folder"
        :disabled="!finishedPath || recording"
        @click="reveal"
      />

      <p
        v-if="message.text"
        class="studio_recording_note"
        :class="{ studio_recording_error: message.error }"
      >
        {{ message.text }}
      </p>
    </uk-flex>
  </uk-widget>
</template>

<script>
import { toRaw } from 'vue';
import Recorder from '@/plugins/visualizer/recorder';
import Studio from '@/models/DMX/studio';

/**
 * Bytes as something readable.
 *
 * @param {Number} bytes
 * @returns {String}
 */
function readableSize(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export default {
  name: 'StudioRecordingWidget',
  compatConfig: { MODE: 3 },
  data() {
    return {
      LIMITS: Studio.LIMITS,
      rates: Recorder.FRAME_RATES,
      qualities: Object.keys(Recorder.QUALITY),
      /** The take in flight, or null. */
      take: null,
      /** True across the async start and stop, so the button cannot double-fire. */
      busy: false,
      elapsed: 0,
      bytes: 0,
      tickHandle: null,
      /** Where the last finished take landed, for the reveal button. */
      finishedPath: null,
      message: { text: '', error: false },
      canRecord: true,
    };
  },
  computed: {
    /**
     * Frame width and height, held in the studio store rather than here.
     *
     * The canvas letterboxes from the same numbers, so a local copy would be a
     * second version of the frame that only this widget knew about.
     */
    width: {
      get() { return Studio.state.frame.width; },
      set(value) { Studio.setFrame(value, Studio.state.frame.height); },
    },
    height: {
      get() { return Studio.state.frame.height; },
      set(value) { Studio.setFrame(Studio.state.frame.width, value); },
    },
    /**
     * Which preset the current frame is, whichever way up it is turned.
     *
     * -1 when it matches none, which shows the "Custom" placeholder rather than
     * naming a preset the frame is not.
     */
    presetIndex: {
      get() {
        const { width, height } = Studio.state.frame;
        const long = Math.max(width, height);
        const short = Math.min(width, height);
        return Studio.PRESETS.findIndex(
          (preset) => preset.width === long && preset.height === short,
        );
      },
      set(index) {
        const preset = Studio.PRESETS[index];
        if (!preset) return;
        // Applied the way round the frame already is, so choosing a size does
        // not silently undo the orientation.
        const wasPortrait = Studio.portrait;
        Studio.setFrame(preset.width, preset.height);
        Studio.setPortrait(wasPortrait);
      },
    },
    rateIndex: {
      get() { return Math.max(0, this.rates.indexOf(Studio.state.fps)); },
      set(index) { Studio.state.fps = this.rates[index] || 30; },
    },
    qualityIndex: {
      get() { return Math.max(0, this.qualities.indexOf(Studio.state.quality)); },
      set(index) { Studio.state.quality = this.qualities[index] || 'medium'; },
    },
    /** @returns {Boolean} */
    portrait() {
      return Studio.portrait;
    },
    /** @returns {Boolean} */
    recording() {
      return Studio.state.recording;
    },
    /** @returns {Array<String>} */
    presetLabels() {
      return Studio.PRESETS.map((preset) => preset.label);
    },
    /** @returns {Array<String>} */
    rateLabels() {
      return this.rates.map((rate) => `${rate} fps`);
    },
    /** @returns {Array<String>} */
    qualityLabels() {
      return this.qualities.map((key) => Recorder.QUALITY[key].label);
    },
    /**
     * The bitrate and the size it implies.
     *
     * Shown rather than hidden because quality is otherwise four words with no
     * consequence attached, and a take that runs until it is stopped is the one
     * thing here that can fill a disk.
     *
     * @returns {String}
     */
    encodingHint() {
      const { fps, quality } = Studio.state;
      const bits = Recorder.bitrateFor(this.width, this.height, fps, quality);
      return `${(bits / 1000000).toFixed(1)} Mbit/s, about `
        + `${readableSize((bits / 8) * 60)} a minute`;
    },
    /** @returns {String} elapsed time as m:ss, counting past an hour */
    clock() {
      const seconds = String(this.elapsed % 60).padStart(2, '0');
      const minutes = Math.floor(this.elapsed / 60);
      if (minutes < 60) return `${minutes}:${seconds}`;
      return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
    },
    /** @returns {Object|null} */
    visualizer() {
      return this.$show.visualizerHandle || null;
    },
    /**
     * Whether studio mode is on.
     *
     * A computed rather than a watched path into the store: a string watch
     * resolves against the component instance, and the store is a module.
     *
     * @returns {Boolean}
     */
    studioActive() {
      return Studio.state.active;
    },
  },
  watch: {
    /**
     * Leaving studio mode stops the take.
     *
     * The widget is unmounted with the mode, so without this a recording would
     * lose its only stop button. `beforeUnmount` is the backstop; this is what
     * runs first and gets to close the file in an orderly way.
     *
     * @param {Boolean} value
     */
    studioActive(value) {
      if (!value && this.take) this.stop();
    },
  },
  mounted() {
    if (!Recorder.pickMimeType()) {
      this.canRecord = false;
      this.message = { text: 'This build cannot record video', error: true };
    }
  },
  beforeUnmount() {
    if (this.take) this.stop();
    clearInterval(this.tickHandle);
  },
  methods: {
    /**
     * @public
     * @param {Boolean} value whether the frame should stand up
     */
    setPortrait(value) {
      Studio.setPortrait(value);
    },
    /**
     * @public
     */
    toggle() {
      if (this.recording) this.stop();
      else this.start();
    },
    /**
     * @public
     * @async
     */
    async start() {
      if (this.busy || this.take || !this.visualizer) return;
      this.busy = true;
      this.finishedPath = null;
      this.message = { text: '', error: false };

      // Clears the selection and hides grid, axes and gizmos. Before the
      // encoder starts, so the very first frame is already clean.
      this.visualizer.setRecordingMode(true);
      await this.$nextTick();

      const take = new Recorder.Recording({
        // Unwrapped deliberately. The visualizer is reached through a reactive
        // handle, and a native method called on a proxied receiver throws
        // "Illegal invocation" -- `captureStream` is exactly that.
        canvas: toRaw(this.visualizer).domElement,
        fps: Studio.state.fps,
        quality: Studio.state.quality,
        name: this.$show.documentTitle,
      });
      const started = await take.start();
      if (!started.ok) {
        this.visualizer.setRecordingMode(false);
        this.busy = false;
        this.message = { text: started.error, error: true };
        return;
      }

      this.take = take;
      Studio.state.recording = true;
      this.busy = false;
      this.elapsed = 0;
      this.bytes = 0;
      this.tickHandle = setInterval(() => {
        this.elapsed = take.elapsed;
        this.bytes = take.bytes;
        this.message = { text: readableSize(take.bytes), error: false };
        // An encoder that fails mid-take used to leave the button lit forever.
        if (take.error) this.stop();
      }, 500);
    },
    /**
     * @public
     * @async
     */
    async stop() {
      if (this.busy || !this.take) return;
      this.busy = true;
      clearInterval(this.tickHandle);
      this.tickHandle = null;

      const { take } = this;
      this.take = null;
      Studio.state.recording = false;
      const result = await take.stop();

      if (this.visualizer) this.visualizer.setRecordingMode(false);
      this.busy = false;
      if (!result.ok) {
        this.message = { text: result.error, error: true };
        return;
      }
      this.finishedPath = result.path;
      this.message = { text: `Saved ${readableSize(result.bytes)}`, error: false };
    },
    /**
     * Opens the last finished take in Explorer.
     *
     * @public
     */
    reveal() {
      if (this.finishedPath) window.videoRecorder.reveal(this.finishedPath);
    },
  },
};
</script>

<style scoped>
.studio_recording {
  max-width: 200px;
  min-width: 200px;
}
.studio_recording_body {
  /* The widget shell centres its body vertically (`align-items: safe center`),
     which pads a short one top and bottom. Filling the height instead is what
     the other tools do, and it starts the content at the top. */
  height: 100%;
  width: 100%;
  padding: 8px;
  /* The shell sets white-space: nowrap for its single-line rows, and clips what
     overflows. Prose in here has to opt back into wrapping. */
  white-space: normal;
}
.studio_recording_note {
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
.studio_recording_error {
  color: var(--accent-red);
}
</style>

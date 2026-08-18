<template>
  <uk-popup
    v-model="state"
    backdrop
    opaque
    :movable="false"
    no-header
    no-validation
    class="splash_popup"
    :header="headerData"
    @input="update()"
  >
    <div
      class="splash_popup_body"
      :class="{ dismissable }"
      @click="dismiss"
    >
      <img
        class="splash_art"
        src="@/assets/images/beam_splash.webp"
        alt="Beatline Beam"
      >
      <div class="splash_scrim" />

      <div class="build_info">
        <div class="build_column">
          <p>
            Version:&nbsp;<a
              target="_blank"
              :href="
                versionData.version
                  ? `https://github.com/dinther/Beam/releases/tag/${versionData.version}`
                  : 'https://github.com/dinther/Beam/releases/'
              "
            >{{ versionData.version || 'no-version-data' }}</a>
          </p>
          <p>Build date: {{ versionData.date || 'no-build-date' }}</p>
          <p>
            Branch:&nbsp;<a
              target="_blank"
              :href="
                versionData.branch
                  ? `https://github.com/dinther/Beam/tree/${versionData.branch}`
                  : 'https://github.com/dinther/Beam/'
              "
            >{{ versionData.branch || 'no-branch-data' }}</a>
          </p>
        </div>
        <div class="build_column build_column_end">
          <p>
            Copyright ©&nbsp;<a
              target="_blank"
              href="https://github.com/dinther"
            >Paul van Dinther</a>&nbsp;{{ new Date().getFullYear() }}
          </p>
          <p class="provenance">
            Based on&nbsp;<a
              target="_blank"
              href="https://github.com/ASLS-org/studio"
            >ASLS Studio</a>&nbsp;© ASLS-org 2021
          </p>
          <p>
            Released under the&nbsp;<a
              href="/COPYING"
              target="_blank"
            >GPLv3 License</a>
          </p>
        </div>
      </div>

      <!-- Opened from the About menu there is nothing loading, so the bar
           would sit at whatever the last load left behind. The hint takes its
           place, in the same strip. -->
      <div
        v-if="dismissable"
        class="dismiss_hint"
      >
        <p>Click anywhere to close</p>
      </div>
      <div
        v-else
        class="loading_bar_container"
      >
        <div class="loading_bar_unloaded" />
        <div
          :style="{ width: `${loader.percentage}%` }"
          class="loading_bar_loaded"
        />
        <p class="loader_message">
          {{ loader.message }}...
        </p>
      </div>
    </div>
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';

export default {
  name: 'UkPopupSplash',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  mixins: [PopupMixin],
  props: {
    /**
     * Splashscreen loading state
     */
    loader: {
      type: Object,
      default() {
        return {
          message: 'Loading Showfile',
          percentage: 10,
        };
      },
    },
    /**
     * Whether a click closes it.
     *
     * Only when it is being shown on purpose. During a load the splash is the
     * app saying wait, and dismissing it would leave the user looking at a
     * half-built window.
     */
    dismissable: Boolean,
  },
  data() {
    return {
      headerData: { title: 'Splash Screen' },
      versionData: {
        branch: import.meta.env.VITE_APP_BRANCH,
        version: import.meta.env.VITE_APP_VERSION,
        date: import.meta.env.VITE_APP_BUILD_DATE,
      },
    };
  },
  methods: {
    /**
     * Closes the splash, if it is the kind that closes.
     *
     * @public
     */
    dismiss() {
      if (this.dismissable) this.close();
    },
  },
};
</script>

<style scoped>
/*
 * The artwork is the splash. It carries the mark and both wordmarks itself, so
 * nothing is drawn over the middle of it -- no logo, no title, no gradient and
 * no grain. Square, because the art is square and cropping it to a letterbox
 * would cut the beams that make it work.
 */
.splash_popup {
  height: 560px;
  width: 560px;
  border-radius: 0px;
  border: unset !important;
}
.splash_popup_body {
  position: relative;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: #000;
  border: unset !important;
}
.splash_art {
  position: absolute;
  inset: 0;
  height: 100%;
  width: 100%;
  object-fit: cover;
  /* The art is 1254px square; letting it draw larger than it is would soften
     the neon, which is the one thing worth keeping crisp. */
  image-rendering: auto;
}
/*
 * The floor reflection at the bottom is the busiest part of the picture, and
 * the build text sits over it. This darkens that band enough to read against
 * without putting a hard-edged panel over the artwork.
 */
.splash_scrim {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 190px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.92) 40%, rgba(0, 0, 0, 0));
  pointer-events: none;
}

.build_info {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 30px;
  padding: 0 24px;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 24px;
}
.build_column {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.build_column_end {
  text-align: right;
}
.build_info p {
  font-family: roboto-regular;
  font-size: 11px;
  line-height: 1.35;
  margin: 0;
  color: #ffffff;
  opacity: .78;
}
.build_info .provenance {
  opacity: .58;
  font-size: 10px;
}
.build_info a {
  color: inherit !important;
  opacity: .7;
}

.loading_bar_container {
  position: absolute;
  bottom: 0px;
  left: 0px;
  height: 18px;
  width: 100%;
}
.loading_bar_unloaded {
  position: absolute;
  bottom: 0px;
  left: 0px;
  height: 18px;
  width: 100%;
  background: rgba(255, 255, 255, 0.1);
}
/*
 * The green of the mark and the BEATLINE wordmark, so the one moving thing on
 * screen belongs to the picture behind it rather than arriving from the app's
 * own palette.
 */
.loading_bar_loaded {
  position: absolute;
  bottom: 0px;
  left: 0px;
  height: 18px;
  width: 0%;
  background: linear-gradient(90deg, #4bd66b 0%, #8dff7a 100%);
  transition: width 0.5s;
  opacity: .85;
}
.dismissable {
  cursor: pointer;
}
.dismiss_hint {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 18px;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dismiss_hint p {
  margin: 0;
  font-family: roboto-regular;
  font-size: 11px;
  color: #ffffff;
  opacity: .45;
  letter-spacing: 0.04em;
}
.loader_message {
  position: absolute;
  bottom: 1px;
  left: 10px;
  margin: 0;
  mix-blend-mode: difference;
  opacity: .8;
  color: white;
  font-family: roboto-regular;
  font-size: 12px;
}
</style>

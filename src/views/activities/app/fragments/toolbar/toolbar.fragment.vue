<template>
  <uk-flex
    tabindex="0"
    center-v
    class="navigation_header"
  >
    <uk-menu :menus="menus" />
    <uk-spacer />
    <p>{{ saveState ? "" : "*" }} {{ project }}</p>
    <uk-spacer />

    <visualizer-popup v-model="visualizerPopupState" />
    <license-popup v-model="licensePopupState" />
    <credits-popup v-model="creditsPopupState" />
    <newshow-popup v-model="newProjectPopupState" />
    <saveas-popup v-model="saveasPopupState" />
    <artnet-popup v-model="artnetPopupState" />
    <madmapper-popup v-model="madmapperPopupState" />
  </uk-flex>
</template>

<script>
import EventBus from '@/plugins/eventbus';
import VisualizerPopup from './_popups/popup.visualizer.vue';
import LicensePopup from './_popups/popup.license.vue';
import CreditsPopup from './_popups/popup.credits.vue';
import NewshowPopup from './_popups/popup.newshow.vue';
import SaveasPopup from './_popups/popup.saveas.vue';
import ArtnetPopup from './_popups/popup.artnet.vue';
import MadmapperPopup from './_popups/popup.madmapper.vue';

export default {
  name: 'ToolbarFragment',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  components: {
    VisualizerPopup,
    LicensePopup,
    CreditsPopup,
    NewshowPopup,
    SaveasPopup,
    ArtnetPopup,
    MadmapperPopup,
  },
  data() {
    return {
      /**
       * Current show project naem
       * @todo, change name/use show handle directly ?
       */
      project: this.$show.name,
      /**
       * Current show savestate
       */
      saveState: true,
      /**
       * Art-Net settings popup state
       */
      artnetPopupState: false,
      /**
       * MadMapper layout export popup state
       */
      madmapperPopupState: false,
      /**
       * New project popup state
       */
      newProjectPopupState: false,
      /**
       * Visualizer popup state
       */
      visualizerPopupState: false,
      /**
       * License popup state
       */
      licensePopupState: false,
      /**
       * Credits popup state
       */
      creditsPopupState: false,
      /**
       * Save as popup state
       */
      saveasPopupState: false,
      /**
       * I/O popup state
       */
      /**
       * Toolbarmenu configuration object
       */
      menus: [
        {
          name: 'File',
          selected: false,
          items: [
            {
              name: 'New Showfile',
              icon: 'newfile',
              shortcut: 'Shift+N',
              callback: () => {
                this.displayNewProjectPopup();
              },
            },
            {
              name: 'Load Showfile',
              icon: 'folder',
              shortcut: 'Ctrl+O',
              callback: () => {
                this.loadFile();
              },
            },
            {
              name: 'Save Showfile',
              shortcut: 'Ctrl+S',
              icon: 'save',
              callback: () => {
                this.saveShow();
              },
            },
            {
              name: 'Export Showfile',
              shortcut: 'Ctrl+Shift+S',
              icon: 'export',
              callback: () => {
                this.saveasPopupState = true;
              },
            },
            {
              name: 'Export MadMapper Layout',
              icon: 'export',
              callback: () => {
                this.madmapperPopupState = true;
              },
            },
          ],
        },
        {
          name: 'Edit',
          selected: false,
          items: [
            {
              name: 'Undo',
              shortcut: 'Ctrl+Z',
              icon: 'undo',
              callback: () => {
                this.$show.undo();
              },
            },
            {
              name: 'Redo',
              shortcut: 'Ctrl+Y',
              icon: 'redo',
              callback: () => {
                this.$show.redo();
              },
            },
          ],
        },
        {
          name: 'Preferences',
          selected: false,
          items: [
            {
              name: 'Visualizer',
              shortcut: 'Ctrl+Shift+V',
              icon: 'visualizer',
              callback: () => {
                this.displayVisualizerPopup();
              },
            },
            {
              name: 'Art-Net',
              shortcut: 'Ctrl+Shift+A',
              icon: 'zoom',
              callback: () => {
                this.artnetPopupState = true;
              },
            },
          ],
        },
        {
          name: 'About',
          selected: false,
          items: [
            {
              name: 'Manual',
              icon: 'help',
              callback: () => {
                window.open('https://studio.asls.timekadel.com/', '_blank');
              },
            },
            {
              name: 'License',
              icon: 'key',
              callback: () => {
                this.displayLicensePopup();
              },
            },
            {
              name: 'Credits',
              icon: 'opensource',
              callback: () => {
                this.displayCreditsPopup();
              },
            },
            {
              name: 'Contact',
              icon: 'contact',
              callback: () => {
                window.open('https://github.com/timekadel', '_blank');
              },
            },
          ],
        },
      ],
    };
  },
  mounted() {
    this.$show.on('saveState', (state) => {
      this.saveState = state;
    });
    EventBus.on('app_ready', () => {
      this.project = this.$show.name;
    });
  },
  methods: {
    /**
     * Load showfile from native file loader
     *
     * @public
     * @async
     */
    async loadFile() {
      const el = document.createElement('input');
      el.type = 'file';
      el.accept = '.asls,.json,';
      el.style.display = 'none';
      el.addEventListener('change', async () => {
        if (el.files) {
          try {
            this.$router.push('/');
            await this.$show.loadFromFile(el.files[0]);
            // Yeah it sucks... But cleaning up everything from the view was a nightmare so for now:
            window.location.reload();
          } catch (err) {
            EventBus.emit('app_error', err);
          }
        }
        document.body.removeChild(el);
      });
      document.body.appendChild(el);
      el.click();
    },
    /**
     * Saves the show to the application's show file.
     *
     * @public
     */
    saveShow() {
      this.$show.persistLocally();
    },
    /**
     * Display visualizer popup
     *
     * @public
     */
    displayVisualizerPopup() {
      this.visualizerPopupState = true;
    },
    /**
     * Display new project popup
     *
     * @public
     */
    displayNewProjectPopup() {
      this.newProjectPopupState = true;
    },
    /**
     * Display license popup
     *
     * @public
     */
    displayLicensePopup() {
      this.licensePopupState = true;
    },
    /**
     * Display credits popup
     *
     * @public
     */
    displayCreditsPopup() {
      this.creditsPopupState = true;
    },
  },
};
</script>

<style scoped>
.navigation_header {
  min-height: 40px;
  width: 100%;
  background: var(--primary-light);
  border-bottom: 1px solid var(--primary-dark);
  z-index: 20;
}
.header_menu,
.bpm_container,
.tap_container,
.state_container {
  height: 100%;
  padding: 0 16px;
  border-left: 1px solid var(--primary-dark);
}
.state_container{
  width: 100px;
  min-width: 100px;
  max-width: 100px;
}
.tap_container:active, .state_container:active{
  background: var(--secondary-dark) !important;
}
.tap_container:hover, .state_container:hover {
  background: var(--secondary-darker);
  cursor: pointer;
}
.colored_dot {
  height: 10px;
  width: 10px;
  border-radius: 50%;
  margin-left: 16px;
  animation-name: softblink;
  animation-iteration-count: infinite;
  animation-direction: alternate;
}
.play_state_icon {
  height: 10px;
  width: 10px;
  margin-right: 8px;
}
.play_state_icon.playing {
  background: transparent;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-left: 10px solid var(--accent-sea-green);
}
.play_state_icon.stopped {
  background: #ce2d5e;
  border-radius: 2px;
}
.play_state_icon.paused {
  background-size: 10px;
  background:
    linear-gradient(
      90deg ,
      var(--accent-gold) 0px,
      var(--accent-gold) 3px,
      transparent 3px,
      transparent 7px,
      var(--accent-gold) 7px,
      var(--accent-gold) 10px
    );
}

@keyframes softblink {
  0% {
    background: var(--primary-light);
    border: 2px solid var(--accent-sea-green);
  }
  50% {
    background: transparent;
    border: 2px solid var(--accent-sea-green);
  }
  50% {
    background: var(--accent-sea-green);
    border: 2px solid transparent;
  }
  100% {
    background: var(--accent-sea-green);
    border: 2px solid transparent;
  }
}
</style>

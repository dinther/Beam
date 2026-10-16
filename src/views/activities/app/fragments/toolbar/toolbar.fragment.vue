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
    <p
      v-if="sending"
      class="sending"
      :class="{ contested: otherSenders.length }"
      title="Beam is sending DMX. Edit > Preferences > DMX to receive again."
      @click="openPreferences('dmx')"
    >
      {{ sendingLabel }}
    </p>

    <preferences-popup
      v-model="preferencesPopupState"
      :tab="preferencesTab"
    />
    <license-popup v-model="licensePopupState" />
    <credits-popup v-model="creditsPopupState" />
    <newshow-popup v-model="newProjectPopupState" />
    <project-popup v-model="projectPopupState" />
    <video-popup
      v-model="videoPopupState"
      :focus-id="videoFocusId"
      :for-fixtures="videoForFixtures"
    />
    <laser-clips-popup
      v-model="laserClipsPopupState"
      :fixture-id="laserClipsFixtureId"
    />
    <wheels-popup
      v-model="wheelsPopupState"
      :fixture-ids="wheelsFixtureIds"
    />
  </uk-flex>
</template>

<script>
import EventBus from '@/plugins/eventbus';
import Selection from '@/models/DMX/selection';
import confirm from '@/plugins/confirm';
import importGdtfFiles from '@/plugins/gdtf_import';
import ViewMode from '@/plugins/view_mode';
import Screenshot from '@/plugins/visualizer/screenshot';
import MeasureTool from '@/plugins/visualizer/measure_tool';
import PreferencesPopup from './_popups/popup.preferences.vue';
import LicensePopup from './_popups/popup.license.vue';
import CreditsPopup from './_popups/popup.credits.vue';
import NewshowPopup from './_popups/popup.newshow.vue';
import ProjectPopup from './_popups/popup.project.vue';
import VideoPopup from './_popups/popup.video.vue';
import LaserClipsPopup from './_popups/popup.laserclips.vue';
import WheelsPopup from './_popups/popup.wheels.vue';

export default {
  name: 'ToolbarFragment',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  components: {
    PreferencesPopup,
    LicensePopup,
    CreditsPopup,
    NewshowPopup,
    ProjectPopup,
    VideoPopup,
    LaserClipsPopup,
    WheelsPopup,
  },
  data() {
    return {
      /**
       * Current show project naem
       * @todo, change name/use show handle directly ?
       */
      project: this.$show.documentTitle,
      /**
       * Current show savestate
       */
      saveState: true,
      videoPopupState: false,
      /** The input the Video inputs window opens on, or null for its own choice. */
      videoFocusId: null,
      /** The devices the window was opened from, by fixture id. */
      videoForFixtures: [],
      laserClipsPopupState: false,
      wheelsPopupState: false,
      wheelsFixtureIds: [],
      /** The laser the Clip list window edits, by fixture id. */
      laserClipsFixtureId: null,
      /** Whether Beam is in sender mode, and who else is on its universes. */
      sending: false,
      otherSenders: [],
      /**
       * New project popup state
       */
      newProjectPopupState: false,
      /** Project Details: the project's notes. */
      projectPopupState: false,
      /** Full window, full screen and stay on top. */
      view: ViewMode.state,
      /** Whether the Preferences window is open, and the tab it opens on. */
      preferencesPopupState: false,
      preferencesTab: 'visualizer',
      /**
       * License popup state
       */
      licensePopupState: false,
      /**
       * Credits popup state
       */
      creditsPopupState: false,
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
              name: 'New Project',
              icon: 'newfile',
              shortcut: 'Shift+N',
              callback: () => {
                this.displayNewProjectPopup();
              },
            },
            {
              name: 'Open Project',
              icon: 'folder',
              shortcut: 'Ctrl+O',
              callback: () => {
                this.openShow();
              },
            },
            {
              // Filled by `refreshRecent`.
              id: 'openRecent',
              name: 'Open Recent',
              icon: 'project',
              more: '▸',
              empty: 'No recent projects',
              submenu: [],
            },
            {
              name: 'Save Project',
              shortcut: 'Ctrl+S',
              icon: 'save',
              callback: () => {
                this.saveShow();
              },
            },
            {
              name: 'Save Project As...',
              icon: 'save',
              callback: () => {
                this.saveShowAs();
              },
            },
            {
              name: 'Export Project to...',
              shortcut: 'Ctrl+Shift+S',
              icon: 'export',
              callback: () => {
                this.exportShow();
              },
            },
            {
              name: 'Project Details...',
              icon: 'wrench',
              callback: () => {
                this.projectPopupState = true;
              },
            },
            {
              name: 'Refresh from Library',
              icon: 'folder',
              callback: () => {
                this.refreshFromLibrary();
              },
            },
            {
              id: 'importGdtf',
              name: 'Import GDTF...',
              icon: 'folder',
              separatorBefore: true,
              callback: () => {
                this.importGdtf();
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
            {
              // The scene handles the keys itself; the menu only shows them.
              name: 'Copy',
              hint: 'Ctrl+C',
              icon: 'copy',
              callback: () => {
                // A selected measurement copies as its line of text.
                if (MeasureTool.copySelected()) return;
                if (!Selection.items.length) return;
                EventBus.emit('copy_requested', Selection.items.map((entry) => ({ ...entry })));
              },
            },
            {
              name: 'Paste',
              hint: 'Ctrl+V',
              icon: 'paste',
              callback: () => {
                EventBus.emit('paste_requested');
              },
            },
            {
              name: 'Preferences',
              shortcut: 'Ctrl+Shift+V',
              icon: 'visualizer',
              callback: () => {
                this.openPreferences('visualizer');
              },
            },
          ],
        },
        {
          name: 'View',
          selected: false,
          items: [
            {
              name: 'Full window',
              shortcut: 'F10',
              icon: 'fit',
              callback: () => ViewMode.toggleFullWindow(),
            },
            {
              name: 'Full screen',
              shortcut: 'F11',
              icon: 'popout',
              callback: () => ViewMode.toggleFullScreen(),
            },
            {
              // The tick is the icon, set from the state by the watcher below.
              id: 'stayOnTop',
              name: 'Stay on top',
              icon: ViewMode.state.stayOnTop ? 'tick' : 'undef',
              callback: () => ViewMode.toggleStayOnTop(),
            },
            {
              name: 'Copy view to clipboard',
              icon: 'export',
              callback: () => {
                this.copyView();
              },
            },
          ],
        },
        {
          name: 'About',
          selected: false,
          items: [
            {
              // The version is worth reading without opening anything, so it
              // is the label; clicking shows the splash it comes from.
              name: `Version ${import.meta.env.VITE_APP_VERSION || 'unknown'}`,
              icon: 'bulb',
              callback: () => {
                EventBus.emit('show_about');
              },
            },
            {
              name: 'Manual',
              icon: 'help',
              callback: () => {
                window.open('https://github.com/dinther/Beam/blob/master/manual.md', '_blank');
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
                window.open('https://beatline.xyz/contact/', '_blank');
              },
            },
          ],
        },
      ],
    };
  },
  computed: {
    /** The sender-mode marker, naming anyone else on Beam's universes. */
    sendingLabel() {
      if (!this.otherSenders.length) return 'Sending DMX';
      const others = this.otherSenders
        .map(({ name, universes }) => `${name} on universe ${universes.join(', ')}`)
        .join('; ');
      return `Sending DMX. Also sending: ${others}`;
    },
  },
  watch: {
    'view.stayOnTop': function stayOnTopTick(on) {
      this.menus.forEach((menu) => menu.items.forEach((item) => {
        if (item.id === 'stayOnTop') item.icon = on ? 'tick' : 'undef';
      }));
    },
  },
  mounted() {
    this.$show.on('saveState', (state) => {
      this.saveState = state;
    });
    // The title follows the document, not the show's stored name: a show that
    // has never been saved is `untitled` whatever the template called itself.
    this.$show.on('document', ({ title }) => {
      this.project = title;
      // Opening or saving puts a project at the top of the recent list.
      this.refreshRecent();
    });
    this.refreshRecent();
    // A file that will not open has to say so. Silence would read as the app
    // ignoring the click, and the show that is loaded stays untouched.
    this.$show.on('documentError', (target) => {
      EventBus.emit('app_error', new Error(`Could not open ${target}. It may not be a Beam project.`));
    });
    // An export that could not be written, or that is missing something the
    // show names, has to say so: the file it leaves would open with holes in
    // it on another machine, which is the one thing an export is for.
    this.$show.on('exported', ({ target, ok, missing }) => {
      if (!ok) {
        EventBus.emit('app_error', new Error(`Could not write ${target}.`));
      } else if (missing && missing.length) {
        EventBus.emit('app_error', new Error(
          `Exported ${target}, but ${missing.length} item(s) the project uses could not be found `
          + `and are not in it: ${missing.join(', ')}`,
        ));
      }
    });
    // The Video inputs window opens from a device's Input list, and from its
    // own shortcut, which has no menu entry to carry it.
    EventBus.on('open_video_inputs', this.openVideoInputs);
    // A laser's clip list opens from its Fixture settings.
    EventBus.on('open_laser_clips', this.openLaserClips);
    EventBus.on('open_wheels', this.openWheels);
    window.addEventListener('keydown', this.onVideoInputsKey);
    this.$show.on('videoCropsDropped', (names) => {
      EventBus.emit('app_error', new Error(
        'Video connectors are gone: a display or projector now shows a whole input. '
        + `These showed part of a picture and now show all of it: ${names.join(', ')}`,
      ));
    });
    EventBus.on('app_ready', () => {
      this.project = this.$show.documentTitle;
    });
    EventBus.on('dmx_mode', ({ sending, otherSenders }) => {
      this.sending = sending;
      this.otherSenders = otherSenders || [];
    });
    // Files dropped anywhere on the window. A .gdtf is imported; anything
    // else is refused here, because the default for a dropped file is to
    // navigate to it, which would replace the app and lose the show.
    window.addEventListener('dragover', this.onFileDragOver);
    window.addEventListener('drop', this.onFileDrop);
  },
  beforeUnmount() {
    window.removeEventListener('dragover', this.onFileDragOver);
    window.removeEventListener('drop', this.onFileDrop);
    window.removeEventListener('keydown', this.onVideoInputsKey);
    EventBus.off('open_video_inputs', this.openVideoInputs);
    EventBus.off('open_laser_clips', this.openLaserClips);
    EventBus.off('open_wheels', this.openWheels);
  },
  methods: {
    /**
     * @param {Object} from `{ fixtureId }`, the laser to edit
     */
    openLaserClips(from = null) {
      this.laserClipsFixtureId = from && typeof from.fixtureId === 'number' ? from.fixtureId : null;
      this.laserClipsPopupState = true;
    },

    /** @param {Object} from `{ fixtureIds }`: the fixtures whose wheels to edit */
    openWheels(from = null) {
      this.wheelsFixtureIds = (from && Array.isArray(from.fixtureIds)) ? from.fixtureIds : [];
      this.wheelsPopupState = true;
    },

    /**
     * @param {Object} [from] `{ inputId, fixtureIds }` when a device's panel
     *   opens it: the input to show and the devices it can set
     */
    openVideoInputs(from = null) {
      const { inputId = null, fixtureIds = [] } = from || {};
      this.videoFocusId = typeof inputId === 'number' ? inputId : null;
      this.videoForFixtures = Array.isArray(fixtureIds) ? [...fixtureIds] : [];
      this.videoPopupState = true;
    },
    /** Ctrl+Shift+I opens the Video inputs window. */
    onVideoInputsKey(event) {
      if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyI') {
        event.preventDefault();
        this.openVideoInputs(null);
      }
      // The DMX tab's own shortcut, which the one Preferences entry cannot carry.
      if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyA') {
        event.preventDefault();
        this.openPreferences('dmx');
      }
    },
    async importGdtf() {
      if (!window.library || !window.library.pickGdtf) return;
      await importGdtfFiles(await window.library.pickGdtf(), this.$show);
    },
    /**
     * Allows a file drop. Lists reorder by dragging too, but those drags
     * carry no files and are left alone.
     *
     * @public
     * @param {DragEvent} event
     */
    onFileDragOver(event) {
      if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
      event.preventDefault();
      // eslint-disable-next-line no-param-reassign
      event.dataTransfer.dropEffect = 'copy';
    },
    /**
     * Imports dropped .gdtf files and ignores the rest.
     *
     * @public
     * @async
     * @param {DragEvent} event
     */
    async onFileDrop(event) {
      const files = [...(event.dataTransfer?.files || [])];
      if (!files.length) return;
      event.preventDefault();
      const gdtf = files.filter((file) => file.name.toLowerCase().endsWith('.gdtf'));
      if (gdtf.length < files.length) {
        EventBus.emit('app_error', new Error('Only .gdtf fixture files can be dropped on Beam.'));
      }
      if (!gdtf.length || !window.library || !window.library.pathForFile) return;
      await importGdtfFiles(gdtf.map((file) => window.library.pathForFile(file)), this.$show);
    },
    /**
     * Fills File > Open Recent. The open project is left out: it is already
     * open.
     *
     * @public
     * @async
     */
    async refreshRecent() {
      if (!window.documentStore || !window.documentStore.recent) return;
      const recent = await window.documentStore.recent();
      const current = this.$show.documentPath;
      const item = this.menus[0].items.find((entry) => entry.id === 'openRecent');
      if (!item) return;
      item.submenu = recent
        .filter((entry) => !current || entry.path.toLowerCase() !== current.toLowerCase())
        .map((entry) => ({
          name: entry.name,
          more: entry.folder.split(/[\\/]/).pop(),
          icon: 'project',
          callback: () => this.openRecent(entry.path),
        }));
    },
    /**
     * Opens a project from the recent list, asking first about unsaved changes.
     *
     * @public
     * @async
     * @param {String} target absolute path
     */
    async openRecent(target) {
      if (!await this.$show.releaseDocument('Open Project')) return;
      await this.$show.openDocumentAt(target);
    },
    /**
     * Opens a project the user picks.
     *
     * @public
     * @async
     */
    async openShow() {
      await this.$show.openDocument();
    },
    /**
     * Saves the show to its document, asking where the first time.
     *
     * @public
     * @async
     */
    async saveShow() {
      // Save means save the document. With nowhere to write yet this becomes
      // Save As, because choosing where a first save lands is the user's.
      await this.$show.saveDocument();
    },
    /**
     * Saves the show to a document the user picks.
     *
     * @public
     * @async
     */
    async saveShowAs() {
      await this.$show.saveDocumentAs();
    },
    /**
     * Puts the 3D view on the clipboard as an image.
     *
     * @public
     * @async
     */
    async copyView() {
      try {
        await Screenshot.copyView();
      } catch (err) {
        await confirm({
          title: 'Copy view to clipboard',
          message: 'The view could not be copied to the clipboard.',
          detail: err.message,
          yes: 'OK',
          no: 'Close',
        });
      }
    },
    /**
     * Writes a frozen copy of the show, with everything it references, to a
     * file the user picks.
     *
     * @public
     * @async
     */
    async exportShow() {
      await this.$show.exportDocument();
    },
    /**
     * Replaces the profiles and objects an exported project carries with the
     * library's, after asking: the show reloads, and is unsaved afterwards.
     *
     * @public
     * @async
     */
    async refreshFromLibrary() {
      const notice = (message, detail = '') => confirm({
        title: 'Refresh from Library', message, detail, yes: 'OK', no: 'Close',
      });
      if (!this.$show.documentPath) {
        await notice('This project has not been saved, so it carries nothing to refresh.');
        return;
      }
      const go = await confirm({
        title: 'Refresh from Library',
        message: 'Replace the fixture profiles and objects this project carries with the ones in your library?',
        detail: 'The project reloads with the library copies. Save to keep them in the file; '
          + 'close without saving to keep the old ones.',
        yes: 'Refresh',
        no: 'Cancel',
      });
      if (!go) return;
      const { carried, refreshed, kept } = await this.$show.refreshFromLibrary();
      const onlyHere = kept.length
        ? `Not in your library, so kept as carried: ${kept.join(', ')}`
        : '';
      if (!carried) {
        await notice('This project carries no copies of its own. It already uses your library.');
      } else if (!refreshed.length) {
        await notice('Everything this project carries already matches your library.', onlyHere);
      } else if (onlyHere) {
        await notice(`Refreshed ${refreshed.length} item(s): ${refreshed.join(', ')}`, onlyHere);
      }
    },
    /**
     * Opens the Preferences window.
     *
     * @public
     * @param {String} tab `visualizer` or `dmx`
     */
    openPreferences(tab) {
      this.preferencesTab = tab;
      this.preferencesPopupState = true;
    },
    /**
     * Display new project popup
     *
     * @public
     */
    async displayNewProjectPopup() {
      if (!await this.$show.releaseDocument('New Project')) return;
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
.sending {
  padding: 2px 8px;
  margin-right: 8px;
  border-radius: 3px;
  background: var(--accent-sea-green);
  color: var(--primary-dark);
  cursor: pointer;
}
.sending.contested {
  background: #ce2d5e;
  color: white;
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

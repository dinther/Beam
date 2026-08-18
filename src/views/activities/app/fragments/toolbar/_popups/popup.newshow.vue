<template>
  <uk-popup
    v-model="state"
    validate-txt="create"
    cancel-txt="cancel"
    :on-cancel="handleCancel"
    :header="headerData"
    backdrop
    @submit="submit()"
    @input="update()"
  >
    <uk-flex col>
      <uk-flex
        class="preview"
        :style="{backgroundImage: `url(/demo/images/${selectedTemplate.preview})`}"
      >
        <img class="preview_img">
      </uk-flex>
      <uk-flex
        col
        class="form"
      >
        <uk-flex
          col
          gap="10"
          style="padding:10px;"
        >
          <h4>Template:</h4>
          <p class="subtitle">
            Please select a new project template from the list below
            in order to get your new project started.
          </p>
        </uk-flex>
        <uk-list
          class="template_list"
          filterable
          :items="templates"
          auto-select-first
          @select="selectTemplate"
        />
      </uk-flex>
    </uk-flex>
  </uk-popup>
</template>
<script>
import PopupMixin from '@/views/mixins/popup.mixin';
import Preferences from '@/plugins/visualizer/preferences';

export default {
  name: 'UkPopupNewshow',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  mixins: [PopupMixin],
  data() {
    return {
      /**
       * Popup header data
       */
      headerData: { title: 'New Project' },
      /**
       * New project name
       */
      name: '',
      /**
       * Show templates
       */
      templates: [
        {
          name: 'Blank',
          more: 'New blank project',
          icon: 'save',
          preview: 'blank.png',
          showfile: 'blank.showfile.json',
          index: 0,
        },
        {
          name: 'Demo Show',
          more: 'Simple demo sample project',
          icon: 'save',
          preview: 'asls.png',
          showfile: 'demo.showfile.json',
          index: 1,
        },
      ],
      /**
       * Current selected template item
       */
      selectedTemplate: {
        name: 'Blank',
        more: 'New blank project',
        icon: 'save',
        preview: 'blank.png',
        showfile: 'blank.showfile.json',
        index: 0,
      },
    };
  },
  watch: {
    modelValue(state) {
      this.state = state;
      this.name = '';
    },
  },
  methods: {
    /**
     * Select a template from the template list
     */
    selectTemplate(template) {
      this.selectedTemplate = template;
    },
    /**
     * Submit new project creation
     *
     * @public
     */
    async submit() {
      this.close();
      this.$router.replace('/');
      // A new project has never been saved, so it belongs to no document and
      // is untitled until the user says otherwise. Cleared before the reload
      // below, or the session would hand back the project they just left.
      await this.$show.setDocument(null);
      await this.$show.loadFromUrl(`${import.meta.env.VITE_STATIC_URL}demo/showfiles/${this.selectedTemplate.showfile}`);
      // A new project is for building a rig, and a rig is built with the room
      // lit. Whatever the last show was watched under, this starts up.
      if (this.$show.visualizerHandle) this.$show.visualizerHandle.houseLights = true;
      // Written before the reload rather than left to the save debounce, which
      // the reload below would otherwise cut short.
      await Preferences.flush();
      // Yeah it sucks... But cleaning up everything from the view was a nightmare so for now:
      window.location.reload();
    },
    /**
     * Handle cancellation. for both first and second phase
     * (save actual project or create new project)
     *
       * @public
     */
    handleCancel() {
      if (!this.isSaved) {
        this.isSaved = true;
      } else {
        this.state = false;
        this.update();
      }
    },
  },
};
</script>

<style scoped>
.form {
  width: 400px;
  border-right: 1px solid var(--primary-dark);
}
.preview{
  height: 200px;
  width: 100%;
  background: url('/demo/images/asls.png');
  background-position: center;
  background-size: cover;
}
.subtitle {
  font-family: Roboto-Regular;
  margin-bottom: 8px;
  color: var(--secondary-lighter-alt);
}
.template_list{
  max-height: 204px;
  min-height: 204px;
}
</style>

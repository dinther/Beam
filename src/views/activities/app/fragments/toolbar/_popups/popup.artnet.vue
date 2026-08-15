<template>
  <uk-popup
    v-model="state"
    :header="headerData"
    @submit="close"
    @input="update()"
  >
    <uk-flex
      class="body"
      :gap="8"
      col
    >
      <uk-flex
        :gap="8"
        col
        class="title"
      >
        <h3>Input</h3>
        <p class="subtitle">
          Receive Art-Net and drive the visualizer from it.
        </p>
      </uk-flex>

      <uk-flex center-h>
        <div>
          <h4>Receive:</h4>
          <p class="subtitle">
            {{ available ? 'Listening on UDP 6454.' : 'Unavailable in the browser — run the desktop app.' }}
          </p>
        </div>
        <uk-spacer />
        <uk-select-input
          :model-value="inputEnabled ? 1 : 0"
          style="width: 100px"
          :options="['disabled', 'enabled']"
          :disabled="!available"
          @input="setInput"
        />
      </uk-flex>
    </uk-flex>
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';
import artnetConnection from '@/plugins/artnet.connection';

export default {
  name: 'ArtnetPopup',
  compatConfig: {
    MODE: 3,
  },
  mixins: [PopupMixin],
  data() {
    return {
      headerData: { title: 'Art-Net settings' },
    };
  },
  computed: {
    available() {
      return artnetConnection.available;
    },
    inputEnabled() {
      return artnetConnection.inputEnabled;
    },
  },
  methods: {
    setInput(index) {
      if (index) {
        artnetConnection.enableInput();
      } else {
        artnetConnection.disableInput();
      }
    },
  },
};
</script>

<style scoped>
.body {
  padding: 10px;
  min-width: 460px;
  max-width: 460px;
  max-height: 50vh;
  overflow: auto;
}
.separator {
  margin: 4px 0;
  width: 100%;
}
.subtitle {
  font-family: Roboto-Regular;
  margin-bottom: 8px;
  color: var(--secondary-lighter-alt);
}
.title {
  border-bottom: 1px solid var(--primary-dark);
}
h4 {
  margin-bottom: 4px;
}
</style>

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

      <div class="separator" />

      <uk-flex
        :gap="8"
        col
        class="title"
      >
        <h3>Output</h3>
        <p class="subtitle">
          Stream a universe's DMX out as Art-Net.
        </p>
      </uk-flex>

      <uk-flex
        v-for="universe in universes"
        :key="universe.id"
        center-h
        :gap="8"
      >
        <div style="min-width: 90px">
          <h4>{{ universe.name }}</h4>
          <p class="subtitle">
            Universe {{ universe.id }}
          </p>
        </div>
        <uk-spacer />
        <uk-txt-input
          v-model="targets[universe.id].ip"
          label="Host"
          :disabled="!available || isOutputting(universe.id)"
          style="width: 130px"
        />
        <uk-num-input
          v-model="targets[universe.id].port"
          label="Port"
          :disabled="!available || isOutputting(universe.id)"
          style="width: 70px"
        />
        <uk-button
          :model-value="isOutputting(universe.id)"
          :label="isOutputting(universe.id) ? 'Stop' : 'Send'"
          toggleable
          square
          style="height: 25px; min-width: 60px; margin-top: 18px"
          color="var(--accent-blue)"
          :disabled="!available"
          @click="toggleOutput(universe)"
        />
      </uk-flex>
    </uk-flex>
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';
import artnetConnection from '@/plugins/artnet.connection';

const DEFAULT_TARGET = { ip: '255.255.255.255', port: 6454 };

export default {
  name: 'ArtnetPopup',
  compatConfig: {
    MODE: 3,
  },
  mixins: [PopupMixin],
  data() {
    return {
      headerData: { title: 'Art-Net settings' },
      /** Per-universe { ip, port } output target config, keyed by universe id. */
      targets: {},
      /** Bumped to force re-render when output state changes. */
      tick: 0,
    };
  },
  computed: {
    available() {
      return artnetConnection.available;
    },
    inputEnabled() {
      return artnetConnection.inputEnabled;
    },
    universes() {
      return this.$show.universePool.universes;
    },
  },
  watch: {
    state(open) {
      if (open) this.ensureTargets();
    },
  },
  mounted() {
    this.ensureTargets();
  },
  methods: {
    /**
     * Ensures each universe has an output target entry.
     */
    ensureTargets() {
      this.universes.forEach((universe) => {
        if (!this.targets[universe.id]) {
          this.targets[universe.id] = { ...DEFAULT_TARGET };
        }
      });
    },
    setInput(index) {
      if (index) {
        artnetConnection.enableInput();
      } else {
        artnetConnection.disableInput();
      }
    },
    isOutputting(universeId) {
      // reference tick so the button re-evaluates after a toggle
      return this.tick >= 0 && artnetConnection.isOutputting(universeId);
    },
    toggleOutput(universe) {
      if (artnetConnection.isOutputting(universe.id)) {
        artnetConnection.stopOutput(universe.id);
      } else {
        artnetConnection.startOutput(universe, this.targets[universe.id]);
      }
      this.tick += 1;
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

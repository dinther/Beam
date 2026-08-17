<template>
  <visualizer />
</template>

<script>
import Visualizer from '@/views/activities/app/fragments/visualizer/visualizer.fragment.vue';
import EventBus from '@/plugins/eventbus';

export default {
  name: 'VisualizerActivity',
  components: {
    Visualizer,
  },
  async mounted() {
    this.$show.slave = true;
    EventBus.on('visualizer_loaded', async () => {
      // The show comes from the window that opened this one, which hands over
      // its live Show on `window.$show`. Same origin, same memory, no file:
      // the show exists in RAM until the user saves it to a document of their
      // own, and a second window is no reason to write one behind their back.
      const source = window.$show;
      if (!source) return;
      await this.$show.loadFromData(JSON.parse(source.genShowFile()));
    });
  },
};
</script>

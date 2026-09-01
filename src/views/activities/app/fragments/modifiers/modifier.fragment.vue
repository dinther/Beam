<template>
  <uk-flex class="modifier">
    <!-- Studio mode takes the bar over rather than adding to it. The modifier
         widgets act on a selection, and a recording has none: starting one
         clears the selection and hides the gizmo that would edit it. -->
    <studio-fragment v-if="studioActive" />
    <fixture-modifier v-else />
  </uk-flex>
</template>

<script>
import FixtureModifier from '@/views/activities/app/fragments/modifiers/fixture/fixture.modifier.fragment.vue';
import StudioFragment from '@/views/activities/app/fragments/studio/studio.fragment.vue';
import Studio from '@/models/DMX/studio';

export default {
  name: 'ModifierFragment',
  components: {
    FixtureModifier,
    StudioFragment,
  },
  computed: {
    /** @returns {Boolean} whether the studio owns the widget bar */
    studioActive() {
      return Studio.state.active;
    },
  },
};
</script>

<style scoped>
.modifier {
  position: relative;
  flex: 1;
  width: 100%;
  background: var(--primary-light) repeating-linear-gradient(
    45deg,
    #1619130a,
    #1619130a 10px,
    #0c0e0a38 10px,
    #0c0e0a38 20px
  );
  border-top: 1px solid var(--primary-dark);
  overflow: hidden;
  overflow-x: auto;
  z-index: 20;
}
</style>

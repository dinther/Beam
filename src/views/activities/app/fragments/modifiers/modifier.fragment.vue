<template>
  <uk-flex class="modifier">
    <universe-modifier />
  </uk-flex>
</template>

<script>
import UniverseModifier from '@/views/activities/app/fragments/modifiers/universe/universe.modifier.fragment.vue';

export default {
  name: 'ModifierFragment',
  components: {
    UniverseModifier,
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

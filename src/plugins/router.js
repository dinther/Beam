import {
  createMemoryHistory,
  createRouter,
} from 'vue-router';
import ShowSingleton from '@/singletons/show.singleton';
import {
  ProxifySingleton,
} from '@/models/utils/proxify.utils';

import AppActivity from '@/views/activities/app/app.activity.vue';
import VisualizerActivity from '@/views/activities/visualizer/visualizer.activity.vue';
import FixtureModifier from '@/views/activities/app/fragments/modifiers/fixture/fixture.modifier.fragment.vue';

const routes = [{
  path: '/',
  component: AppActivity,
  meta: {
    auth: true,
    appRoot: true,
  },
  children: [{
    path: '',
    name: 'Default',
    component: FixtureModifier,
  }, {
    // Fixtures are addressed globally, so the route names a fixture rather
    // than a universe to look inside.
    path: '/patch',
    name: 'Patch',
    component: FixtureModifier,
  }],
}, {
  path: '/visualizer',
  component: VisualizerActivity,
  name: 'Visualizer',
}];

const router = createRouter({
  history: createMemoryHistory(),
  routes,
});

router.beforeEach(async (from, to, next) => {
  if (ShowSingleton.ready || to.name === 'Default' || from.name === 'Visualizer' || to.name === 'Visualizer') {
    return next();
  } if (from.name !== 'Default') {
    return next({
      name: 'Default',
    });
  }
  return next();
});

ProxifySingleton.on('undo', (data) => {
  router.push(data.path).catch(() => {});
});

export default router;

import { createApp, reactive } from 'vue';
import axios from 'axios';
import uikit from '@/views/components/uikit';
import utils from '@/views/utils';
import EventBus from '@/plugins/eventbus';
import '@/assets/styles/global.css';
import '@/assets/styles/fonts.css';
import ShowSingleton from '@/singletons/show.singleton';
import artnetConnection from '@/plugins/artnet.connection';
import router from './plugins/router';
import App from './App.vue';

function registerComponents(components, app) {
  Object.keys(components).forEach((componentKey) => {
    const component = components[componentKey];
    if (component.name) {
      app.component(component.name, component);
    } else {
      registerComponents(component, app);
    }
  });
}

try {
  const app = createApp(App);
  registerComponents(uikit, app);
  app.config.globalProperties.$show = reactive(ShowSingleton);
  app.config.globalProperties.$http = axios;
  app.config.globalProperties.$utils = reactive(utils);
  app.config.errorHandler = (err, instance, info) => {
    // The message on its own says nothing about where it came from, and a
    // render error names no file. Vue hands over what it was doing and which
    // component was doing it; both are worth more than the message.
    const component = (instance && instance.$options && instance.$options.name) || 'unknown';
    console.error(`[vue] ${info} in <${component}>`);
    console.error((err && err.stack) || err);
    EventBus.emit('app_error', err);
  };
  app.use(router);
  app.mount('#app');

  // Route inbound Art-Net into the DMX/visualizer layer (no-op in a plain browser).
  if (artnetConnection.available) {
    artnetConnection.enableInput();
  }
} catch (err) {
  console.log(err);
}

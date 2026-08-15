module.exports = {
  extends: [
    'airbnb-base',
    'eslint:recommended',
    'plugin:vue/vue3-recommended',
  ],
  env: {
    browser: true,
    node: true,
    es2021: true,
  },
  parserOptions: {
    ecmaVersion: 'latest',
  },
  rules: {
    'vue/no-mutating-props': ['error', {
      shallowOnly: true,
    }],
    'no-plusplus': 'off',
    'no-underscore-dangle': 'off',
    'max-classes-per-file': 'off',
    'no-constructor-return': 'off',
    'no-param-reassign': 'off',
    'no-await-in-loop': 'off',
    camelcase: 'off',
    // electron-vite resolves `?asset` imports at build time, emitting the file
    // and handing back its path. The eslint resolver has no idea what the
    // query means and reports the module as missing.
    'import/no-unresolved': ['error', { ignore: ['\\?asset$'] }],
  },
  settings: {
    'import/resolver': {
      alias: {
        map: [
          ['@', './src'],
          ['@root', './'],
        ],
        extensions: ['.js', '.vue'],
      },
    },
  },
};

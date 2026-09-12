import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.venv/**',
      // Geometry build scripts and the committed GeoJSON are plain Node, run by hand.
      'geo/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // PM2 loads this as CommonJS, which is why it is .cjs and uses module.exports.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
  {
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        RequestInit: 'readonly',
        DOMException: 'readonly',
        HTMLDivElement: 'readonly',
        AbortSignal: 'readonly',
        JSX: 'readonly',
        console: 'readonly',
        process: 'readonly',
        NodeJS: 'readonly',
        Buffer: 'readonly',
        globalThis: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);

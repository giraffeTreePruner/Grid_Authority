/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GEOMETRY_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

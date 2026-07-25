interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_R2_PUBLIC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
interface ImportMetaEnv {
  /** "true" in `pnpm dev:mock`: MSW answers /api requests in the browser. */
  readonly VITE_API_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_API_BASE?: string;
  readonly VITE_PARTY_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

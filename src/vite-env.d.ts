/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  /** Kosong/absen ⇒ engine same-origin (deploy 1-container). Set ke http://localhost:8000 saat dev. */
  readonly VITE_ENGINE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

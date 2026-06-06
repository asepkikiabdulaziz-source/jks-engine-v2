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

/** Config runtime yang disuntik FastAPI ke index.html saat deploy 1-container
 *  (window.__ENV__). Frontend membacanya saat boot; fallback ke import.meta.env. */
interface Window {
  __ENV__?: {
    SUPABASE_URL?: string
    SUPABASE_ANON_KEY?: string
    ENGINE_URL?: string
  }
}

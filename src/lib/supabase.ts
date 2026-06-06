import { createClient } from '@supabase/supabase-js'

// Config runtime (window.__ENV__) disuntik FastAPI saat deploy 1-container →
// image sama jalan di host mana pun tanpa rebuild. Fallback ke import.meta.env
// untuk `npm run dev` (Vite membaca .env).
const env = typeof window !== 'undefined' ? window.__ENV__ : undefined
const url = (env?.SUPABASE_URL      || import.meta.env.VITE_SUPABASE_URL)      as string
const key = (env?.SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string

export const supabase = createClient(url, key)

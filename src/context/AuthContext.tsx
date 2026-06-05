import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface UserProfile {
  id: string          // Supabase auth user UUID
  nik: string
  full_name: string
  slot_code: string
  role_name: string
  role_id: string
  scope_id: string | null
  scope_name: string | null
  branch_code: string | null
  branch_name: string | null
  region_code: string | null
  region_name: string | null
  initials: string
}

interface AuthState {
  user: UserProfile | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  user: null, loading: true,
  login: async () => {}, logout: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser]     = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  async function fetchProfile(userId: string): Promise<UserProfile | null> {
    const { data, error } = await supabase.rpc('get_my_profile', { p_user_id: userId })
    if (error || !data || data.length === 0) return null
    const p = Array.isArray(data) ? data[0] : data
    const parts = (p.full_name || '').trim().split(' ')
    const initials = ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U'
    return { ...p, initials, id: userId }
  }

  useEffect(() => {
    // onAuthStateChange fires INITIAL_SESSION immediately on subscribe (with or without session)
    // — no need for a separate getSession() call, which caused 2-3x fetchProfile on mount.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        setUser(null)
        setLoading(false)
        return
      }
      if (event === 'INITIAL_SESSION') {
        // Restore persisted session on mount
        const profile = await fetchProfile(session.user.id)
        setUser(profile)
        setLoading(false)
      }
      // SIGNED_IN  → handled by login() directly (profile + access check done there)
      // TOKEN_REFRESHED → skip (profile unchanged)
    })

    return () => subscription.unsubscribe()
  }, [])

  async function login(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    const profile = await fetchProfile(data.user.id)
    if (!profile) {
      await supabase.auth.signOut()
      throw new Error('Akses ditolak. Akun ini tidak memiliki hak akses ke JKS Route Engine.')
    }
    setUser(profile)
  }

  async function logout() {
    await supabase.auth.signOut()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)

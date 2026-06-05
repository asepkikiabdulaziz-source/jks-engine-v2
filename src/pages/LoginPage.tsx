import { FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function LoginPage() {
  const { login } = useAuth()
  const navigate   = useNavigate()
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password.trim()) { setError('Email dan password wajib diisi.'); return }
    setError(''); setLoading(true)
    try {
      await login(email.trim(), password)
      navigate('/', { replace: true })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login gagal.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-background text-on-surface min-h-screen flex flex-col">

      {/* TopAppBar */}
      <header className="w-full sticky top-0 bg-surface border-b border-secondary/10 flex justify-between items-center px-margin-desktop py-md z-50">
        <span className="font-headline text-xl font-bold text-primary">JKS SFA</span>
        <div className="flex items-center gap-md">
          <button className="material-symbols-outlined text-on-surface-variant hover:bg-surface-container-high p-sm rounded-full transition-colors">
            settings
          </button>
          <div className="flex items-center gap-sm border-l border-outline-variant pl-md ml-sm">
            <span className="body-sm text-on-surface-variant hidden md:block">
              System Status: <span className="text-on-tertiary-container font-semibold">Online</span>
            </span>
          </div>
        </div>
      </header>

      <main className="flex-grow flex flex-row relative" style={{ minHeight: 'calc(100vh - 57px - 73px)' }}>

        {/* ── Left: dark panel ── */}
        <div className="hidden lg:flex w-1/2 flex-col justify-center px-24 relative overflow-hidden bg-primary-container">
          {/* Decorative blobs */}
          <div className="absolute inset-0 pointer-events-none opacity-30">
            <div className="absolute -top-1/4 -right-1/4 w-[800px] h-[800px] rounded-full blur-[160px]"
                 style={{ background: 'rgba(107,216,203,0.2)' }} />
            <div className="absolute -bottom-1/4 -left-1/4 w-[800px] h-[800px] rounded-full blur-[160px]"
                 style={{ background: 'rgba(211,228,254,0.1)' }} />
          </div>

          <div className="relative z-10 space-y-xl max-w-[540px]">
            {/* Badge */}
            <div className="inline-flex items-center px-md py-xs rounded-full text-primary-fixed"
                 style={{ background: 'rgba(63,70,92,0.2)', border: '1px solid rgba(63,70,92,0.3)' }}>
              <span className="material-symbols-outlined text-sm mr-xs">auto_awesome</span>
              <span className="label-md">NEXT-GEN LOGISTICS PLATFORM</span>
            </div>

            {/* Headline */}
            <h2 className="font-headline font-bold text-on-primary"
                style={{ fontSize: 48, lineHeight: '56px' }}>
              Optimalkan teritori penjualan Anda.
            </h2>

            {/* Description */}
            <p className="body-md text-on-primary-container leading-relaxed">
              Desain rute kunjungan, partisi wilayah, dan jadwal ganjil/genap
              dalam satu dashboard untuk area manager modern.
            </p>

            {/* Stats */}
            <div className="grid grid-cols-2 gap-lg pt-xl"
                 style={{ borderTop: '1px solid rgba(124,131,155,0.2)' }}>
              <div>
                <div className="font-headline font-bold text-2xl text-tertiary-fixed">263</div>
                <div className="body-sm text-on-primary-container mt-xs">Toko Aktif</div>
              </div>
              <div>
                <div className="font-headline font-bold text-2xl text-tertiary-fixed">5</div>
                <div className="body-sm text-on-primary-container mt-xs">Sales Aktif</div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Right: form ── */}
        <div className="w-full lg:w-1/2 flex flex-col items-center justify-center p-xl md:p-[64px] bg-background">
          <div className="w-full max-w-[480px]">

            {/* Card */}
            <div className="bg-surface-container-lowest border border-secondary/10 rounded-xl p-xl shadow-2xl"
                 style={{ boxShadow: '0 25px 50px rgba(25,28,30,0.05)' }}>

              {/* Branding */}
              <div className="flex flex-col items-center text-center mb-xl">
                <div className="w-16 h-16 bg-primary-container rounded-xl flex items-center justify-center mb-md"
                     style={{ boxShadow: '0 8px 24px rgba(19,27,46,0.2)' }}>
                  <span className="material-symbols-outlined text-primary-fixed" style={{ fontSize: 36 }}>route</span>
                </div>
                <h1 className="font-headline font-bold text-on-surface"
                    style={{ fontSize: 30, lineHeight: '38px', letterSpacing: '-0.02em' }}>
                  Professional Portal
                </h1>
                <p className="body-md text-on-surface-variant mt-xs">
                  Masuk ke dashboard area manager Anda.
                </p>
              </div>

              {/* Error */}
              {error && (
                <div className="mb-lg flex items-start gap-sm bg-error-container/20 border border-error/20 rounded-lg p-md body-sm text-on-error-container">
                  <span className="material-symbols-outlined text-[18px] shrink-0 mt-[1px]">error</span>
                  <span>{error}</span>
                </div>
              )}

              {/* Form */}
              <form onSubmit={handleSubmit} className="space-y-lg">

                {/* Email */}
                <div className="space-y-xs">
                  <label className="label-md text-on-surface-variant" htmlFor="email">
                    CORPORATE EMAIL
                  </label>
                  <div className="relative group">
                    <input
                      id="email" type="email" value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="nama@pinusmerahabadi.co.id"
                      className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-md body-md text-on-surface outline-none transition-all
                                 focus:border-on-tertiary-container focus:ring-2 focus:ring-on-tertiary-container/20"
                    />
                    <span className="material-symbols-outlined absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant/40 group-focus-within:text-on-tertiary-container transition-colors">
                      mail
                    </span>
                  </div>
                </div>

                {/* Password */}
                <div className="space-y-xs">
                  <div className="flex justify-between items-center">
                    <label className="label-md text-on-surface-variant" htmlFor="password">PASSWORD</label>
                    <a className="label-md text-on-tertiary-container hover:underline" href="#">Lupa password?</a>
                  </div>
                  <div className="relative group">
                    <input
                      id="password"
                      type={showPass ? 'text' : 'password'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-md body-md text-on-surface outline-none transition-all
                                 focus:border-on-tertiary-container focus:ring-2 focus:ring-on-tertiary-container/20"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass(v => !v)}
                      className="material-symbols-outlined absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant/40 hover:text-on-surface transition-colors"
                    >
                      {showPass ? 'visibility_off' : 'visibility'}
                    </button>
                  </div>
                </div>

                {/* CTA */}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-primary text-on-primary py-lg px-lg rounded-lg label-md uppercase tracking-[0.1em] font-bold
                             hover:bg-on-surface-variant active:scale-[0.99] transition-all shadow-xl mt-md
                             disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-sm"
                >
                  {loading && <span className="material-symbols-outlined text-[18px] animate-spin">autorenew</span>}
                  {loading ? 'AUTHENTICATING...' : 'ACCESS DASHBOARD'}
                </button>
              </form>

              {/* Divider */}
              <div className="mt-xl">
                <div className="relative flex items-center justify-center mb-lg">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-outline-variant" />
                  </div>
                  <span className="relative bg-surface-container-lowest px-md label-md text-on-surface-variant/60">
                    OR SIGN IN WITH
                  </span>
                </div>
                <button className="w-full border border-outline-variant hover:bg-surface-container transition-colors py-md rounded-lg flex items-center justify-center gap-sm">
                  <svg viewBox="0 0 24 24" className="w-5 h-5">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  <span className="label-md text-on-surface">Google SSO</span>
                </button>
              </div>

              {/* Request access */}
              <div className="mt-xl pt-lg border-t border-secondary/10 text-center">
                <p className="body-md text-on-surface-variant">
                  Butuh akun korporat?{' '}
                  <a className="text-on-tertiary-container font-bold hover:underline" href="#">Request Access</a>
                </p>
              </div>
            </div>

            {/* Trust badges */}
            <div className="mt-xl flex items-center justify-center gap-xl opacity-50 grayscale hover:grayscale-0 hover:opacity-100 transition-all duration-300">
              <div className="flex items-center gap-xs">
                <span className="material-symbols-outlined text-sm">verified_user</span>
                <span className="label-md" style={{ fontSize: 11, letterSpacing: '0.1em' }}>AES-256 SECURED</span>
              </div>
              <div className="flex items-center gap-xs">
                <span className="material-symbols-outlined text-sm">cloud_done</span>
                <span className="label-md" style={{ fontSize: 11, letterSpacing: '0.1em' }}>99.9% UPTIME</span>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full px-margin-desktop py-lg bg-surface border-t border-secondary/10 flex flex-col md:flex-row justify-between items-center gap-md z-10">
        <div className="flex flex-col md:flex-row items-center gap-md">
          <p className="body-sm text-on-surface-variant">© 2026 JKS SFA Route Engine v2. All rights reserved.</p>
          <div className="hidden md:block w-1 h-1 bg-outline-variant rounded-full" />
          <p className="body-sm text-on-surface-variant flex items-center gap-xs">
            <span className="material-symbols-outlined text-xs text-on-tertiary-container">check_circle</span>
            All systems operational
          </p>
        </div>
        <div className="flex gap-xl">
          {['Security Policy', 'Privacy Terms', 'SLA Agreement', 'Support Portal'].map(l => (
            <a key={l} className="label-md text-on-surface-variant hover:text-primary transition-colors" href="#">{l}</a>
          ))}
        </div>
      </footer>
    </div>
  )
}

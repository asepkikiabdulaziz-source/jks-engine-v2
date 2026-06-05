import { Routes, Route, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { AreaProvider, useArea } from '../../context/AreaContext'
import DashboardPage from '../../pages/DashboardPage'
import RoutingEnginePage from '../../pages/RoutingEnginePage'
import UploadTokoPage from '../../pages/UploadTokoPage'
import PlansPage from '../../pages/PlansPage'
import PlanMapPage from '../../pages/PlanMapPage'

const navItems = [
  { label: 'Dashboard',      icon: 'dashboard',   path: '/' },
  { label: 'Routing Engine', icon: 'tune',        path: '/routing' },
  { label: 'Daftar Plan',    icon: 'list_alt',    path: '/plans' },
]
const systemItems = [
  { label: 'Upload Toko', icon: 'upload_file', path: '/upload' },
]

// ── Badge area aktif di header (read-only, klik → ke dashboard untuk ganti) ───
function ActiveAreaBadge() {
  const { activeArea } = useArea()
  const navigate       = useNavigate()

  if (!activeArea) {
    return (
      <button
        onClick={() => navigate('/')}
        className="flex items-center gap-xs px-sm py-xs rounded-lg border border-outline-variant text-[11px] text-on-surface-variant hover:bg-surface-container transition-colors"
        style={{ background: '#f7f9fb' }}
        title="Pilih area di Dashboard"
      >
        <span className="material-symbols-outlined" style={{ fontSize: 14, color: '#9099a8' }}>location_off</span>
        <span>Belum ada area</span>
      </button>
    )
  }

  return (
    <button
      onClick={() => navigate('/')}
      className="flex items-center gap-xs px-sm py-xs rounded-lg border border-outline-variant hover:bg-surface-container transition-colors"
      style={{ background: '#f7f9fb' }}
      title="Klik untuk ganti area di Dashboard"
    >
      <span className="material-symbols-outlined ms-fill shrink-0" style={{ color: '#0c9488', fontSize: 14 }}>location_on</span>
      <div className="flex flex-col items-start leading-none">
        <span className="text-[11px] font-semibold text-on-surface">{activeArea.nama_area}</span>
        <span className="text-[9px] font-bold" style={{ color: '#0c9488' }}>{activeArea.kd_dist}</span>
      </div>
      <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: 12 }}>edit</span>
    </button>
  )
}

export default function AppShell() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <AreaProvider>
      <div className="h-screen flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 h-screen flex flex-col shrink-0 sticky top-0"
               style={{ background: '#f2f4f6', borderRight: '1px solid rgba(80,95,118,0.1)' }}>
          <div className="px-6 py-7" style={{ borderBottom: '1px solid rgba(80,95,118,0.1)' }}>
            <span className="font-bold text-lg" style={{ fontFamily: 'Hanken Grotesk' }}>JKS SFA</span>
          </div>

          <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
            <p className="px-3 py-2 text-[10px] font-bold tracking-widest uppercase" style={{ color: 'rgba(69,70,77,0.5)' }}>
              UTAMA
            </p>
            {navItems.map(item => (
              <NavLink key={item.path} to={item.path} end={item.path === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-4 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ` +
                  (isActive ? 'text-[#0b1c30]' : 'text-[#45464d] hover:bg-[#e6e8ea]')
                }
                style={({ isActive }) => isActive ? { background: '#d0e1fb' } : {}}
              >
                {({ isActive }) => (
                  <>
                    <span className={`material-symbols-outlined ${isActive ? 'ms-fill' : ''}`}>{item.icon}</span>
                    {item.label}
                  </>
                )}
              </NavLink>
            ))}

            <p className="px-3 py-2 mt-4 text-[10px] font-bold tracking-widest uppercase" style={{ color: 'rgba(69,70,77,0.5)' }}>
              DATA
            </p>
            {systemItems.map(item => (
              <NavLink key={item.path} to={item.path}
                className={({ isActive }) =>
                  `flex items-center gap-4 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ` +
                  (isActive ? 'text-[#0b1c30]' : 'text-[#45464d] hover:bg-[#e6e8ea]')
                }
                style={({ isActive }) => isActive ? { background: '#d0e1fb' } : {}}
              >
                {({ isActive }) => (
                  <>
                    <span className={`material-symbols-outlined ${isActive ? 'ms-fill' : ''}`}>{item.icon}</span>
                    {item.label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          {/* User info */}
          <div className="p-3" style={{ borderTop: '1px solid rgba(80,95,118,0.1)' }}>
            <div className="flex items-center gap-2 p-2 rounded-xl" style={{ background: '#eceef0' }}>
              <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
                   style={{ background: '#d0e1fb', color: '#0b1c30' }}>
                {user?.initials ?? 'AM'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate text-[#191c1e]">{user?.full_name ?? '—'}</p>
                <p className="text-[10px] truncate capitalize" style={{ color: '#45464d' }}>
                  {user?.role_name ?? user?.role_id ?? '—'}
                </p>
              </div>
              <button onClick={handleLogout} className="p-1 rounded transition-colors hover:bg-[#e6e8ea]"
                      style={{ color: '#45464d' }}>
                <span className="material-symbols-outlined text-lg">logout</span>
              </button>
            </div>
          </div>
        </aside>

        {/* Main */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <header className="shrink-0 flex justify-between items-center px-8 py-4 z-40"
                  style={{ background: 'rgba(247,249,251,0.8)', backdropFilter: 'blur(8px)', borderBottom: '1px solid rgba(80,95,118,0.1)' }}>
            <Routes>
              <Route path="/"              element={<h2 className="font-semibold text-xl" style={{ fontFamily: 'Hanken Grotesk' }}>Command Center</h2>} />
              <Route path="/routing"       element={<h2 className="font-semibold text-xl" style={{ fontFamily: 'Hanken Grotesk' }}>Routing Engine</h2>} />
              <Route path="/plans"         element={<h2 className="font-semibold text-xl" style={{ fontFamily: 'Hanken Grotesk' }}>Daftar Plan</h2>} />
              <Route path="/plans/:planId/map" element={<h2 className="font-semibold text-xl" style={{ fontFamily: 'Hanken Grotesk' }}>Review Plan</h2>} />
              <Route path="/upload"        element={<h2 className="font-semibold text-xl" style={{ fontFamily: 'Hanken Grotesk' }}>Upload Toko</h2>} />
            </Routes>
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined cursor-pointer" style={{ color: '#45464d' }}>notifications</span>
              {/* Area aktif — read-only, klik → ke dashboard untuk ganti */}
              <ActiveAreaBadge />
            </div>
          </header>

          {/* overflow-hidden: halaman routing pakai h-full + map absolute */}
          <main className="flex-1 overflow-hidden">
            <Routes>
              <Route path="/"                  element={<ScrollPage><DashboardPage /></ScrollPage>} />
              <Route path="/routing"           element={<RoutingEnginePage />} />
              <Route path="/plans"             element={<ScrollPage><PlansPage /></ScrollPage>} />
              <Route path="/plans/:planId/map" element={<PlanMapPage />} />
              <Route path="/upload"            element={<ScrollPage><UploadTokoPage /></ScrollPage>} />
            </Routes>
          </main>
        </div>
      </div>
    </AreaProvider>
  )
}

// Wrapper untuk halaman yang butuh scroll (non-map pages)
function ScrollPage({ children }: { children: React.ReactNode }) {
  return <div className="h-full overflow-y-auto">{children}</div>
}

function Placeholder({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center h-full text-[#45464d]">
      <div className="text-center space-y-2">
        <span className="material-symbols-outlined text-5xl block" style={{ color: '#c6c6cd' }}>construction</span>
        <p className="font-semibold">{title}</p>
        <p className="text-sm">Coming next session</p>
      </div>
    </div>
  )
}

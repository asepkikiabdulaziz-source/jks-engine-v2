import { useEffect, useRef, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useArea } from '../context/AreaContext'
import { supabase } from '../lib/supabase'
import AreaPicker from '../components/layout/AreaPicker'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TERRITORY_COLORS = [
  '#e74c3c','#3498db','#27ae60','#f39c12',
  '#9b59b6','#1abc9c','#e67e22','#2980b9',
  '#c0392b','#16a085','#d35400','#8e44ad',
]

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface StoreRow {
  customer_code : string
  latitude      : number | null
  longitude     : number | null
}

interface AssignmentSimple {
  customer_code    : string
  sales_person_name: string
}

interface DivisionMeta {
  div_sls   : string
  n_sales   : number
  work_days : number
  cycle     : string
  philosophy: string
  store_count: number
}

interface PlanRow {
  id          : string
  plan_name   : string
  status      : 'DRAFT' | 'APPROVED' | 'ARCHIVED'
  store_count : number
  created_by  : string | null
  created_at  : string
  approved_at : string | null
  divisions   : DivisionMeta[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function salesLabel(name: string): string {
  const p = name.split('-')
  if (p.length >= 3) return `${p[1]}-SLS-${p[p.length - 1]}`
  return name
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function StatusBadge({ status }: { status: PlanRow['status'] }) {
  const cfg = {
    DRAFT:    { label: 'Draft',     color: '#45464d', bg: '#e0e3e5' },
    APPROVED: { label: 'Submitted', color: '#0c9488', bg: 'rgba(12,148,136,0.15)' },
    ARCHIVED: { label: 'Arsip',     color: '#9099a8', bg: 'rgba(80,95,118,0.08)' },
  }[status]
  return (
    <span className="text-[9px] font-bold px-xs py-[2px] rounded-full shrink-0"
          style={{ color: cfg.color, background: cfg.bg }}>
      {cfg.label}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// LeafletMap — peta teritori (render stores berwarna berdasarkan plan aktif)
// ─────────────────────────────────────────────────────────────────────────────

function LeafletMap({ stores, storeStyles }: {
  stores      : StoreRow[]
  storeStyles : Record<string, string>   // customer_code → hex color
}) {
  const containerRef  = useRef<HTMLDivElement>(null)
  const mapRef        = useRef<L.Map | null>(null)
  const storeLayerRef = useRef<L.LayerGroup | null>(null)

  // Init map sekali
  useEffect(() => {
    if (!containerRef.current) return
    let cancelled = false
    import('leaflet').then(L => {
      if (cancelled || !containerRef.current || mapRef.current) return
      mapRef.current = L.map(containerRef.current, {
        zoomControl: false, attributionControl: false,
      }).setView([-7.5, 110.5], 7)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
      }).addTo(mapRef.current)
      L.control.zoom({ position: 'bottomright' }).addTo(mapRef.current)
      L.control.attribution({ position: 'bottomleft', prefix: '© OpenStreetMap' })
        .addTo(mapRef.current)
      storeLayerRef.current = L.layerGroup().addTo(mapRef.current)
    })
    return () => {
      cancelled = true
      mapRef.current?.remove()
      mapRef.current = null
      storeLayerRef.current = null
    }
  }, [])

  // Re-render stores saat data berubah
  useEffect(() => {
    if (!storeLayerRef.current) return
    import('leaflet').then(L => {
      if (!storeLayerRef.current) return
      storeLayerRef.current.clearLayers()

      const valid = stores.filter(s => s.latitude != null && s.longitude != null)
      valid.forEach(s => {
        const color = storeStyles[s.customer_code] ?? '#0c9488'
        L.circleMarker([s.latitude!, s.longitude!], {
          radius: 4, fillColor: color, color: '#fff',
          weight: 1, opacity: 1, fillOpacity: 0.82,
        }).addTo(storeLayerRef.current!)
      })

      // Auto-fit ke bounds stores
      if (valid.length > 0 && mapRef.current) {
        const bounds = L.latLngBounds(
          valid.map(s => [s.latitude!, s.longitude!] as L.LatLngExpression),
        )
        mapRef.current.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 })
      }
    })
  }, [stores, storeStyles])

  return <div ref={containerRef} className="w-full h-full" />
}

// ─────────────────────────────────────────────────────────────────────────────
// MetricCard
// ─────────────────────────────────────────────────────────────────────────────

function MetricCard({
  label, icon, value, badge, badgeColor, note, loading,
}: {
  label      : string
  icon       : string
  value      : string | number
  badge      : string
  badgeColor : 'teal' | 'gray' | 'error'
  note       : string
  loading    : boolean
}) {
  return (
    <div
      className="bg-surface-container-lowest border border-secondary/10 p-md rounded-xl flex flex-col justify-between min-h-[120px] hover:shadow-md transition-all cursor-default"
      style={{ transition: 'transform 0.15s ease, box-shadow 0.15s ease' }}
      onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-4px)')}
      onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}
    >
      <div className="flex justify-between items-start">
        <span className="font-label-md text-label-md text-on-surface-variant tracking-wider">{label}</span>
        <span className="material-symbols-outlined text-on-primary-container p-xs rounded-lg"
              style={{ background: 'rgba(218,226,253,0.3)' }}>
          {icon}
        </span>
      </div>
      <div className="mt-auto">
        {loading ? (
          <div className="flex items-center gap-xs">
            <span className="material-symbols-outlined animate-spin text-on-surface-variant" style={{ fontSize: 20 }}>sync</span>
          </div>
        ) : (
          <span className="font-headline-lg text-headline-lg text-primary">{value}</span>
        )}
        <div className="flex items-center gap-xs mt-xs">
          {badge && (
            <span className="px-xs py-[2px] rounded text-[10px] font-bold"
                  style={
                    badgeColor === 'teal'
                      ? { color: '#0c9488', background: 'rgba(107,216,203,0.2)' }
                      : badgeColor === 'error'
                      ? { color: '#ba1a1a', background: 'rgba(255,218,214,0.4)' }
                      : { color: '#45464d', background: '#e0e3e5' }
                  }>
              {badge}
            </span>
          )}
          <span className="font-body-sm text-body-sm text-on-surface-variant truncate">{note}</span>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DashboardPage
// ─────────────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user }       = useAuth()
  const { activeArea } = useArea()
  const navigate       = useNavigate()

  const firstName = user?.full_name?.split(' ')[0] ?? 'Manager'
  const now       = new Date().toLocaleDateString('id-ID', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })

  // ── Data state ──────────────────────────────────────────────────────────────
  const [stores,      setStores]      = useState<StoreRow[]>([])
  const [plans,       setPlans]       = useState<PlanRow[]>([])
  const [assignments, setAssignments] = useState<AssignmentSimple[]>([])
  const [loadingMeta, setLoadingMeta] = useState(false)  // metric cards + plan list
  const [loadingMap,  setLoadingMap]  = useState(false)  // territory map

  useEffect(() => {
    if (!activeArea) {
      setStores([]); setPlans([]); setAssignments([])
      setLoadingMeta(false); setLoadingMap(false)
      return
    }

    let cancelled = false
    setLoadingMeta(true)
    setLoadingMap(true)

    Promise.all([
      supabase.rpc('get_stores_by_area', { p_area_id: activeArea.id }),
      supabase.rpc('get_plans_by_area',  { p_area_id: activeArea.id }),
    ]).then(([sr, pr]) => {
      if (cancelled) return
      const storeData = (sr.data ?? []) as StoreRow[]
      const planData  = (pr.data ?? []) as PlanRow[]
      setStores(storeData)
      setPlans(planData)
      setLoadingMeta(false)

      // Load assignments hanya untuk plan yang sudah disubmit
      const approved = planData.find(p => p.status === 'APPROVED')
      if (!approved) {
        setAssignments([])
        setLoadingMap(false)
        return
      }
      supabase.rpc('get_plan_assignments', { p_plan_id: approved.id }).then(ar => {
        if (cancelled) return
        setAssignments((ar.data ?? []) as AssignmentSimple[])
        setLoadingMap(false)
      })
    })

    return () => { cancelled = true }
  }, [activeArea])

  // ── Derived ─────────────────────────────────────────────────────────────────
  const activePlan  = plans.find(p => p.status === 'APPROVED')
  const draftCount  = plans.filter(p => p.status === 'DRAFT').length
  const salesAktif  = activePlan
    ? activePlan.divisions.reduce((s, d) => s + (d.n_sales || 0), 0)
    : 0
  const qcFlag      = stores.filter(s => !s.latitude || !s.longitude).length
  const totalActive = plans.filter(p => p.status !== 'ARCHIVED').length

  // Warna per salesperson dari assignments plan aktif
  const storeStyles = useMemo<Record<string, string>>(() => {
    if (assignments.length === 0) return {}
    const salesNames = [...new Set(assignments.map(a => a.sales_person_name))].sort()
    const m: Record<string, string> = {}
    for (const a of assignments) {
      const idx = salesNames.indexOf(a.sales_person_name)
      m[a.customer_code] = TERRITORY_COLORS[idx % TERRITORY_COLORS.length]
    }
    return m
  }, [assignments])

  // Legend items
  const legendItems = useMemo(() => {
    if (assignments.length === 0) return []
    const salesNames = [...new Set(assignments.map(a => a.sales_person_name))].sort()
    return salesNames.map((name, idx) => ({
      name,
      label: salesLabel(name),
      color: TERRITORY_COLORS[idx % TERRITORY_COLORS.length],
    }))
  }, [assignments])

  const metrics = [
    {
      label: 'TOTAL TOKO',  icon: 'storefront',
      value: activeArea ? stores.length : '—',
      badge: '',
      badgeColor: 'teal' as const,
      note: activeArea ? activeArea.nama_area : 'Pilih area untuk melihat data',
    },
    {
      label: 'SALES AKTIF', icon: 'groups',
      value: activeArea ? salesAktif : '—',
      badge: activePlan ? 'SUBMITTED' : '',
      badgeColor: 'teal' as const,
      note: activePlan ? 'Di-assign ke teritori' : 'Belum ada plan submitted',
    },
    {
      label: 'PLAN',        icon: 'route',
      value: activeArea ? totalActive : '—',
      badge: draftCount > 0 ? 'DRAFT' : activePlan ? 'SUBMITTED' : '',
      badgeColor: draftCount > 0 ? 'gray' as const : 'teal' as const,
      note: draftCount > 0
        ? `${draftCount} menunggu persetujuan`
        : activePlan ? 'Plan aktif di field' : 'Belum ada plan',
    },
    {
      label: 'QC FLAG',     icon: 'warning',
      value: activeArea ? qcFlag : '—',
      badge: qcFlag > 0 ? 'PERLU REVIEW' : activeArea && !loadingMeta ? 'CLEAR' : '',
      badgeColor: qcFlag > 0 ? 'error' as const : 'teal' as const,
      note: qcFlag > 0 ? 'Koordinat bermasalah' : activeArea ? 'Semua koordinat valid' : '—',
    },
  ]

  const recentPlans = [...plans]
    .sort((a, b) => (b.created_at > a.created_at ? 1 : -1))
    .slice(0, 4)

  const showMapOverlay =
    !activeArea ||
    (!loadingMeta && !loadingMap && stores.length === 0)

  return (
    <main className="px-margin-desktop py-lg max-w-[1600px] w-full mx-auto">

      {/* ── Greeting ──────────────────────────────────────────────────────── */}
      <section className="mb-lg">
        <h1 className="font-headline-lg-mobile md:font-headline-lg text-headline-lg-mobile md:text-headline-lg text-primary mb-xs">
          Selamat datang, {firstName}
        </h1>
        <p className="font-body-md text-body-md text-on-surface-variant">{now}</p>
      </section>

      {/* ── Metric cards ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-md mb-lg">
        {metrics.map(m => (
          <MetricCard key={m.label} {...m} loading={loadingMeta && !!activeArea} />
        ))}
      </div>

      {/* ── Command center ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-lg items-start">

        {/* ── Peta Teritori (2/3) ─────────────────────────────────────────── */}
        <div className="xl:col-span-2 bg-surface-container-lowest border border-secondary/10 rounded-xl overflow-hidden flex flex-col shadow-sm">

          {/* Map header */}
          <div className="p-md border-b border-secondary/10 flex justify-between items-center"
               style={{ background: '#f2f4f6' }}>
            <div className="flex items-center gap-sm flex-wrap">
              <h3 className="font-headline-md text-headline-md text-primary">Peta Teritori</h3>
              {activePlan ? (
                <span className="bg-primary/10 text-primary text-[10px] px-sm py-[3px] rounded-full font-bold border border-primary/20 font-data-mono">
                  {activePlan.plan_name}
                </span>
              ) : activeArea && !loadingMeta ? (
                <span className="text-[10px] px-sm py-[3px] rounded-full font-bold"
                      style={{ background: 'rgba(80,95,118,0.1)', color: '#9099a8' }}>
                  Belum ada plan submitted
                </span>
              ) : null}
            </div>
            <button
              onClick={() => activePlan
                ? navigate(`/plans/${activePlan.id}/map`)
                : navigate('/plans')}
              className="bg-primary text-on-primary px-sm py-xs rounded-lg font-label-md text-label-md flex items-center gap-xs hover:opacity-90 transition-opacity text-sm"
            >
              <span className="material-symbols-outlined text-[16px]">open_in_full</span>
              {activePlan ? 'Buka Peta' : 'Ke Plans'}
            </button>
          </div>

          {/* Map area */}
          <div className="relative" style={{ height: 460 }}>
            <LeafletMap stores={stores} storeStyles={storeStyles} />

            {/* Loading overlay */}
            {(loadingMeta || loadingMap) && !!activeArea && (
              <div className="absolute inset-0 z-[400] flex items-center justify-center pointer-events-none"
                   style={{ background: 'rgba(247,249,251,0.72)' }}>
                <div className="flex items-center gap-sm text-on-surface-variant">
                  <span className="material-symbols-outlined animate-spin" style={{ fontSize: 18 }}>sync</span>
                  <span className="text-xs">
                    {loadingMeta ? 'Memuat data…' : 'Memuat teritori…'}
                  </span>
                </div>
              </div>
            )}

            {/* Empty overlay */}
            {showMapOverlay && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none"
                   style={{ background: 'rgba(247,249,251,0.7)' }}>
                <div className="text-center">
                  <span className="material-symbols-outlined text-4xl block mb-2" style={{ color: '#c6c6cd' }}>
                    {!activeArea ? 'location_off' : 'storefront'}
                  </span>
                  <p className="font-headline-md text-headline-md text-primary">
                    {!activeArea ? 'Pilih area terlebih dahulu' : 'Belum ada data toko'}
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
                    {!activeArea
                      ? 'Gunakan Area Distribusi di kanan untuk mulai'
                      : 'Upload data toko dan generate plan untuk melihat peta'}
                  </p>
                </div>
              </div>
            )}

            {/* Legend teritori — muncul hanya jika ada assignments */}
            {legendItems.length > 0 && (
              <div className="absolute bottom-5 left-4 z-[400] flex flex-col gap-[4px] px-[8px] py-[7px] rounded-lg shadow-md"
                   style={{ background: 'rgba(255,255,255,0.95)', border: '1px solid rgba(80,95,118,0.12)' }}>
                <p className="text-[8px] font-bold tracking-widest uppercase mb-[2px]"
                   style={{ color: 'rgba(80,95,118,0.55)' }}>Teritori</p>
                {legendItems.map(item => (
                  <div key={item.name} className="flex items-center gap-[5px]">
                    <div className="w-[8px] h-[8px] rounded-[2px] shrink-0" style={{ background: item.color }} />
                    <span className="text-[9px] font-data-mono font-semibold text-on-surface">{item.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Sidebar (1/3) ───────────────────────────────────────────────── */}
        <div className="flex flex-col gap-lg">

          {/* Area Distribusi */}
          <div className="bg-surface-container-lowest border border-secondary/10 rounded-xl overflow-hidden shadow-sm">
            <div className="px-md py-sm flex items-center gap-sm"
                 style={{ background: '#f2f4f6', borderBottom: '1px solid rgba(80,95,118,0.1)' }}>
              <span className="material-symbols-outlined ms-fill" style={{ color: '#0c9488', fontSize: 16 }}>location_on</span>
              <h3 className="font-headline-md text-headline-md text-primary">Area Distribusi</h3>
            </div>
            <div className="p-md">
              <AreaPicker variant="card" />
            </div>
          </div>

          {/* Plan Terbaru */}
          <div className="bg-surface-container-lowest border border-secondary/10 rounded-xl overflow-hidden flex flex-col shadow-sm">
            <div className="p-md border-b border-secondary/10 flex justify-between items-center"
                 style={{ background: '#f2f4f6' }}>
              <h3 className="font-headline-md text-headline-md text-primary">Plan Terbaru</h3>
              {activeArea && (
                <span className="font-body-sm text-body-sm text-on-surface-variant">
                  {activeArea.nama_area}
                </span>
              )}
            </div>

            {/* Loading */}
            {loadingMeta && (
              <div className="flex items-center justify-center gap-sm py-lg text-on-surface-variant">
                <span className="material-symbols-outlined animate-spin" style={{ fontSize: 16 }}>sync</span>
                <span className="text-xs">Memuat plan…</span>
              </div>
            )}

            {/* Empty states */}
            {!loadingMeta && !activeArea && (
              <div className="px-md py-lg text-center">
                <span className="material-symbols-outlined text-3xl block mb-xs" style={{ color: '#c6c6cd' }}>location_off</span>
                <p className="text-xs text-on-surface-variant">Pilih area untuk melihat plan</p>
              </div>
            )}

            {!loadingMeta && activeArea && plans.length === 0 && (
              <div className="px-md py-lg text-center">
                <span className="material-symbols-outlined text-3xl block mb-xs" style={{ color: '#c6c6cd' }}>route</span>
                <p className="text-xs text-on-surface-variant">Belum ada plan untuk area ini</p>
                <button
                  onClick={() => navigate('/routing')}
                  className="mt-sm text-xs font-semibold underline"
                  style={{ color: '#0c9488' }}
                >
                  Buat plan pertama →
                </button>
              </div>
            )}

            {/* Plan list */}
            {!loadingMeta && recentPlans.length > 0 && (
              <div className="overflow-y-auto divide-y" style={{ borderColor: 'rgba(80,95,118,0.1)' }}>
                {recentPlans.map(p => (
                  <div
                    key={p.id}
                    className="p-md hover:bg-surface-container-low transition-colors cursor-pointer"
                    onClick={() => navigate('/plans')}
                  >
                    <div className="flex justify-between items-start mb-[2px]">
                      <span className="font-data-mono font-bold text-primary text-xs truncate flex-1 mr-xs">
                        {p.plan_name}
                      </span>
                      <StatusBadge status={p.status} />
                    </div>
                    <div className="flex items-center gap-xs text-[10px] text-on-surface-variant mt-xs">
                      <span className="material-symbols-outlined" style={{ fontSize: 11 }}>store</span>
                      <span>{p.store_count} toko</span>
                      <span>·</span>
                      <span className="material-symbols-outlined" style={{ fontSize: 11 }}>group</span>
                      <span>{p.divisions.reduce((s, d) => s + (d.n_sales || 0), 0)} sales</span>
                      <span>·</span>
                      <span className="material-symbols-outlined" style={{ fontSize: 11 }}>calendar_today</span>
                      <span>{fmtDate(p.created_at)}</span>
                    </div>

                    {/* Progress bar */}
                    <div className="w-full rounded-full overflow-hidden mt-sm" style={{ height: 4, background: '#eceef0' }}>
                      <div className="h-full rounded-full"
                           style={{
                             width: p.status === 'APPROVED' ? '100%' : p.status === 'DRAFT' ? '30%' : '100%',
                             background: p.status === 'APPROVED' ? '#0c9488' : '#c6c6cd',
                           }} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Footer */}
            <button
              onClick={() => navigate('/plans')}
              className="w-full p-md font-label-md text-label-md text-secondary border-t hover:bg-surface-container-high transition-colors bg-white sticky bottom-0"
              style={{ borderColor: 'rgba(80,95,118,0.1)' }}
            >
              LIHAT SEMUA PLAN
            </button>
          </div>

        </div>
      </div>
    </main>
  )
}

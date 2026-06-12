import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useArea } from '../../context/AreaContext'

// ─────────────────────────────────────────────────────────────────────────────
// Shared selects content — dipakai oleh kedua variant
// ─────────────────────────────────────────────────────────────────────────────

function AreaSelects({
  regions, cabangs, areas,
  selectedRegion, selectedCabang,
  loadingCabangs, loadingAreas,
  setSelectedRegion, setSelectedCabang,
  onSelectArea,
}: {
  regions: ReturnType<typeof useArea>['regions']
  cabangs: ReturnType<typeof useArea>['cabangs']
  areas:   ReturnType<typeof useArea>['areas']
  selectedRegion:  ReturnType<typeof useArea>['selectedRegion']
  selectedCabang:  ReturnType<typeof useArea>['selectedCabang']
  loadingCabangs:  boolean
  loadingAreas:    boolean
  setSelectedRegion: ReturnType<typeof useArea>['setSelectedRegion']
  setSelectedCabang: ReturnType<typeof useArea>['setSelectedCabang']
  onSelectArea: (id: string) => void
}) {
  return (
    <div className="space-y-sm">
      {/* Region */}
      <div className="space-y-xs">
        <label className="font-label-md text-label-md text-on-surface-variant" style={{ fontSize: 10 }}>REGION</label>
        <div className="relative">
          <select
            value={selectedRegion?.id ?? ''}
            onChange={e => setSelectedRegion(regions.find(r => r.id === e.target.value) ?? null)}
            className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm font-body-sm text-body-sm text-on-surface outline-none focus:border-on-tertiary-container appearance-none pr-8"
          >
            <option value="">— Pilih Region —</option>
            {regions.map(r => <option key={r.id} value={r.id}>{r.nama_region}</option>)}
          </select>
          <span className="material-symbols-outlined absolute right-sm top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none text-[14px]">expand_more</span>
        </div>
      </div>

      {/* Cabang */}
      <div className="space-y-xs">
        <label className="font-label-md text-label-md text-on-surface-variant" style={{ fontSize: 10 }}>CABANG</label>
        <div className="relative">
          <select
            value={selectedCabang?.id ?? ''}
            onChange={e => setSelectedCabang(cabangs.find(c => c.id === e.target.value) ?? null)}
            disabled={!selectedRegion || loadingCabangs}
            className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm font-body-sm text-body-sm text-on-surface outline-none focus:border-on-tertiary-container appearance-none pr-8 disabled:opacity-40"
          >
            <option value="">— Pilih Cabang —</option>
            {cabangs.map(c => <option key={c.id} value={c.id}>{c.nama_cabang}</option>)}
          </select>
          <span className={`material-symbols-outlined absolute right-sm top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none text-[14px] ${loadingCabangs ? 'animate-spin' : ''}`}>
            {loadingCabangs ? 'autorenew' : 'expand_more'}
          </span>
        </div>
      </div>

      {/* Area */}
      <div className="space-y-xs">
        <label className="font-label-md text-label-md text-on-surface-variant" style={{ fontSize: 10 }}>AREA / DEPO</label>
        <div className="relative">
          <select
            value=""
            onChange={e => onSelectArea(e.target.value)}
            disabled={!selectedCabang || loadingAreas}
            className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm font-body-sm text-body-sm text-on-surface outline-none focus:border-on-tertiary-container appearance-none pr-8 disabled:opacity-40"
          >
            <option value="">— Pilih Area —</option>
            {selectedCabang && !loadingAreas && areas.length === 0 && (
              <option disabled>Tidak ada area untuk cabang ini</option>
            )}
            {areas.map(a => <option key={a.id} value={a.id}>{a.nama_area} ({a.kd_dist}){a.status_code ? ` · ${a.status_code}` : ''}</option>)}
          </select>
          <span className={`material-symbols-outlined absolute right-sm top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none text-[14px] ${loadingAreas ? 'animate-spin' : ''}`}>
            {loadingAreas ? 'autorenew' : 'expand_more'}
          </span>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// AreaPicker — dua variant:
//   'dropdown' (default) → trigger button + floating dropdown (untuk header)
//   'card'               → selects selalu visible, tanpa trigger (untuk dashboard)
// ─────────────────────────────────────────────────────────────────────────────

export default function AreaPicker({ variant = 'dropdown' }: { variant?: 'dropdown' | 'card' }) {
  const {
    activeArea, setActiveArea,
    regions, cabangs, areas,
    selectedRegion, selectedCabang,
    setSelectedRegion, setSelectedCabang,
    loadingCabangs, loadingAreas,
  } = useArea()
  const navigate = useNavigate()

  const [open, setOpen]   = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Tutup jika klik di luar (dropdown only)
  useEffect(() => {
    if (variant === 'card') return
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [variant])

  function handleSelectArea(areaId: string) {
    const a = areas.find(x => x.id === areaId)
    if (!a || !selectedRegion || !selectedCabang) return
    setActiveArea({ ...a, cabang: selectedCabang, region: selectedRegion })
    if (variant === 'dropdown') setOpen(false)
  }

  // ── Card variant (inline di Dashboard) ───────────────────────────────────────
  if (variant === 'card') {
    return (
      <div className="flex flex-col gap-sm">
        <AreaSelects
          regions={regions} cabangs={cabangs} areas={areas}
          selectedRegion={selectedRegion} selectedCabang={selectedCabang}
          loadingCabangs={loadingCabangs} loadingAreas={loadingAreas}
          setSelectedRegion={setSelectedRegion} setSelectedCabang={setSelectedCabang}
          onSelectArea={handleSelectArea}
        />

        {/* Area terpilih + tombol routing */}
        {activeArea ? (
          <div className="flex items-center gap-sm pt-xs"
               style={{ borderTop: '1px solid rgba(80,95,118,0.1)' }}>
            <span className="material-symbols-outlined ms-fill shrink-0" style={{ color: '#0c9488', fontSize: 16 }}>check_circle</span>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm text-on-surface leading-tight truncate">{activeArea.nama_area}</p>
              <p className="text-[10px] text-on-surface-variant leading-tight">
                {activeArea.kd_dist} · {Number(activeArea.lat).toFixed(4)}, {Number(activeArea.lon).toFixed(4)}
              </p>
            </div>
            <button
              onClick={() => navigate('/routing')}
              className="shrink-0 flex items-center gap-xs px-sm py-xs bg-primary text-on-primary rounded-lg font-label-md text-label-md hover:bg-primary/90 transition-colors text-xs"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>route</span>
              Routing
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-on-surface-variant pt-xs" style={{ borderTop: '1px solid rgba(80,95,118,0.1)' }}>
            Pilih area di atas untuk mulai generate plan.
          </p>
        )}
      </div>
    )
  }

  // ── Dropdown variant (default — tetap ada di header untuk halaman selain routing) ──

  return (
    <div ref={ref} className="relative">
      {/* Trigger button */}
      <button
        onClick={() => setOpen(v => !v)}
        className="flex flex-col items-end gap-[1px] hover:opacity-80 transition-opacity"
      >
        <span className="text-xs font-semibold text-on-surface leading-none">
          {activeArea ? activeArea.nama_area : 'Pilih Area'}
        </span>
        <div className="flex items-center gap-xs">
          {activeArea
            ? <span className="text-[9px] font-bold px-1 rounded"
                    style={{ color: '#0c9488', background: 'rgba(107,216,203,0.15)' }}>
                {activeArea.kd_dist}
              </span>
            : <span className="text-[9px] font-bold px-1 rounded"
                    style={{ color: '#505f76', background: '#e0e3e5' }}>
                BELUM DIPILIH
              </span>
          }
          <span className="material-symbols-outlined text-on-surface-variant"
                style={{ fontSize: 14 }}>
            {open ? 'expand_less' : 'expand_more'}
          </span>
        </div>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-full mt-sm z-50 bg-surface-container-lowest border border-secondary/10 rounded-xl shadow-lg p-lg"
             style={{ width: 400, boxShadow: '0 8px 32px rgba(19,27,46,0.12)' }}>
          <p className="font-label-md text-label-md text-on-surface-variant mb-md">PILIH AREA DISTRIBUSI</p>
          <AreaSelects
            regions={regions} cabangs={cabangs} areas={areas}
            selectedRegion={selectedRegion} selectedCabang={selectedCabang}
            loadingCabangs={loadingCabangs} loadingAreas={loadingAreas}
            setSelectedRegion={setSelectedRegion} setSelectedCabang={setSelectedCabang}
            onSelectArea={handleSelectArea}
          />
          {activeArea && (
            <div className="mt-md pt-md border-t border-secondary/10 flex items-center gap-sm">
              <span className="material-symbols-outlined text-[16px]" style={{ color: '#0c9488' }}>check_circle</span>
              <div>
                <span className="font-label-md text-label-md text-on-surface">{activeArea.nama_area}</span>
                <span className="font-body-sm text-body-sm text-on-surface-variant ml-sm">
                  {Number(activeArea.lat).toFixed(4)}, {Number(activeArea.lon).toFixed(4)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

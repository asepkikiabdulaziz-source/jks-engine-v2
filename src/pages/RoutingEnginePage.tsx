import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Map as LeafletMap, Marker as LeafletMarker, LayerGroup } from 'leaflet'
import { useArea } from '../context/AreaContext'
import { supabase } from '../lib/supabase'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TERRITORY_COLORS = [
  '#e74c3c','#3498db','#27ae60','#f39c12',
  '#9b59b6','#1abc9c','#e67e22','#2980b9',
  '#c0392b','#16a085','#d35400','#8e44ad',
]

const DAY_COLORS: Record<string, string> = {
  'Senin':'#ef4444','Selasa':'#3b82f6','Rabu':'#22c55e',
  'Kamis':'#f59e0b','Jumat':'#a855f7','Sabtu':'#06b6d4','Minggu':'#f97316',
}

const DAY_ABBREV: Record<string,string> = {
  'Senin':'Sen','Selasa':'Sel','Rabu':'Rab',
  'Kamis':'Kam','Jumat':'Jum','Sabtu':'Sab','Minggu':'Min',
}
const DAY_ORDER = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu']

const WEEK_GANJIL_COLOR = '#6366f1'  // indigo — M2C13 (minggu 1 & 3)
const WEEK_GENAP_COLOR  = '#f97316'  // orange — M2C24 (minggu 2 & 4)

const WEEK_LABEL_GANJIL = 'M2C13'   // pekan ganjil (1, 3, 5…)
const WEEK_LABEL_GENAP  = 'M2C24'   // pekan genap  (2, 4, 6…)

const TOLERANCE_OPTIONS = [
  { value:0.05, label:'±5%'  },
  { value:0.10, label:'±10%' },
  { value:0.15, label:'±15%' },
  { value:0.20, label:'±20%' },
  { value:0.30, label:'±30%' },
]

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Cycle      = 'M1' | 'M2'
type Philosophy = 'BLOCKING' | 'TRAFFIC'
type DivStage   = 'idle'|'s1_running'|'s1_done'|'s2_running'|'s2_preview'|'s2_saving'|'s2_done'

interface StorePoint {
  customer_code   : string
  customer_name   : string
  longitude       : number
  latitude        : number
  div_sls         : string | null
  visit_frequency : string | null
  omset           : number | null
  gadm_kecamatan  : string | null
  gadm_kelurahan  : string | null
}

interface DivisionConfig {
  id                : string
  div_sls           : string
  store_count       : number
  n_sales           : string
  work_days         : string
  cycle             : Cycle
  philosophy        : Philosophy
  balance_tolerance : number
  expanded          : boolean
}

interface DaySchedule {
  day_of_week    : string
  store_count    : number
  customer_codes : string[]
  ganjil_codes   : string[]
  genap_codes    : string[]
}
interface SalesSchedule {
  sales_name : string
  days       : DaySchedule[]
}
interface Territory {
  sales_index    : number
  sales_name     : string
  store_count    : number
  centroid_lat   : number
  centroid_lon   : number
  customer_codes : string[]
}
interface DivisionState {
  stage       : DivStage
  territories?: Territory[]
  schedule?   : SalesSchedule[]
  plan_id?    : string
  plan_name?  : string
  error?      : string
}

// Snapshot untuk undo/redo — payload yang bisa diedit manual per divisi
interface DivSnapshot {
  territories?: Territory[]
  schedule?   : SalesSchedule[]
}
interface DivHistory {
  past   : DivSnapshot[]
  future : DivSnapshot[]
}

interface SelectedDayFilter {
  day_of_week   : string
  customer_codes: string[]
  ganjil_codes  : string[]
  genap_codes   : string[]
  isM2          : boolean
}

interface SelectedSales {
  divId            : string
  salesName        : string
  salesIdx         : number
  dayMap?          : Record<string, string[]>   // semua hari sales ini (per-sales view)
  dayFilter?       : SelectedDayFilter           // filter ke hari+minggu tertentu
  weekView?        : 'ganjil' | 'genap'         // filter ke satu minggu saja
  dayViewSalesMap? : Record<string, string[]>   // per-hari view: sales_name → codes di hari itu
}

interface StoreStyle { fillColor:string; label?:string }
type StoreStyleMap = Record<string, StoreStyle>

interface ClickPos { x: number; y: number }

interface SelectedStore {
  store   : StorePoint
  divId   : string        // divisi yang memiliki toko ini
  stage   : DivStage
  pos     : ClickPos
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatOmset(v: number): string {
  if (v >= 1_000_000_000) return `${(v/1_000_000_000).toFixed(1)}M`
  if (v >= 1_000_000)     return `${(v/1_000_000).toFixed(1)}jt`
  if (v >= 1_000)         return `${(v/1_000).toFixed(0)}rb`
  return String(v)
}
function isDivisionValid(d: DivisionConfig): boolean {
  const ns = parseInt(d.n_sales,  10)
  const wd = parseInt(d.work_days,10)
  return !isNaN(ns)&&ns>=1&&ns<=200 && !isNaN(wd)&&wd>=1&&wd<=7
}
function deriveDivisions(stores: StorePoint[], prev: DivisionConfig[]): DivisionConfig[] {
  const prevMap = new Map(prev.map(d=>[d.id,d]))
  const counts  = new Map<string,number>()
  stores.forEach(s => { const k=s.div_sls??'—'; counts.set(k,(counts.get(k)??0)+1) })
  return [...counts.entries()].sort((a,b)=>b[1]-a[1]).map(([code,count],i) => {
    const ex = prevMap.get(code)
    if (ex) return { ...ex, store_count:count }
    return { id:code,div_sls:code,store_count:count,n_sales:'',work_days:'6',
             cycle:'M1' as Cycle,philosophy:'BLOCKING' as Philosophy,
             balance_tolerance:0.10,expanded:i===0 }
  })
}
// "1000596-TX2DA-01" → "TX2DA-SLS-01"  (div prefix agar tidak bingung antar divisi)
function salesLabel(name: string): string {
  const p = name.split('-')
  if (p.length < 2) return name
  const num    = p[p.length - 1]
  const middle = p.slice(1, -1).filter(x => x.toUpperCase() !== 'SLS')
  return middle.length > 0 ? `${middle.join('-')}-SLS-${num}` : `SLS ${num}`
}

// ─────────────────────────────────────────────────────────────────────────────
// PlanMap
// ─────────────────────────────────────────────────────────────────────────────

function PlanMap({ lat, lon, zoom, stores, storeStyles, selectedCodes, highlightCodes, onStoreClick, onMapInteract }: {
  lat:number; lon:number; zoom:number
  stores:StorePoint[]; storeStyles:StoreStyleMap
  selectedCodes?  : Set<string>
  highlightCodes? : Set<string>
  onStoreClick?   : (store: StorePoint, pos: ClickPos, isCtrl: boolean) => void
  onMapInteract?  : () => void
}) {
  const containerRef      = useRef<HTMLDivElement>(null)
  const mapRef            = useRef<LeafletMap    |null>(null)
  const markerRef         = useRef<LeafletMarker |null>(null)
  const storeLayerRef     = useRef<LayerGroup    |null>(null)
  const onClickRef        = useRef(onStoreClick)
  const onMapInteractRef  = useRef(onMapInteract)
  useEffect(() => { onClickRef.current       = onStoreClick  }, [onStoreClick])
  useEffect(() => { onMapInteractRef.current = onMapInteract }, [onMapInteract])

  useEffect(() => {
    if (!containerRef.current) return
    let disposed = false
    import('leaflet').then(L => {
      if (disposed||!containerRef.current||mapRef.current) return
      const map = L.map(containerRef.current,{zoomControl:false,attributionControl:false})
        .setView([lat,lon],zoom)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map)
      L.control.zoom({position:'bottomright'}).addTo(map)
      L.control.attribution({position:'bottomleft',prefix:'© OpenStreetMap'}).addTo(map)
      const depoIcon = L.divIcon({
        className:'',
        html:`<div style="background:#131b2e;color:#fff;border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);font-family:'Material Symbols Outlined';font-size:17px;">warehouse</div>`,
        iconSize:[34,34],iconAnchor:[17,17],popupAnchor:[0,-20],
      })
      markerRef.current = L.marker([lat,lon],{icon:depoIcon}).addTo(map)
        .bindPopup(`<b>Depo</b><br>${lat.toFixed(5)}, ${lon.toFixed(5)}`)
      storeLayerRef.current = L.layerGroup().addTo(map)
      map.on('movestart zoomstart', () => { onMapInteractRef.current?.() })
      mapRef.current = map
    })
    return () => { disposed=true; mapRef.current?.remove(); mapRef.current=null; markerRef.current=null; storeLayerRef.current=null }
  },[]) // eslint-disable-line

  useEffect(() => {
    if (!mapRef.current||!markerRef.current) return
    mapRef.current.setView([lat,lon],zoom,{animate:true})
    markerRef.current.setLatLng([lat,lon])
  },[lat,lon,zoom])

  useEffect(() => {
    if (!storeLayerRef.current) return
    import('leaflet').then(L => {
      if (!storeLayerRef.current) return
      storeLayerRef.current.clearLayers()
      stores.forEach(s => {
        const style    = storeStyles[s.customer_code]
        const isSel    = selectedCodes?.has(s.customer_code) ?? false
        const isHi     = highlightCodes?.has(s.customer_code) ?? false
        const hiActive = (highlightCodes?.size ?? 0) > 0
        const color    = isSel ? '#f59e0b' : (style?.fillColor ?? '#0c9488')
        const border   = isSel ? '#d97706' : isHi ? '#111827' : '#fff'
        const radius   = isSel ? 7 : isHi ? 8 : 5
        const weight   = isSel ? 2 : isHi ? 3 : 1
        const fOp      = (hiActive && !isHi && !isSel) ? 0.4 : 0.9   // dim toko di luar wilayah terpilih
        L.circleMarker([s.latitude,s.longitude],{radius,fillColor:color,color:border,weight,opacity:1,fillOpacity:fOp})
          .addTo(storeLayerRef.current!)
          .on('click', (e) => {
            const le     = e as unknown as { containerPoint:{x:number;y:number}; originalEvent:MouseEvent }
            const pos    : ClickPos = { x: le.containerPoint.x, y: le.containerPoint.y }
            const isCtrl = le.originalEvent.ctrlKey || le.originalEvent.metaKey
            onClickRef.current?.(s, pos, isCtrl)
          })
      })
    })
  },[stores,storeStyles,selectedCodes,highlightCodes])

  return <div ref={containerRef} className="absolute inset-0" />
}

// ─────────────────────────────────────────────────────────────────────────────
// StoreInfoCard — overlay popup saat toko diklik di peta
// ─────────────────────────────────────────────────────────────────────────────

function StoreInfoCard({ sel, territories, schedule, philosophy, onReassign, onClose }: {
  sel         : SelectedStore
  territories : Territory[]
  schedule?   : SalesSchedule[]
  philosophy? : Philosophy
  onReassign  : (newSalesName: string) => void
  onClose     : () => void
}) {
  const { store, stage, pos } = sel
  const isTraffic = philosophy === 'TRAFFIC'

  const currentTerritory = territories.find(t => t.customer_codes.includes(store.customer_code))
  const currentSales     = currentTerritory?.sales_name ?? '—'
  const canReassign      = stage === 's1_done' && territories.length > 1

  // Cari hari + pekan dari schedule (tersedia saat s2_preview / s2_done)
  const scheduleInfo: { day_of_week: string; pekan: 'ganjil' | 'genap' | null } | null = (() => {
    if (!schedule) return null
    for (const ss of schedule) {
      for (const d of ss.days) {
        if (d.customer_codes.includes(store.customer_code)) {
          return {
            day_of_week : d.day_of_week,
            pekan       : d.ganjil_codes.includes(store.customer_code) ? 'ganjil'
                        : d.genap_codes.includes(store.customer_code)  ? 'genap'
                        : null,
          }
        }
      }
    }
    return null
  })()

  // Flip popup di bawah marker jika terlalu dekat tepi atas layar
  const flipBelow = pos.y < 230

  return (
    <div style={{
      position   : 'absolute',
      left       : pos.x,
      top        : flipBelow ? pos.y + 16 : pos.y - 16,
      transform  : flipBelow ? 'translateX(-50%)' : 'translate(-50%, -100%)',
      zIndex     : 1000,
      pointerEvents: 'none',
    }}>

      {/* Arrow atas (flip mode) */}
      {flipBelow && (
        <div style={{
          position: 'absolute', top: -7, left: '50%',
          transform: 'translateX(-50%) rotate(45deg)',
          width: 12, height: 12,
          background: '#f2f4f6',
          border: '1px solid rgba(80,95,118,0.15)',
          borderBottom: 'none', borderRight: 'none',
          pointerEvents: 'none',
        }} />
      )}

      {/* Card */}
      <div className="w-72 rounded-xl shadow-xl overflow-hidden"
           style={{ background: '#fff', border: '1px solid rgba(80,95,118,0.15)', pointerEvents: 'auto' }}>

        {/* Header */}
        <div className="flex items-start justify-between px-md py-sm"
             style={{ background: '#f2f4f6', borderBottom: '1px solid rgba(80,95,118,0.1)' }}>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm text-on-surface truncate">{store.customer_name}</p>
            <p className="text-[10px] text-on-surface-variant font-data-mono mt-[1px]">
              {store.customer_code} · {store.div_sls ?? '—'}
            </p>
          </div>
          <button onClick={onClose}
                  className="ml-sm shrink-0 w-6 h-6 rounded-lg flex items-center justify-center hover:bg-surface-container transition-colors"
                  style={{ color: '#9099a8' }}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
          </button>
        </div>

        {/* Body */}
        <div className="px-md py-sm space-y-sm">

          {/* Salesperson + omset */}
          <div className="flex items-center gap-xs">
            <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: 14 }}>person</span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-on-surface-variant">{isTraffic ? 'Zone Hari' : 'Salesperson'}</p>
              <p className="text-xs font-semibold text-on-surface font-data-mono truncate">{isTraffic ? currentSales : salesLabel(currentSales)}</p>
            </div>
            {store.omset != null && store.omset > 0 && (
              <div className="text-right shrink-0">
                <p className="text-[10px] text-on-surface-variant">Omset</p>
                <p className="text-xs font-bold font-data-mono" style={{ color: '#0c9488' }}>{formatOmset(store.omset)}</p>
              </div>
            )}
          </div>

          {/* Jadwal — hari + pekan (s2_preview / s2_done) */}
          {scheduleInfo ? (
            <div className="flex items-center gap-xs">
              <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: 14 }}>calendar_today</span>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] text-on-surface-variant">Jadwal</p>
                <div className="flex items-center gap-[6px] mt-[1px] flex-wrap">
                  <div className="flex items-center gap-[3px]">
                    <div className="w-[7px] h-[7px] rounded-full shrink-0"
                         style={{ background: DAY_COLORS[scheduleInfo.day_of_week] ?? '#9099a8' }} />
                    <span className="text-xs font-semibold text-on-surface">{scheduleInfo.day_of_week}</span>
                  </div>
                  {scheduleInfo.pekan && (
                    <span className="text-[10px] font-bold px-[5px] py-[1px] rounded-full"
                          style={{
                            color      : scheduleInfo.pekan === 'ganjil' ? WEEK_GANJIL_COLOR : WEEK_GENAP_COLOR,
                            background : scheduleInfo.pekan === 'ganjil' ? 'rgba(99,102,241,0.10)' : 'rgba(249,115,22,0.10)',
                          }}>
                      {scheduleInfo.pekan === 'ganjil' ? WEEK_LABEL_GANJIL : WEEK_LABEL_GENAP}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : (stage === 's1_done') && (
            <div className="flex items-center gap-xs">
              <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: 14 }}>calendar_today</span>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] text-on-surface-variant">Jadwal</p>
                <p className="text-[10px] text-on-surface-variant italic">Belum dijadwalkan</p>
              </div>
            </div>
          )}

          {/* Reassign — s1_done */}
          {canReassign && (
            <div style={{ borderTop: '1px solid rgba(80,95,118,0.08)', paddingTop: 8 }}>
              <p className="text-[10px] font-semibold text-on-surface-variant mb-xs">Pindahkan ke:</p>
              <select value="" onChange={e => { if (e.target.value) onReassign(e.target.value) }}
                      className="w-full text-xs font-semibold rounded-lg px-sm py-[6px] outline-none cursor-pointer"
                      style={{ border: '1px solid rgba(80,95,118,0.25)', color: '#1f2937', background: '#fff' }}>
                <option value="">pilih salesperson…</option>
                {territories
                  .filter(t => t.sales_name !== currentSales)
                  .map(t => {
                    const label = isTraffic ? t.sales_name : salesLabel(t.sales_name)
                    return <option key={t.sales_name} value={t.sales_name}>{label}</option>
                  })
                }
              </select>
              <p className="text-[9px] text-on-surface-variant mt-[6px] flex items-center gap-[4px]">
                <kbd className="px-[4px] py-[1px] rounded text-[9px] font-data-mono"
                     style={{ background: 'rgba(80,95,118,0.1)', border: '1px solid rgba(80,95,118,0.2)' }}>Ctrl</kbd>
                + klik untuk pilih banyak toko sekaligus
              </p>
            </div>
          )}

          {stage === 's1_done' && territories.length <= 1 && (
            <p className="text-[10px] text-on-surface-variant">
              {isTraffic ? 'Hanya 1 zone hari dalam divisi ini.' : 'Hanya 1 salesperson dalam divisi ini.'}
            </p>
          )}
          {stage === 'idle' && (
            <p className="text-[10px] text-on-surface-variant">Jalankan Stage 1 untuk melihat wilayah.</p>
          )}
        </div>
      </div>

      {/* Arrow bawah (normal mode) */}
      {!flipBelow && (
        <div style={{
          position: 'absolute', bottom: -7, left: '50%',
          transform: 'translateX(-50%) rotate(45deg)',
          width: 12, height: 12,
          background: '#fff',
          border: '1px solid rgba(80,95,118,0.15)',
          borderTop: 'none', borderLeft: 'none',
          pointerEvents: 'none',
        }} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// S2MovePicker — picker Hari × Pekan untuk pindah toko (s2_preview, Tahap 3)
// ─────────────────────────────────────────────────────────────────────────────

const S2_MOVE_DAYS = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu']
const S2_PATTERNS: Array<{key:'M1'|'M2C13'|'M2C24'; label:string; color:string}> = [
  { key:'M1',    label:'M1 · tiap pekan', color:'#0c9488' },
  { key:'M2C13', label:'M2C13 · ganjil',  color:WEEK_GANJIL_COLOR },
  { key:'M2C24', label:'M2C24 · genap',   color:WEEK_GENAP_COLOR },
]

function S2MovePicker({ divId, selList, schedule, onApply }: {
  divId    : string
  selList  : StorePoint[]
  schedule : SalesSchedule[]
  onApply  : (divId:string, codes:string[], day:string, pattern:'M1'|'M2C13'|'M2C24') => void
}) {
  const codes  = useMemo(()=>selList.map(s=>s.customer_code), [selList])
  const selSet = useMemo(()=>new Set(codes), [codes])
  // Hari & pola toko terpilih SAAT INI → default picker (kalau seragam)
  const cur = useMemo(()=>{
    const days=new Set<string>(), pats=new Set<string>()
    for (const ss of schedule) for (const d of ss.days) for (const c of d.customer_codes) {
      if (!selSet.has(c)) continue
      days.add(d.day_of_week)
      pats.add(d.ganjil_codes.includes(c) ? 'M2C13' : d.genap_codes.includes(c) ? 'M2C24' : 'M1')
    }
    return {
      day: days.size===1 ? [...days][0] : null,
      pat: pats.size===1 ? ([...pats][0] as 'M1'|'M2C13'|'M2C24') : null,
    }
  }, [schedule, selSet])

  const [pickDay,setPickDay] = useState<string|null>(null)
  const [pickPat,setPickPat] = useState<'M1'|'M2C13'|'M2C24'|null>(null)
  const effDay = pickDay ?? cur.day
  const effPat = pickPat ?? cur.pat

  // Berapa toko yang frekuensinya jadi beda dari visit_frequency-nya
  const freqWarn = useMemo(()=>{
    if (!effPat) return 0
    let n=0
    for (const s of selList) {
      const weekly=(s.visit_frequency??'').toUpperCase()==='WEEKLY'
      if ((weekly && effPat!=='M1') || (!weekly && effPat==='M1')) n++
    }
    return n
  }, [selList, effPat])

  const changed = !!effDay && !!effPat && (effDay!==cur.day || effPat!==cur.pat)

  return (
    <>
      <div className="w-px h-5 shrink-0" style={{ background:'rgba(255,255,255,0.15)' }}/>
      <label className="flex items-center gap-[4px] shrink-0">
        <span className="text-[10px]" style={{ color:'rgba(255,255,255,0.45)' }}>Hari</span>
        <select value={effDay ?? ''} onChange={e=>setPickDay(e.target.value)}
                className="text-[11px] font-semibold rounded-md px-[6px] py-[4px] outline-none cursor-pointer"
                style={{ background:'rgba(255,255,255,0.14)', color:'#fff', border:'1px solid rgba(255,255,255,0.22)' }}>
          {!effDay && <option value="" disabled style={{ color:'#111' }}>pilih…</option>}
          {S2_MOVE_DAYS.map(d=>(
            <option key={d} value={d} style={{ color:'#111' }}>{d}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-[4px] shrink-0">
        <span className="text-[10px]" style={{ color:'rgba(255,255,255,0.45)' }}>Pekan</span>
        <select value={effPat ?? ''} onChange={e=>setPickPat(e.target.value as 'M1'|'M2C13'|'M2C24')}
                className="text-[11px] font-semibold rounded-md px-[6px] py-[4px] outline-none cursor-pointer"
                style={{ background:'rgba(255,255,255,0.14)', color:'#fff', border:'1px solid rgba(255,255,255,0.22)' }}>
          {!effPat && <option value="" disabled style={{ color:'#111' }}>pilih…</option>}
          {S2_PATTERNS.map(p=>(
            <option key={p.key} value={p.key} style={{ color:'#111' }}>{p.label}</option>
          ))}
        </select>
      </label>
      {freqWarn>0 && (
        <span className="text-[10px] flex items-center gap-[3px] shrink-0" style={{ color:'#fbbf24' }}
              title="Pola pekan berbeda dari visit_frequency toko">
          <span className="material-symbols-outlined" style={{ fontSize:12 }}>warning</span>
          {freqWarn}
        </span>
      )}
      <button onClick={()=>{ if(effDay&&effPat) onApply(divId,codes,effDay,effPat) }}
              disabled={!changed}
              className="flex items-center gap-[4px] px-sm py-[4px] rounded-lg text-[11px] font-bold transition-all disabled:opacity-30 shrink-0"
              style={{ background:'#7c3aed', color:'#fff' }}>
        <span className="material-symbols-outlined" style={{ fontSize:13 }}>arrow_forward</span>
        Pindahkan
      </button>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MultiSelectBar — floating pill saat Ctrl+klik beberapa toko
// ─────────────────────────────────────────────────────────────────────────────

function MultiSelectBar({ selectedCodes, stores, omsetByCode, divisionStates, divisions, onReassignAll, onApplyMove, onClear }: {
  selectedCodes  : Set<string>
  stores         : StorePoint[]
  omsetByCode    : Record<string,number>
  divisionStates : Map<string,DivisionState>
  divisions      : DivisionConfig[]
  onReassignAll  : (divId:string, newSalesName:string) => void
  onApplyMove    : (divId:string, codes:string[], day:string, pattern:'M1'|'M2C13'|'M2C24') => void
  onClear        : () => void
}) {
  const selList    = stores.filter(s => selectedCodes.has(s.customer_code))
  const total      = selList.reduce((sum,s) => sum + (omsetByCode[s.customer_code] ?? 0), 0)
  const count      = selectedCodes.size

  const divIds     = [...new Set(selList.map(s => s.div_sls).filter(Boolean) as string[])]
  const singleDiv  = divIds.length === 1 ? divIds[0] : null
  const divState   = singleDiv ? divisionStates.get(singleDiv) : null
  const territories= divState?.territories ?? []
  const canReassign= singleDiv !== null && divState?.stage === 's1_done' && territories.length > 1
  const isTraffic  = singleDiv ? divisions.find(d => d.id === singleDiv)?.philosophy === 'TRAFFIC' : false
  const isS2       = singleDiv !== null && divState?.stage === 's2_preview' && !!divState?.schedule

  return (
    <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-[900] flex items-center gap-sm px-sm py-[8px] rounded-2xl shadow-2xl select-none"
         style={{ background:'rgba(15,23,42,0.88)', border:'1px solid rgba(255,255,255,0.1)', backdropFilter:'blur(12px)', maxWidth:'calc(100vw - 96px)' }}>

      {/* Count badge */}
      <div className="flex items-center gap-[4px] px-[8px] py-[2px] rounded-full shrink-0"
           style={{ background:'rgba(245,158,11,0.2)', border:'1px solid rgba(245,158,11,0.35)' }}>
        <span className="material-symbols-outlined ms-fill" style={{ color:'#fcd34d', fontSize:13 }}>layers</span>
        <span className="font-bold font-data-mono text-[13px]" style={{ color:'#fcd34d' }}>{count}</span>
        <span className="text-[10px]" style={{ color:'rgba(255,255,255,0.5)' }}>toko</span>
      </div>

      {/* Omset */}
      {total > 0 && (
        <>
          <div className="w-px h-5 shrink-0" style={{ background:'rgba(255,255,255,0.15)' }}/>
          <div className="flex items-center gap-[4px] shrink-0">
            <span className="material-symbols-outlined" style={{ color:'rgba(255,255,255,0.35)', fontSize:13 }}>monetization_on</span>
            <span className="font-bold font-data-mono text-[12px]" style={{ color:'#34d399' }}>{formatOmset(total)}</span>
          </div>
        </>
      )}

      {/* Pindah hari/pekan (s2_preview, Tahap 3) */}
      {isS2 && divState && divState.schedule && (
        <S2MovePicker divId={singleDiv!} selList={selList} schedule={divState.schedule} onApply={onApplyMove} />
      )}

      {/* Reassign targets → dropdown */}
      {canReassign && (
        <>
          <div className="w-px h-5 shrink-0" style={{ background:'rgba(255,255,255,0.15)' }}/>
          <label className="flex items-center gap-[4px] shrink-0">
            <span className="text-[10px]" style={{ color:'rgba(255,255,255,0.45)' }}>Pindahkan ke</span>
            <select value="" onChange={e=>{ if(e.target.value) onReassignAll(singleDiv!, e.target.value) }}
                    className="text-[11px] font-semibold rounded-md px-[6px] py-[4px] outline-none cursor-pointer"
                    style={{ background:'rgba(255,255,255,0.14)', color:'#fff', border:'1px solid rgba(255,255,255,0.22)' }}>
              <option value="" style={{ color:'#111' }}>pilih sales…</option>
              {territories.map(t => {
                // Sembunyikan jika semua toko yg dipilih sudah ada di territory ini
                const allHere = selList.every(s => t.customer_codes.includes(s.customer_code))
                if (allHere) return null
                const label = isTraffic ? t.sales_name : salesLabel(t.sales_name)
                return <option key={t.sales_name} value={t.sales_name} style={{ color:'#111' }}>{label}</option>
              })}
            </select>
          </label>
        </>
      )}

      {/* Multi-divisi warning */}
      {divIds.length > 1 && (
        <>
          <div className="w-px h-5 shrink-0" style={{ background:'rgba(255,255,255,0.15)' }}/>
          <span className="text-[10px] flex items-center gap-[3px] shrink-0" style={{ color:'#fbbf24' }}>
            <span className="material-symbols-outlined" style={{ fontSize:12 }}>warning</span>
            {divIds.length} divisi
          </span>
        </>
      )}

      {/* Clear */}
      <button onClick={onClear}
              className="ml-[2px] flex items-center justify-center w-6 h-6 rounded-full transition-colors hover:bg-white/15 shrink-0"
              style={{ color:'rgba(255,255,255,0.45)' }}>
        <span className="material-symbols-outlined" style={{ fontSize:14 }}>close</span>
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// StageChip
// ─────────────────────────────────────────────────────────────────────────────

function StageChip({ stage }: { stage:DivStage }) {
  const v: Record<DivStage,{label:string;color:string;bg:string}> = {
    idle:       {label:'Idle',        color:'#9099a8',bg:'rgba(80,95,118,0.10)'},
    s1_running: {label:'Partisi…',    color:'#b45309',bg:'rgba(234,179,8,0.15)'},
    s1_done:    {label:'Wilayah ✓',  color:'#1d4ed8',bg:'rgba(59,130,246,0.12)'},
    s2_running: {label:'Jadwal…',     color:'#b45309',bg:'rgba(234,179,8,0.15)'},
    s2_preview: {label:'Preview ✓',  color:'#7c3aed',bg:'rgba(124,58,237,0.12)'},
    s2_saving:  {label:'Simpan…',     color:'#b45309',bg:'rgba(234,179,8,0.15)'},
    s2_done:    {label:'Tersimpan ✓', color:'#0c9488',bg:'rgba(12,148,136,0.12)'},
  }
  const {label,color,bg} = v[stage]
  return <span className="text-[9px] font-bold px-[6px] py-[2px] rounded-full whitespace-nowrap shrink-0" style={{color,background:bg}}>{label}</span>
}

// ─────────────────────────────────────────────────────────────────────────────
// DivisionAccordion — panel KIRI, config SAJA
// ─────────────────────────────────────────────────────────────────────────────

function DivisionAccordion({ div, divState, onParamChange, onToggle, onRunStage1, onRunStage2, onReset }: {
  div          : DivisionConfig
  divState     : DivisionState
  onParamChange: (p:Partial<Pick<DivisionConfig,'n_sales'|'work_days'|'cycle'|'philosophy'|'balance_tolerance'>>) => void
  onToggle     : () => void
  onRunStage1  : () => void
  onRunStage2  : () => void
  onReset      : () => void
}) {
  const valid    = isDivisionValid(div)
  const { stage, plan_name, error } = divState
  const ns = parseInt(div.n_sales,  10)
  const wd = parseInt(div.work_days,10)
  const isRun    = stage==='s1_running'||stage==='s2_running'||stage==='s2_saving'
  const isPreview= stage==='s2_preview'
  const isDone   = stage==='s2_done'
  const hasWilayah = stage==='s1_done'||isPreview||isDone
  const isTraffic = div.philosophy === 'TRAFFIC'

  const borderColor = isDone?'rgba(12,148,136,0.45)':isPreview?'rgba(124,58,237,0.35)':hasWilayah?'rgba(59,130,246,0.35)':valid?'rgba(80,95,118,0.25)':'rgba(80,95,118,0.12)'

  return (
    <div className="rounded-xl border overflow-hidden" style={{borderColor}}>

      {/* Header */}
      <div role="button" tabIndex={0} onClick={onToggle}
           onKeyDown={e=>(e.key==='Enter'||e.key===' ')&&onToggle()}
           className="w-full flex items-center gap-xs px-sm py-sm cursor-pointer transition-colors hover:bg-surface-container select-none"
           style={{background:'#f2f4f6',borderBottom:div.expanded?'1px solid rgba(80,95,118,0.1)':undefined}}>
        <div className="w-[14px] h-[14px] rounded-full shrink-0 flex items-center justify-center"
             style={{background:isDone?'#0c9488':isPreview?'#7c3aed':valid?'#3b82f6':'#d0d4d9'}}>
          {(valid||isDone||isPreview)&&<span className="material-symbols-outlined text-white" style={{fontSize:9,fontVariationSettings:"'FILL' 1"}}>check</span>}
        </div>
        <span className="font-data-mono text-xs font-bold text-on-surface">{div.div_sls}</span>
        <span className="text-[10px] text-on-surface-variant">{div.store_count} toko</span>
        <div className="flex-1"/>
        {!div.expanded&&valid&&!isDone&&<span className="text-[10px] text-on-surface-variant font-data-mono mr-xs">{ns}S·{wd}h·{div.cycle}</span>}
        {isPreview&&!div.expanded&&<span className="text-[9px] font-bold mr-xs px-[5px] py-[1px] rounded-full" style={{color:'#7c3aed',background:'rgba(124,58,237,0.1)'}}>Preview</span>}
        {isDone&&plan_name&&!div.expanded&&<span className="text-[9px] text-primary font-data-mono mr-xs truncate max-w-[90px]">{plan_name}</span>}
        <StageChip stage={stage}/>
        <span className="material-symbols-outlined text-on-surface-variant ml-xs shrink-0" style={{fontSize:15}}>{div.expanded?'expand_less':'expand_more'}</span>
      </div>

      {/* Body — config only */}
      {div.expanded&&(
        <div className="flex flex-col gap-sm p-sm" style={{background:'#fff'}}>

          {/* Sales + Hari — urutan label S1/S2 berubah sesuai filosofi */}
          <div className="grid grid-cols-2 gap-xs">
            <div className="flex flex-col gap-[3px]">
              <label className="text-[9px] font-bold tracking-widest uppercase text-on-surface-variant flex items-center gap-[4px]">
                {isTraffic ? 'Hari / Siklus' : 'Jumlah Sales'}
                <span className="normal-case tracking-normal text-[8px] font-bold px-[4px] py-[1px] rounded-full"
                      style={{background:'rgba(59,130,246,0.12)',color:'#1d4ed8'}}>S1</span>
              </label>
              {isTraffic
                ? <input type="number" min={1} max={7} value={div.work_days}
                         onChange={e=>onParamChange({work_days:e.target.value})}
                         className="w-full px-sm py-xs border border-outline-variant rounded-lg font-data-mono text-on-surface text-xs outline-none focus:border-primary transition-colors"
                         style={{background:'#f7f9fb'}}/>
                : <input type="number" min={1} max={200} placeholder="cth: 5" value={div.n_sales}
                         onChange={e=>onParamChange({n_sales:e.target.value})}
                         className="w-full px-sm py-xs border border-outline-variant rounded-lg font-data-mono text-on-surface text-xs outline-none focus:border-primary transition-colors"
                         style={{background:'#f7f9fb'}}/>
              }
            </div>
            <div className="flex flex-col gap-[3px]">
              <label className="text-[9px] font-bold tracking-widest uppercase text-on-surface-variant flex items-center gap-[4px]">
                {isTraffic ? 'Sales / Zone' : 'Hari / Siklus'}
                <span className="normal-case tracking-normal text-[8px] font-bold px-[4px] py-[1px] rounded-full"
                      style={{background:'rgba(124,58,237,0.10)',color:'#7c3aed'}}>S2</span>
              </label>
              {isTraffic
                ? <input type="number" min={1} max={200} placeholder="cth: 2" value={div.n_sales}
                         onChange={e=>onParamChange({n_sales:e.target.value})}
                         className="w-full px-sm py-xs border border-outline-variant rounded-lg font-data-mono text-on-surface text-xs outline-none focus:border-primary transition-colors"
                         style={{background:'#f7f9fb'}}/>
                : <input type="number" min={1} max={7} value={div.work_days}
                         onChange={e=>onParamChange({work_days:e.target.value})}
                         className="w-full px-sm py-xs border border-outline-variant rounded-lg font-data-mono text-on-surface text-xs outline-none focus:border-primary transition-colors"
                         style={{background:'#f7f9fb'}}/>
              }
            </div>
          </div>

          {/* Siklus */}
          <div className="grid grid-cols-2 gap-xs">
            {(['M1','M2'] as const).map(c=>(
              <button key={c} type="button" onClick={()=>onParamChange({cycle:c})}
                      className={`py-xs rounded border text-[11px] font-semibold transition-all ${div.cycle===c?'border-primary bg-primary text-on-primary':'border-outline-variant text-on-surface hover:bg-surface-container'}`}
                      style={{background:div.cycle===c?undefined:'#f7f9fb'}}>
                {c==='M1'?'M1 · Weekly':'M2 · 2 Week'}
              </button>
            ))}
          </div>

          {/* Filosofi */}
          <div className="grid grid-cols-2 gap-xs">
            {([{value:'BLOCKING' as Philosophy,label:'Blocking',sub:'Sales-first'},{value:'TRAFFIC' as Philosophy,label:'Traffic',sub:'Day-first'}]).map(opt=>(
              <button key={opt.value} type="button" onClick={()=>onParamChange({philosophy:opt.value})}
                      className={`flex flex-col items-center py-sm rounded border text-[11px] font-semibold transition-all ${div.philosophy===opt.value?'border-primary bg-primary text-on-primary':'border-outline-variant text-on-surface hover:bg-surface-container'}`}
                      style={{background:div.philosophy===opt.value?undefined:'#f7f9fb'}}>
                <span>{opt.label}</span>
                <span className={`text-[9px] font-normal ${div.philosophy===opt.value?'text-on-primary/70':'text-on-surface-variant'}`}>{opt.sub}</span>
              </button>
            ))}
          </div>

          {/* Toleransi */}
          <div className="flex flex-col gap-[3px]">
            <label className="text-[9px] font-bold tracking-widest uppercase text-on-surface-variant">Toleransi Kerataan</label>
            <div className="flex gap-[3px]">
              {TOLERANCE_OPTIONS.map(opt=>(
                <button key={opt.value} type="button" onClick={()=>onParamChange({balance_tolerance:opt.value})}
                        className={`flex-1 py-[5px] rounded border text-[10px] font-semibold transition-all ${div.balance_tolerance===opt.value?'border-primary bg-primary text-on-primary':'border-outline-variant text-on-surface-variant hover:bg-surface-container'}`}
                        style={{background:div.balance_tolerance===opt.value?undefined:'#f7f9fb'}}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Kapasitas hint */}
          {valid&&(
            <div className="flex items-center gap-xs rounded px-sm py-xs" style={{background:'rgba(12,148,136,0.08)',border:'1px solid rgba(12,148,136,0.2)'}}>
              <span className="material-symbols-outlined" style={{color:'#0c9488',fontSize:13}}>calculate</span>
              <span className="text-[10px]" style={{color:'#0c9488'}}>
                {isTraffic
                  ? <>{wd} zone × {ns} sales = <b>{ns*wd}</b> rute/{div.cycle==='M1'?'minggu':'2 minggu'}</>
                  : <>{ns} × {wd} = <b>{ns*wd}</b> rute/{div.cycle==='M1'?'minggu':'2 minggu'}</>
                }
              </span>
            </div>
          )}

          <div style={{borderTop:'1px solid rgba(80,95,118,0.1)',margin:'2px 0'}}/>

          {/* Error */}
          {error&&(
            <div className="flex items-start gap-xs text-[10px] text-error rounded px-sm py-xs" style={{background:'rgba(186,26,26,0.06)',border:'1px solid rgba(186,26,26,0.15)'}}>
              <span className="material-symbols-outlined shrink-0" style={{fontSize:12}}>error</span>
              <span className="leading-tight">{error}</span>
            </div>
          )}

          {/* Spinner */}
          {isRun&&(
            <div className="flex items-center justify-center gap-xs py-xs text-[11px] text-on-surface-variant">
              <span className="material-symbols-outlined animate-spin" style={{fontSize:14}}>sync</span>
              <span>{stage==='s1_running'?(isTraffic?'Membagi zone hari…':'Membagi wilayah…'):stage==='s2_saving'?'Menyimpan plan…':'Membuat jadwal preview…'}</span>
            </div>
          )}

          {/* Plan tersimpan */}
          {isDone&&plan_name&&(
            <div className="flex items-center gap-xs text-[10px] px-xs" style={{color:'#0c9488'}}>
              <span className="material-symbols-outlined ms-fill" style={{fontSize:13}}>check_circle</span>
              <span className="font-data-mono font-bold">{plan_name}</span>
            </div>
          )}

          {/* Tombol aksi */}
          {!isRun&&!isDone&&valid&&(
            <div className="flex gap-xs">
              <button type="button" onClick={onRunStage1}
                      className={`flex-1 flex items-center justify-center gap-[4px] py-sm rounded-lg border text-[11px] font-semibold transition-colors ${hasWilayah?'border-blue-200 text-blue-600 hover:bg-blue-50':'border-outline-variant text-on-surface-variant hover:bg-surface-container'}`}
                      style={{background:hasWilayah?'rgba(59,130,246,0.06)':'#f7f9fb'}}>
                <span className="material-symbols-outlined" style={{fontSize:13}}>{hasWilayah?'refresh':(isTraffic?'calendar_view_week':'map')}</span>
                {hasWilayah?(isTraffic?'Ulang Zone Hari':'Ulang Wilayah'):(isTraffic?'Bagi Zone Hari':'Bagi Wilayah')}
              </button>
              <button type="button" onClick={onRunStage2} disabled={stage==='idle'}
                      title={stage==='idle'?'Bagi wilayah dulu':''}
                      className={`flex-1 flex items-center justify-center gap-[4px] py-sm rounded-lg border text-[11px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${isPreview?'border-violet-300 text-violet-600 hover:bg-violet-50':hasWilayah?'bg-primary text-on-primary border-primary hover:bg-primary/90':'border-outline-variant text-on-surface-variant'}`}
                      style={{background:isPreview?'rgba(124,58,237,0.06)':undefined}}>
                <span className="material-symbols-outlined" style={{fontSize:13}}>{isPreview?'refresh':'calendar_month'}</span>
                {isPreview?'Ulang Jadwal':'Generate Jadwal'}
              </button>
            </div>
          )}

          {/* Reset */}
          {stage!=='idle'&&!isRun&&(
            <button type="button" onClick={onReset}
                    className="w-full flex items-center justify-center gap-xs py-xs rounded-lg border text-[11px] font-semibold transition-colors hover:bg-error/5 hover:border-error/40 hover:text-error"
                    style={{borderColor:'rgba(80,95,118,0.2)',color:'#9099a8',background:'#f7f9fb'}}>
              <span className="material-symbols-outlined" style={{fontSize:13}}>restart_alt</span>
              Reset ke Idle
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CoverageAdjustDivView — tab "Wilayah": kecamatan→kelurahan→nama sales,
// + adjustment (pindahkan kelurahan antar sales) saat s1_done
// ─────────────────────────────────────────────────────────────────────────────

function CoverageAdjustDivView({ divId, territories, stores, canAdjust, onReassign, regionFilter }:{
  divId        : string
  territories  : Territory[]
  stores       : StorePoint[]
  canAdjust    : boolean
  onReassign   : (divId:string, codes:string[], toSales:string) => void
  regionFilter : { selected:Set<string>; toggle:(k:string)=>void; clear:()=>void }
}) {
  const [exKec, setExKec] = useState<Set<string>>(new Set())
  const [move,  setMove]  = useState<null|{scope:'kec'|'kel';label:string;sub:string;fromSales:string;codes:string[]}>(null)
  const toggle = (k:string)=>setExKec(p=>{const n=new Set(p);n.has(k)?n.delete(k):n.add(k);return n})

  const salesColor = useMemo(()=>{
    const m:Record<string,string>={}
    territories.forEach(t=>{m[t.sales_name]=TERRITORY_COLORS[t.sales_index%TERRITORY_COLORS.length]})
    return m
  },[territories])

  // code → {kec,kel}
  const gadm = useMemo(()=>{
    const m=new Map<string,{kec:string;kel:string}>()
    stores.forEach(s=>m.set(s.customer_code,{kec:s.gadm_kecamatan||'—',kel:s.gadm_kelurahan||'—'}))
    return m
  },[stores])

  // kecamatan → { bySales (level kec), kelurahan[] → bySales (level kel) }
  const tree = useMemo(()=>{
    const kecMap = new Map<string,{bySales:Map<string,string[]>;kels:Map<string,{kelurahan:string;total:number;bySales:Map<string,string[]>}>}>()
    territories.forEach(t=>t.customer_codes.forEach(code=>{
      const g = gadm.get(code); if(!g) return
      if(!kecMap.has(g.kec)) kecMap.set(g.kec,{bySales:new Map(),kels:new Map()})
      const kec = kecMap.get(g.kec)!
      if(!kec.bySales.has(t.sales_name)) kec.bySales.set(t.sales_name,[])
      kec.bySales.get(t.sales_name)!.push(code)
      if(!kec.kels.has(g.kel)) kec.kels.set(g.kel,{kelurahan:g.kel,total:0,bySales:new Map()})
      const kel = kec.kels.get(g.kel)!
      kel.total++
      if(!kel.bySales.has(t.sales_name)) kel.bySales.set(t.sales_name,[])
      kel.bySales.get(t.sales_name)!.push(code)
    }))
    return [...kecMap.entries()].map(([kec,v])=>{
      const kels = [...v.kels.values()].sort((a,b)=>b.total-a.total)
      return { kec, kels, bySales: v.bySales, total: kels.reduce((s,k)=>s+k.total,0), salesCount: v.bySales.size }
    }).sort((a,b)=>b.total-a.total)
  },[territories,gadm])

  // Helper: render chip nama sales (klik = buka modal pindah) — dipakai kec & kel
  const clickable = canAdjust && territories.length > 1
  const renderChips = (bySales:Map<string,string[]>, scope:'kec'|'kel', label:string, sub:string) => (
    <div className="flex flex-wrap gap-[3px] justify-end shrink-0" style={{maxWidth:116}}>
      {[...bySales.entries()].map(([sn,codes])=>{
        const c=salesColor[sn]??'#9099a8'
        return (
          <button key={sn} type="button" disabled={!clickable}
                  onClick={(e)=>{e.stopPropagation(); if(clickable) setMove({scope,label,sub,fromSales:sn,codes})}}
                  className="text-[8px] font-bold font-data-mono px-[4px] py-[1px] rounded leading-none"
                  style={{background:c+'22',color:c,cursor:clickable?'pointer':'default',outline:clickable?`1px solid ${c}55`:'none'}}
                  title={clickable?`Pindahkan ${codes.length} toko dari ${salesLabel(sn)}`:undefined}>
            {salesLabel(sn)}<span className="font-normal opacity-70">·{codes.length}</span>
          </button>
        )
      })}
    </div>
  )

  const totalKel   = useMemo(()=>tree.reduce((s,k)=>s+k.kels.length,0),[tree])
  const totalSplit = useMemo(()=>tree.reduce((s,k)=>s+k.kels.filter(x=>x.bySales.size>1).length,0),[tree])

  if (tree.length===0) return (
    <div className="px-md py-lg text-center text-[11px] text-on-surface-variant">Belum ada data wilayah.</div>
  )

  return (
    <div className="rounded-lg overflow-hidden" style={{border:'1px solid rgba(80,95,118,0.12)'}}>
      {/* Ringkasan */}
      <div className="px-sm py-[5px] flex items-center gap-md text-[9px] text-on-surface-variant"
           style={{background:'#fbfcfd',borderBottom:'1px solid rgba(80,95,118,0.08)'}}>
        <span>{tree.length} kec</span><span>{totalKel} kel</span>
        {totalSplit>0 && (
          <span className="flex items-center gap-[2px]" style={{color:'#b45309'}}>
            <span className="material-symbols-outlined" style={{fontSize:10}}>call_split</span>{totalSplit} terbelah
          </span>
        )}
        {regionFilter.selected.size>0
          ? <button type="button" onClick={regionFilter.clear}
                    className="ml-auto flex items-center gap-[2px] px-[5px] py-[1px] rounded-full"
                    style={{background:'rgba(124,58,237,0.12)',color:'#7c3aed'}}>
              <span className="material-symbols-outlined" style={{fontSize:10}}>filter_alt_off</span>hapus highlight
            </button>
          : <span className="ml-auto italic text-[8px]">klik nama→peta · chip→pindah</span>}
      </div>

      {tree.map(kec=>{
        const isEx=exKec.has(kec.kec)
        const kecKey=`kec:${kec.kec}`
        const kecSel=regionFilter.selected.has(kecKey)
        return (
          <div key={kec.kec}>
            {/* Header kecamatan: chevron=expand · nama=peta · chip=pindah */}
            <div className="flex items-center gap-[4px] px-sm py-[5px]"
                 style={{background:kecSel?'rgba(124,58,237,0.07)':'#f7f9fb',borderBottom:'1px solid rgba(80,95,118,0.08)',borderLeft:kecSel?'2px solid #7c3aed':'2px solid transparent'}}>
              <button type="button" onClick={()=>toggle(kec.kec)} className="shrink-0 flex items-center text-on-surface-variant">
                <span className="material-symbols-outlined" style={{fontSize:13}}>{isEx?'expand_more':'chevron_right'}</span>
              </button>
              <button type="button" onClick={()=>regionFilter.toggle(kecKey)} title="Tampilkan di peta"
                      className="flex-1 min-w-0 text-left flex items-center gap-[3px]">
                {kecSel && <span className="material-symbols-outlined" style={{fontSize:11,color:'#7c3aed'}}>place</span>}
                <span className="text-[10px] font-semibold truncate" style={{color:kecSel?'#7c3aed':'#191c1e'}}>{kec.kec}</span>
              </button>
              <span className="text-[9px] text-on-surface-variant shrink-0">{kec.kels.length} kel</span>
              <span className="text-[10px] font-data-mono text-on-surface shrink-0">{kec.total}</span>
              {/* Jumlah sales yang cover (read-only) — split bila >1, expand utk detail+pindah per kelurahan */}
              <span className="text-[9px] font-data-mono shrink-0 flex items-center gap-[1px]"
                    style={{color: kec.salesCount>1 ? '#b45309' : '#7c3aed'}}>
                {kec.salesCount>1 && <span className="material-symbols-outlined" style={{fontSize:10}}>call_split</span>}
                {kec.salesCount} sls
              </span>
            </div>
            {isEx && kec.kels.map((k,ki)=>{
              const split = k.bySales.size>1
              const kelKey=`kel:${kec.kec}|${k.kelurahan}`
              const kelSel=regionFilter.selected.has(kelKey)
              return (
                <div key={k.kelurahan} className="flex items-center gap-[6px] px-sm py-[5px] pl-[20px]"
                     style={{background:kelSel?'rgba(124,58,237,0.06)':ki%2===0?'#fff':'#fafbfc',borderBottom:'1px solid rgba(80,95,118,0.05)',borderLeft:kelSel?'2px solid #7c3aed':'2px solid transparent'}}>
                  <button type="button" onClick={()=>regionFilter.toggle(kelKey)} title="Tampilkan di peta"
                          className="flex-1 min-w-0 text-left flex items-center gap-[3px]">
                    {kelSel && <span className="material-symbols-outlined" style={{fontSize:10,color:'#7c3aed'}}>place</span>}
                    <span className="text-[10px] leading-snug truncate" style={{color:kelSel?'#7c3aed':'#191c1e'}}>{k.kelurahan}</span>
                    {split && <span className="material-symbols-outlined" style={{fontSize:10,color:'#b45309'}}>call_split</span>}
                  </button>
                  <span className="text-[10px] font-data-mono text-on-surface-variant shrink-0">{k.total}</span>
                  {renderChips(k.bySales,'kel',k.kelurahan,kec.kec)}
                </div>
              )
            })}
          </div>
        )
      })}

      {/* Modal pindah kelurahan */}
      {move && (
        <div className="fixed inset-0 z-[600] flex items-center justify-center p-lg" style={{background:'rgba(0,0,0,0.45)'}}
             onClick={e=>{if(e.target===e.currentTarget)setMove(null)}}>
          <div className="bg-surface-container-lowest rounded-xl shadow-2xl w-full flex flex-col" style={{maxWidth:'24rem'}}>
            <div className="flex items-start gap-md p-lg border-b border-secondary/10">
              <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{background:'rgba(124,58,237,0.1)'}}>
                <span className="material-symbols-outlined" style={{color:'#7c3aed',fontSize:18}}>swap_horiz</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-headline-md text-headline-md text-primary leading-tight">Pindahkan {move.scope==='kec'?'kecamatan':'kelurahan'}</p>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  <span className="font-semibold">{move.label}</span> · {move.sub} · {move.codes.length} toko<br/>
                  dari <span className="font-data-mono font-semibold" style={{color:salesColor[move.fromSales]}}>{salesLabel(move.fromSales)}</span> ke:
                </p>
              </div>
              <button onClick={()=>setMove(null)} className="p-xs rounded-lg hover:bg-surface-container text-on-surface-variant">
                <span className="material-symbols-outlined" style={{fontSize:18}}>close</span>
              </button>
            </div>
            <div className="p-md flex flex-col gap-xs max-h-[40vh] overflow-y-auto">
              {territories.filter(t=>t.sales_name!==move.fromSales).map(t=>{
                const c=salesColor[t.sales_name]??'#9099a8'
                return (
                  <button key={t.sales_name} type="button"
                          onClick={()=>{onReassign(divId,move.codes,t.sales_name);setMove(null)}}
                          className="flex items-center gap-sm px-md py-sm rounded-lg border transition-colors hover:bg-surface-container text-left"
                          style={{borderColor:'rgba(80,95,118,0.15)'}}>
                    <span className="w-[10px] h-[10px] rounded-[2px] shrink-0" style={{background:c}}/>
                    <span className="flex-1 font-data-mono text-sm font-semibold text-on-surface">{salesLabel(t.sales_name)}</span>
                    <span className="text-[11px] text-on-surface-variant font-data-mono">{t.store_count} toko</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Wilayah satu salesman (expand di tab Per Sales) — kecamatan→kelurahan + jml toko.
// Klik nama → highlight di peta (ter-scope ke toko salesman ini krn hanya itu yg visible).
function SalesWilayahView({ codes, stores, regionFilter }:{
  codes:string[]; stores:StorePoint[]
  regionFilter:{ selected:Set<string>; toggle:(k:string)=>void }
}) {
  const [exKec, setExKec] = useState<Set<string>>(new Set())
  const toggle = (k:string)=>setExKec(p=>{const n=new Set(p);n.has(k)?n.delete(k):n.add(k);return n})
  const gadm = useMemo(()=>{
    const m=new Map<string,{kec:string;kel:string}>()
    stores.forEach(s=>m.set(s.customer_code,{kec:s.gadm_kecamatan||'—',kel:s.gadm_kelurahan||'—'}))
    return m
  },[stores])
  const tree = useMemo(()=>{
    const kecMap=new Map<string,Map<string,number>>()
    codes.forEach(c=>{ const g=gadm.get(c); if(!g)return
      if(!kecMap.has(g.kec)) kecMap.set(g.kec,new Map())
      const km=kecMap.get(g.kec)!; km.set(g.kel,(km.get(g.kel)??0)+1) })
    return [...kecMap.entries()].map(([kec,km])=>({
      kec, total:[...km.values()].reduce((a,b)=>a+b,0),
      kels:[...km.entries()].map(([kel,n])=>({kel,n})).sort((a,b)=>b.n-a.n),
    })).sort((a,b)=>b.total-a.total)
  },[codes,gadm])
  if (tree.length===0) return <div className="px-[26px] py-[4px] text-[9px] text-on-surface-variant">—</div>
  return (
    <div className="py-[1px]" style={{background:'rgba(80,95,118,0.015)'}}>
      {tree.map(k=>{
        const isEx=exKec.has(k.kec)
        const kecKey=`kec:${k.kec}`
        const kecSel=regionFilter.selected.has(kecKey)
        return (
          <div key={k.kec}>
            <div className="flex items-center gap-[4px] px-[22px] py-[3px]"
                 style={{background:kecSel?'rgba(124,58,237,0.06)':undefined,borderLeft:kecSel?'2px solid #7c3aed':'2px solid transparent'}}>
              <button type="button" onClick={()=>toggle(k.kec)} className="shrink-0 flex items-center text-on-surface-variant">
                <span className="material-symbols-outlined" style={{fontSize:11}}>{isEx?'expand_more':'chevron_right'}</span>
              </button>
              <button type="button" onClick={()=>regionFilter.toggle(kecKey)} title="Highlight di peta"
                      className="flex-1 min-w-0 text-left flex items-center gap-[3px]">
                {kecSel && <span className="material-symbols-outlined" style={{fontSize:10,color:'#7c3aed'}}>place</span>}
                <span className="text-[9px] font-semibold truncate" style={{color:kecSel?'#7c3aed':'#191c1e'}}>{k.kec}</span>
              </button>
              <span className="text-[8px] text-on-surface-variant shrink-0">{k.kels.length} kel</span>
              <span className="text-[9px] font-data-mono text-on-surface shrink-0">{k.total}</span>
            </div>
            {isEx && k.kels.map(kel=>{
              const kelKey=`kel:${k.kec}|${kel.kel}`
              const kelSel=regionFilter.selected.has(kelKey)
              return (
                <div key={kel.kel} className="flex items-center gap-[5px] px-[38px] py-[2px]"
                     style={{background:kelSel?'rgba(124,58,237,0.05)':undefined,borderLeft:kelSel?'2px solid #7c3aed':'2px solid transparent'}}>
                  <button type="button" onClick={()=>regionFilter.toggle(kelKey)} title="Highlight di peta"
                          className="flex-1 min-w-0 text-left flex items-center gap-[3px]">
                    {kelSel && <span className="material-symbols-outlined" style={{fontSize:9,color:'#7c3aed'}}>place</span>}
                    <span className="text-[9px] truncate" style={{color:kelSel?'#7c3aed':'#45464d'}}>{kel.kel}</span>
                  </button>
                  <span className="text-[9px] font-data-mono text-on-surface-variant shrink-0">{kel.n}</span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SummaryPanel — panel KANAN: wilayah → jadwal → hari → ganjil/genap
// ─────────────────────────────────────────────────────────────────────────────

function SummaryPanel({
  divisions, divisionStates, omsetByCode, selectedSales, anyRunning, viewMode, stores,
  onSelectSales, onRunStage2, onSavePlan, onNavigatePlans, onHide, onViewModeChange, onReassignKelurahan, regionFilter,
}: {
  divisions          : DivisionConfig[]
  divisionStates     : Map<string,DivisionState>
  omsetByCode        : Record<string,number>
  selectedSales      : SelectedSales | null
  anyRunning         : boolean
  viewMode           : 'sales'|'day'|'wilayah'
  stores             : StorePoint[]
  onSelectSales      : (s:SelectedSales|null) => void
  onRunStage2        : (divId:string) => void
  onSavePlan         : () => void
  onNavigatePlans    : () => void
  onHide             : () => void
  onViewModeChange   : (mode:'sales'|'day'|'wilayah') => void
  onReassignKelurahan: (divId:string, codes:string[], toSales:string) => void
  regionFilter       : { selected:Set<string>; toggle:(k:string)=>void; clear:()=>void }
}) {
  // Expand state: keys = "divId||salesName" dan "divId||salesName||day"
  const [exSales,   setExSales]   = useState<Set<string>>(new Set())
  const [exDays,    setExDays]    = useState<Set<string>>(new Set())
  const [salesTab,  setSalesTab]  = useState<Record<string,'hari'|'wilayah'>>({})  // per-sales expand: Hari/Wilayah (Opsi A)

  const toggleSales = (k:string) => setExSales(p => { const n=new Set(p); n.has(k)?n.delete(k):n.add(k); return n })
  const toggleDay   = (k:string) => setExDays (p => { const n=new Set(p); n.has(k)?n.delete(k):n.add(k); return n })

  const divsWithData  = divisions.filter(d => divisionStates.get(d.id)?.territories?.length)
  const previewDivs   = divisions.filter(d => divisionStates.get(d.id)?.stage==='s2_preview')
  const anyDone       = divisions.some(d  => divisionStates.get(d.id)?.stage==='s2_done')

  return (
    <div className="absolute right-4 top-4 bottom-4 w-80 z-[400] flex flex-col rounded-xl shadow-xl overflow-hidden"
         style={{background:'#ffffff',border:'1px solid rgba(80,95,118,0.12)'}}>

      {/* ── Header ── */}
      <div className="shrink-0 flex items-center gap-xs px-sm py-sm"
           style={{background:'#f2f4f6',borderBottom:'1px solid rgba(80,95,118,0.1)'}}>
        <span className="material-symbols-outlined ms-fill shrink-0" style={{color:'#7c3aed',fontSize:18}}>analytics</span>
        <div className="flex-1 min-w-0 px-xs">
          <p className="font-headline-md text-headline-md text-primary leading-tight">Summary</p>
          <p className="text-[9px] text-on-surface-variant leading-tight">
            {selectedSales
              ? selectedSales.dayFilter
                ? <><span style={{color:'#7c3aed'}} className="font-semibold">{salesLabel(selectedSales.salesName)}</span>
                    {' · '}<span style={{color:DAY_COLORS[selectedSales.dayFilter.day_of_week]??'#999'}} className="font-semibold">{selectedSales.dayFilter.day_of_week}</span>
                    {' · klik ✕ reset'}
                  </>
                : <><span style={{color:'#7c3aed'}} className="font-semibold">{selectedSales.salesName}</span> · klik ✕ untuk reset</>
              : 'Klik baris sales untuk filter peta'}
          </p>
        </div>
        {selectedSales&&(
          <button type="button" onClick={()=>onSelectSales(null)} title="Hapus filter"
                  className="flex items-center justify-center w-6 h-6 rounded-lg hover:bg-surface-container transition-colors shrink-0" style={{color:'#7c3aed'}}>
            <span className="material-symbols-outlined" style={{fontSize:14}}>filter_alt_off</span>
          </button>
        )}
        <button type="button" onClick={onHide} title="Sembunyikan"
                className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-surface-container transition-colors text-on-surface-variant shrink-0">
          <span className="material-symbols-outlined" style={{fontSize:16}}>chevron_right</span>
        </button>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto">
        {divsWithData.map(div => {
          const st   = divisionStates.get(div.id)!
          const terr = st.territories!
          const sched= st.schedule
          const isM2 = div.cycle==='M2'
          const s1done= st.stage==='s1_done'
          const isTraffic = div.philosophy === 'TRAFFIC'
          // TRAFFIC s2_preview: territories = day-zones, tapi schedule per sales.
          // Derive virtual territories dari sched agar accordion bisa match correctly.
          const displayTerr: Territory[] = (isTraffic && sched && sched.length > 0)
            ? sched.map((ss, i) => ({
                sales_index    : i,
                sales_name     : ss.sales_name,
                store_count    : ss.days.reduce((s, d) => s + d.store_count, 0),
                centroid_lat   : 0,
                centroid_lon   : 0,
                customer_codes : ss.days.flatMap(d => d.customer_codes),
              }))
            : terr

          return (
            <div key={div.id} className="px-sm pt-sm pb-[2px]">

              {/* Divisi header */}
              <div className="flex items-center gap-xs mb-[5px]">
                <span className="font-data-mono text-[10px] font-bold text-on-surface">{div.div_sls}</span>
                <StageChip stage={st.stage}/>
                <div className="flex-1"/>
                {/* Tombol Generate Jadwal jika belum ada jadwal */}
                {(s1done)&&(
                  <button type="button" onClick={()=>onRunStage2(div.id)}
                          className="text-[9px] font-semibold flex items-center gap-[2px] px-[6px] py-[2px] rounded-lg transition-colors"
                          style={{background:'rgba(59,130,246,0.08)',border:'1px solid rgba(59,130,246,0.25)',color:'#1d4ed8'}}>
                    <span className="material-symbols-outlined" style={{fontSize:10}}>calendar_month</span>Generate Jadwal
                  </button>
                )}
              </div>

              {/* ── Summary metrics (s2_preview / s2_done) ── */}
              {sched && sched.length > 0 && (() => {
                const allDayCounts = sched.flatMap(ss => ss.days.map(d => d.store_count))
                const avg = allDayCounts.length ? (allDayCounts.reduce((a,b)=>a+b,0)/allDayCounts.length) : 0
                const minC = Math.min(...allDayCounts)
                const maxC = Math.max(...allDayCounts)
                const totalToko = terr.reduce((s,t)=>s+t.store_count, 0)
                const totalOmset = Object.keys(omsetByCode).length
                  ? terr.reduce((s,t)=>s+t.customer_codes.reduce((ss,c)=>ss+(omsetByCode[c]??0),0),0)
                  : 0
                return (
                  <div className="flex items-stretch gap-[4px] mb-[5px]">
                    {/* Avg per hari */}
                    <div className="flex-1 rounded-lg flex flex-col items-center justify-center py-[5px] px-[4px]"
                         style={{background:'rgba(59,130,246,0.07)',border:'1px solid rgba(59,130,246,0.15)'}}>
                      <span className="text-[9px] text-on-surface-variant leading-tight mb-[1px]">rata-rata/hari</span>
                      <span className="text-[13px] font-bold font-data-mono" style={{color:'#1d4ed8'}}>{avg.toFixed(1)}</span>
                    </div>
                    {/* Min-Max per sales per hari */}
                    <div className="flex-1 rounded-lg flex flex-col items-center justify-center py-[5px] px-[4px]"
                         style={{background:'rgba(80,95,118,0.05)',border:'1px solid rgba(80,95,118,0.12)'}}>
                      <span className="text-[9px] text-on-surface-variant leading-tight mb-[1px]">min–max</span>
                      <span className="text-[12px] font-bold font-data-mono text-on-surface">{minC}–{maxC}</span>
                    </div>
                    {/* Total toko */}
                    <div className="flex-1 rounded-lg flex flex-col items-center justify-center py-[5px] px-[4px]"
                         style={{background:'rgba(12,148,136,0.06)',border:'1px solid rgba(12,148,136,0.15)'}}>
                      <span className="text-[9px] text-on-surface-variant leading-tight mb-[1px]">total toko</span>
                      <span className="text-[13px] font-bold font-data-mono" style={{color:'#0c9488'}}>{totalToko}</span>
                    </div>
                    {/* Omset total (if available) */}
                    {totalOmset > 0 && (
                      <div className="flex-1 rounded-lg flex flex-col items-center justify-center py-[5px] px-[4px]"
                           style={{background:'rgba(124,58,237,0.05)',border:'1px solid rgba(124,58,237,0.12)'}}>
                        <span className="text-[9px] text-on-surface-variant leading-tight mb-[1px]">omset</span>
                        <span className="text-[12px] font-bold font-data-mono" style={{color:'#7c3aed'}}>{formatOmset(totalOmset)}</span>
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* Toggle Per Sales / Per Hari / Wilayah */}
              {(s1done || (sched && sched.length > 0)) && (
                <div className="flex mb-[6px] rounded-lg overflow-hidden" style={{border:'1px solid rgba(80,95,118,0.15)'}}>
                  <button type="button" onClick={()=>onViewModeChange('sales')}
                          className={`flex-1 flex items-center justify-center gap-[4px] py-[5px] text-[10px] font-semibold transition-colors ${viewMode==='sales'?'bg-primary text-on-primary':'text-on-surface-variant hover:bg-surface-container'}`}
                          style={{background:viewMode==='sales'?undefined:'#fff'}}>
                    <span className="material-symbols-outlined" style={{fontSize:11}}>person</span>Per Sales
                  </button>
                  {sched && sched.length > 0 && (
                  <button type="button" onClick={()=>onViewModeChange('day')}
                          className={`flex-1 flex items-center justify-center gap-[4px] py-[5px] text-[10px] font-semibold transition-colors border-l ${viewMode==='day'?'bg-primary text-on-primary':'text-on-surface-variant hover:bg-surface-container'}`}
                          style={{borderColor:'rgba(80,95,118,0.15)',background:viewMode==='day'?undefined:'#fff'}}>
                    <span className="material-symbols-outlined" style={{fontSize:11}}>calendar_today</span>Per Hari
                  </button>
                  )}
                  <button type="button" onClick={()=>onViewModeChange('wilayah')}
                          className={`flex-1 flex items-center justify-center gap-[4px] py-[5px] text-[10px] font-semibold transition-colors border-l ${viewMode==='wilayah'?'bg-primary text-on-primary':'text-on-surface-variant hover:bg-surface-container'}`}
                          style={{borderColor:'rgba(80,95,118,0.15)',background:viewMode==='wilayah'?undefined:'#fff'}}>
                    <span className="material-symbols-outlined" style={{fontSize:11}}>map</span>Wilayah
                  </button>
                </div>
              )}

              {/* Wilayah view (kecamatan→kelurahan + adjustment saat s1_done).
                  TRAFFIC: di s1_done teritori = zona HARI (bukan sales) → jangan tampilkan coverage
                  per-sales yang menyesatkan; per-sales baru valid setelah Generate Jadwal (s2_preview). */}
              {viewMode==='wilayah' ? (
                (isTraffic && !(sched && sched.length>0)) ? (
                  <div className="rounded-lg overflow-hidden px-md py-md flex items-start gap-sm"
                       style={{border:'1px solid rgba(234,179,8,0.3)',background:'rgba(234,179,8,0.06)'}}>
                    <span className="material-symbols-outlined shrink-0" style={{fontSize:14,color:'#b45309'}}>info</span>
                    <p className="text-[10px] text-on-surface-variant leading-snug">
                      <b>TRAFFIC</b> membagi per <b>hari</b> dulu — salesman ditentukan per hari saat Generate Jadwal.
                      Coverage &amp; adjustment per-sales muncul setelah jadwal dibuat.
                    </p>
                  </div>
                ) : (
                  <CoverageAdjustDivView divId={div.id} territories={displayTerr} stores={stores}
                                         canAdjust={s1done} onReassign={onReassignKelurahan} regionFilter={regionFilter}/>
                )
              ) : (
              <div className="rounded-lg overflow-hidden" style={{border:'1px solid rgba(80,95,118,0.12)'}}>

                {/* ── Per-Hari view ── */}
                {viewMode === 'day' && sched && sched.length > 0 && (() => {
                  // Agregasi: { day_of_week → [{salesName, salesIdx, codes, gc, ec}] }
                  const dayAgg: Record<string, Array<{salesName:string;salesIdx:number;codes:string[];gc:string[];ec:string[]}>> = {}
                  sched.forEach((ss, si) => {
                    ss.days.forEach(day => {
                      if (!dayAgg[day.day_of_week]) dayAgg[day.day_of_week] = []
                      dayAgg[day.day_of_week].push({
                        salesName: ss.sales_name, salesIdx: si,
                        codes: day.customer_codes, gc: day.ganjil_codes, ec: day.genap_codes,
                      })
                    })
                  })
                  return DAY_ORDER.filter(d => dayAgg[d]).map(dn => {
                    const entries = dayAgg[dn]
                    const dc      = DAY_COLORS[dn] ?? '#9099a8'
                    const total   = entries.reduce((s,r) => s + r.codes.length, 0)
                    const dayKey  = `${div.id}||day||${dn}`
                    const isEx    = exSales.has(dayKey)
                    const dvsm    = Object.fromEntries(entries.map(r => [r.salesName, r.codes]))
                    const isSel   = selectedSales?.divId===div.id && selectedSales?.salesName===dn
                                    && !!selectedSales?.dayViewSalesMap && !selectedSales?.dayFilter
                    return (
                      <div key={dn}>
                        {/* Day header row */}
                        <div className="flex items-center gap-[6px] px-sm py-[6px] cursor-pointer transition-colors"
                             style={{background:isSel?'rgba(59,130,246,0.05)':'transparent',borderBottom:'1px solid rgba(80,95,118,0.07)',borderLeft:isSel?`3px solid ${dc}`:'3px solid transparent'}}
                             onClick={()=>{ toggleSales(dayKey); if(isSel){onSelectSales(null);return} onSelectSales({divId:div.id,salesName:dn,salesIdx:-1,dayViewSalesMap:dvsm}) }}>
                          <div className="w-[8px] h-[8px] rounded-full shrink-0" style={{background:dc}}/>
                          <span className="flex-1 font-semibold text-[10px] text-on-surface">{dn}</span>
                          <span className="text-[10px] text-on-surface-variant font-data-mono shrink-0">{total} toko</span>
                          <span className="text-[9px] text-on-surface-variant shrink-0 ml-xs">{entries.length} sales</span>
                          <span className="material-symbols-outlined text-on-surface-variant shrink-0" style={{fontSize:12}}>{isEx?'expand_less':'expand_more'}</span>
                        </div>
                        {/* Expanded: per-sales sub-rows */}
                        {isEx && (
                          <div style={{borderBottom:'1px solid rgba(80,95,118,0.07)'}}>
                            {entries.map(r => {
                              const sc    = TERRITORY_COLORS[r.salesIdx % TERRITORY_COLORS.length]
                              const isSub = selectedSales?.divId===div.id && selectedSales?.salesName===r.salesName
                                            && selectedSales?.dayFilter?.day_of_week===dn
                              const omset = r.codes.reduce((s,c) => s+(omsetByCode[c]??0), 0)
                              return (
                                <div key={r.salesName}
                                     className="flex items-center gap-[6px] px-[26px] py-[4px] cursor-pointer transition-colors"
                                     style={{background:isSub?'rgba(59,130,246,0.05)':'rgba(80,95,118,0.01)',borderLeft:isSub?`2px solid ${sc}`:'2px solid transparent'}}
                                     onClick={()=>{
                                       if(isSub){onSelectSales({divId:div.id,salesName:dn,salesIdx:-1,dayViewSalesMap:dvsm});return}
                                       onSelectSales({divId:div.id,salesName:r.salesName,salesIdx:r.salesIdx,
                                         dayFilter:{day_of_week:dn,customer_codes:r.codes,ganjil_codes:r.gc,genap_codes:r.ec,isM2}})
                                     }}>
                                  <div className="w-[6px] h-[6px] rounded-[2px] shrink-0" style={{background:sc}}/>
                                  <span className="flex-1 font-data-mono text-[10px] font-semibold text-on-surface">{salesLabel(r.salesName)}</span>
                                  <span className="text-[10px] font-data-mono text-on-surface-variant shrink-0">{r.codes.length} toko</span>
                                  {omset>0&&<span className="text-[10px] font-data-mono shrink-0" style={{color:'#0c9488'}}>{formatOmset(omset)}</span>}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })
                })()}

                {/* ── Per-Sales view (default, atau saat belum ada jadwal) ── */}
                {(viewMode !== 'day' || !sched || !sched.length) && displayTerr.map((t,i) => {
                  // TRAFFIC s1_done → day colors; BLOCKING / TRAFFIC s2_preview → territory colors
                  const color    = (isTraffic && !sched)
                    ? (DAY_COLORS[t.sales_name] ?? TERRITORY_COLORS[t.sales_index%TERRITORY_COLORS.length])
                    : TERRITORY_COLORS[t.sales_index%TERRITORY_COLORS.length]
                  const salesKey = `${div.id}||${t.sales_name}`
                  const isExSales= exSales.has(salesKey)
                  const isSelThisSales = selectedSales?.divId===div.id && selectedSales?.salesName===t.sales_name
                  const omset    = t.customer_codes.reduce((s,c)=>s+(omsetByCode[c]??0),0)
                  const salesSch = sched?.find(s=>s.sales_name===t.sales_name)

                  return (
                    <div key={t.sales_name}>
                      {/* ── Sales row ── */}
                      <div
                        className="flex items-center gap-[6px] px-sm py-[6px] cursor-pointer transition-colors"
                        style={{
                          background: isSelThisSales?'rgba(124,58,237,0.06)':i%2===0?'#f7f9fb':'#fff',
                          borderBottom: (isExSales||i<terr.length-1)?'1px solid rgba(80,95,118,0.07)':undefined,
                          borderLeft: isSelThisSales?`3px solid ${color}`:'3px solid transparent',
                        }}
                        onClick={() => {
                          toggleSales(salesKey)
                          // Jika day filter aktif → klik sales kembali ke all-days view
                          if (isSelThisSales && !selectedSales?.dayFilter) { onSelectSales(null); return }
                          const dayMap = salesSch
                            ? Object.fromEntries(salesSch.days.map(d=>[d.day_of_week,d.customer_codes]))
                            : undefined
                          onSelectSales({ divId:div.id, salesName:t.sales_name, salesIdx:t.sales_index, dayMap })
                        }}
                      >
                        <div className="w-[8px] h-[8px] rounded-[2px] shrink-0" style={{background:color}}/>
                        <span className="flex-1 font-data-mono text-[10px] font-semibold text-on-surface">
                          {(isTraffic && !sched) ? t.sales_name : salesLabel(t.sales_name)}
                        </span>
                        <span className="text-[10px] text-on-surface-variant font-data-mono shrink-0">{t.store_count} toko</span>
                        {omset>0&&<span className="text-[10px] font-data-mono shrink-0" style={{color:'#0c9488'}}>{formatOmset(omset)}</span>}
                        <span className="material-symbols-outlined text-on-surface-variant shrink-0" style={{fontSize:12}}>
                          {isExSales?'expand_less':'expand_more'}
                        </span>
                      </div>

                      {/* ── Day rows (expand) ── */}
                      {isExSales&&(()=>{
                        const mode = salesSch ? (salesTab[salesKey] ?? 'hari') : 'wilayah'
                        return (
                        <div style={{borderBottom:i<terr.length-1?'1px solid rgba(80,95,118,0.07)':undefined}}>
                          {/* Mini-toggle Hari/Wilayah — hanya bila sudah ada jadwal */}
                          {salesSch&&(
                            <div className="flex items-center gap-[3px] px-[24px] py-[3px]" style={{background:'rgba(80,95,118,0.03)'}}>
                              <span className="material-symbols-outlined" style={{fontSize:10,color:'#9099a8'}}>swap_horiz</span>
                              {(['hari','wilayah'] as const).map(m=>(
                                <button key={m} type="button" onClick={()=>setSalesTab(p=>({...p,[salesKey]:m}))}
                                        className="px-[6px] py-[1px] rounded text-[8px] font-bold transition-colors"
                                        style={{background:mode===m?'rgba(124,58,237,0.14)':'transparent',color:mode===m?'#7c3aed':'#9099a8'}}>
                                  {m==='hari'?'Per Hari':'Wilayah'}
                                </button>
                              ))}
                            </div>
                          )}
                          {mode==='wilayah'?(
                            <SalesWilayahView codes={t.customer_codes} stores={stores} regionFilter={regionFilter}/>
                          ):(
                            salesSch!.days
                              .slice()
                              .sort((a,b)=>DAY_ORDER.indexOf(a.day_of_week)-DAY_ORDER.indexOf(b.day_of_week))
                              .map(day => {
                                const dayKey      = `${salesKey}||${day.day_of_week}`
                                const isExDay     = exDays.has(dayKey)
                                const hasWeeks    = isM2&&(day.ganjil_codes.length>0||day.genap_codes.length>0)
                                const dayColor    = DAY_COLORS[day.day_of_week]??'#9099a8'
                                const isDayActive = selectedSales?.divId===div.id&&selectedSales?.salesName===t.sales_name&&selectedSales?.dayFilter?.day_of_week===day.day_of_week

                                return (
                                  <div key={day.day_of_week}>
                                    {/* Day row — selalu klikable: filter peta ke hari ini */}
                                    <div
                                      className="flex items-center gap-[6px] px-[24px] py-[4px] transition-colors cursor-pointer"
                                      style={{
                                        background: isDayActive?'rgba(99,102,241,0.08)':isExDay?'rgba(80,95,118,0.04)':'rgba(80,95,118,0.02)',
                                        borderLeft: isDayActive?`2px solid ${dayColor}`:'2px solid transparent',
                                      }}
                                      onClick={()=>{
                                        if (hasWeeks) toggleDay(dayKey)
                                        if (isDayActive) {
                                          // Deselect hari → kembali ke all-days sales view
                                          const dm = salesSch ? Object.fromEntries(salesSch.days.map(d=>[d.day_of_week,d.customer_codes])) : undefined
                                          onSelectSales({ divId:div.id, salesName:t.sales_name, salesIdx:t.sales_index, dayMap:dm })
                                        } else {
                                          onSelectSales({ divId:div.id, salesName:t.sales_name, salesIdx:t.sales_index,
                                            dayMap: salesSch ? Object.fromEntries(salesSch.days.map(d=>[d.day_of_week,d.customer_codes])) : undefined,
                                            dayFilter:{ day_of_week:day.day_of_week, customer_codes:day.customer_codes, ganjil_codes:day.ganjil_codes, genap_codes:day.genap_codes, isM2 },
                                          })
                                        }
                                      }}
                                    >
                                      <div className="w-[6px] h-[6px] rounded-full shrink-0" style={{background:dayColor}}/>
                                      <span className="flex-1 text-[10px] font-semibold" style={{color:isDayActive?'#3b3f4a':'#45464d'}}>
                                        {day.day_of_week}
                                      </span>
                                      <span className="text-[10px] font-data-mono text-on-surface-variant shrink-0">
                                        {day.store_count} toko
                                      </span>
                                      {hasWeeks&&(
                                        <span className="material-symbols-outlined text-on-surface-variant shrink-0" style={{fontSize:10}}>
                                          {isExDay?'expand_less':'expand_more'}
                                        </span>
                                      )}
                                    </div>

                                    {/* Ganjil/Genap rows */}
                                    {isExDay&&hasWeeks&&(
                                      <div style={{background:'rgba(80,95,118,0.03)'}}>
                                        <div className="flex items-center gap-[6px] px-[40px] py-[3px]">
                                          <div className="w-[5px] h-[5px] rounded-full shrink-0" style={{background:WEEK_GANJIL_COLOR}}/>
                                          <span className="text-[9px] font-semibold flex-1" style={{color:WEEK_GANJIL_COLOR}}>{WEEK_LABEL_GANJIL}</span>
                                          <span className="text-[9px] font-data-mono text-on-surface">{day.ganjil_codes.length} toko</span>
                                        </div>
                                        <div className="flex items-center gap-[6px] px-[40px] py-[3px]">
                                          <div className="w-[5px] h-[5px] rounded-full shrink-0" style={{background:WEEK_GENAP_COLOR}}/>
                                          <span className="text-[9px] font-semibold flex-1" style={{color:WEEK_GENAP_COLOR}}>{WEEK_LABEL_GENAP}</span>
                                          <span className="text-[9px] font-data-mono text-on-surface">{day.genap_codes.length} toko</span>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )
                              })
                          )}
                        </div>
                        )
                      })()}
                    </div>
                  )
                })}

                {/* TOTAL row */}
                <div className="flex items-center gap-[6px] px-sm py-[6px]"
                     style={{borderTop:'1px solid rgba(80,95,118,0.15)',background:'rgba(12,148,136,0.04)'}}>
                  <div className="w-[8px] h-[8px] shrink-0"/>
                  <span className="flex-1 text-[10px] font-bold text-on-surface">TOTAL</span>
                  <span className="text-[10px] font-bold font-data-mono text-on-surface shrink-0">
                    {displayTerr.reduce((s,t)=>s+t.store_count,0)} toko
                  </span>
                  {Object.keys(omsetByCode).length>0&&(
                    <span className="text-[10px] font-bold font-data-mono shrink-0" style={{color:'#0c9488'}}>
                      {formatOmset(displayTerr.reduce((s,t)=>s+t.customer_codes.reduce((ss,c)=>ss+(omsetByCode[c]??0),0),0))}
                    </span>
                  )}
                </div>
              </div>
              )}

            </div>
          )
        })}

        <div className="h-sm"/>
      </div>

      {/* ── Footer ── */}
      {(previewDivs.length>0||anyDone)&&(
        <div className="shrink-0" style={{borderTop:'1px solid rgba(80,95,118,0.1)'}}>
          {previewDivs.length>0&&(
            <div className="px-sm pt-sm pb-[6px]">
              <p className="text-[9px] font-bold tracking-widest uppercase mb-[4px]" style={{color:'rgba(124,58,237,0.8)'}}>Siap Disimpan</p>
              {previewDivs.map(d=>(
                <div key={d.id} className="flex items-center gap-xs text-[10px] text-on-surface-variant py-[1px]">
                  <span className="material-symbols-outlined ms-fill" style={{color:'#7c3aed',fontSize:11}}>check_circle</span>
                  <span className="font-data-mono font-semibold">{d.div_sls}</span>
                  <span>{d.store_count} toko · {d.n_sales} sales</span>
                </div>
              ))}
              <button type="button" disabled={anyRunning} onClick={onSavePlan}
                      className="w-full mt-[6px] flex items-center justify-center gap-xs py-sm rounded-xl font-label-md text-label-md text-sm transition-all disabled:opacity-40"
                      style={{background:'#7c3aed',color:'#fff'}}>
                <span className="material-symbols-outlined" style={{fontSize:15}}>save</span>
                Simpan Plan ({previewDivs.length} divisi)
              </button>
            </div>
          )}
          {anyDone&&(
            <button type="button" onClick={onNavigatePlans}
                    className="w-full flex items-center justify-center gap-xs py-sm font-label-md text-label-md text-sm border-t transition-colors hover:bg-surface-container-high"
                    style={{borderColor:'rgba(80,95,118,0.1)',color:'#0c9488',background:'#fff'}}>
              <span className="material-symbols-outlined" style={{fontSize:14}}>list_alt</span>
              Lihat Semua Plan
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// RoutingEnginePage
// ─────────────────────────────────────────────────────────────────────────────

export default function RoutingEnginePage() {
  const { activeArea } = useArea()
  const areaId         = activeArea?.id
  const navigate       = useNavigate()

  const [stores,         setStores]         = useState<StorePoint[]>([])
  const [storesLoading,  setStoresLoading]  = useState(false)
  const [divisions,      setDivisions]      = useState<DivisionConfig[]>([])
  const [divisionStates, setDivisionStates] = useState<Map<string,DivisionState>>(new Map())
  const [leftHidden,     setLeftHidden]     = useState(false)
  const [rightHidden,    setRightHidden]    = useState(false)
  const [selectedSales,  setSelectedSales]  = useState<SelectedSales|null>(null)
  const [summaryViewMode,setSummaryViewMode]= useState<'sales'|'day'|'wilayah'>('sales')
  const [selectedStore,  setSelectedStore]  = useState<SelectedStore|null>(null)
  const [multiSelected,  setMultiSelected]  = useState<Set<string>>(new Set())
  const [selectedRegions,setSelectedRegions]= useState<Set<string>>(new Set())  // tab Wilayah → filter peta (multi)
  const [editHistory,    setEditHistory]    = useState<Map<string,DivHistory>>(new Map())  // undo/redo per divisi

  // ── Load stores ──────────────────────────────────────────────────────────
  useEffect(() => {
    setStores([]); setDivisions([]); setDivisionStates(new Map()); setEditHistory(new Map())
    setSelectedSales(null); setSelectedStore(null); setMultiSelected(new Set()); setSelectedRegions(new Set())
    setSummaryViewMode('sales')
    if (!areaId) { setStoresLoading(false); return }
    let cancelled = false
    setStoresLoading(true)
    supabase.rpc('get_stores_by_area',{p_area_id:areaId}).then(({data})=>{
      if (!cancelled) { setStores((data as StorePoint[])??[]); setStoresLoading(false) }
    }, ()=>{ if (!cancelled) setStoresLoading(false) })
    return ()=>{ cancelled=true }
  },[areaId])

  useEffect(()=>{ if(stores.length===0){setDivisions([]);return}; setDivisions(prev=>deriveDivisions(stores,prev)) },[stores])

  useEffect(()=>{
    setDivisionStates(prev=>{
      const next=new Map(prev)
      divisions.forEach(d=>{ if(!next.has(d.id)) next.set(d.id,{stage:'idle'}) })
      for (const k of next.keys()) { if(!divisions.find(d=>d.id===k)) next.delete(k) }
      return next
    })
  },[divisions])

  function updateDivisionParam(id:string,patch:Partial<Pick<DivisionConfig,'n_sales'|'work_days'|'cycle'|'philosophy'|'balance_tolerance'>>) {
    setDivisions(prev=>prev.map(d=>d.id===id?{...d,...patch}:d))
    setDivisionStates(prev=>{ const cur=prev.get(id); if(!cur||cur.stage==='idle') return prev; return new Map(prev).set(id,{stage:'idle'}) })
    resetDivHistory(id)
    setSelectedSales(prev=>prev?.divId===id?null:prev)
  }
  function toggleExpand(id:string) { setDivisions(prev=>prev.map(d=>({...d,expanded:d.id===id?!d.expanded:false}))) }
  function resetDivision(id:string) {
    setDivisionStates(prev=>new Map(prev).set(id,{stage:'idle'}))
    resetDivHistory(id)
    setSelectedSales(prev=>prev?.divId===id?null:prev)
    setSelectedStore(prev=>prev?.divId===id?null:prev)
    setMultiSelected(new Set())
  }

  // ── Undo/redo: SATU sistem untuk semua modul adjustment manual ─────────
  // Reassign sales (popup/ctrl-klik/wilayah) + edit hari/pekan semuanya lewat
  // commitDivEdit → otomatis terekam. Snapshot {territories, schedule} per divisi.
  function commitDivEdit(divId:string, before:DivisionState, after:DivisionState) {
    setEditHistory(h=>{
      const cur=h.get(divId)??{past:[],future:[]}
      return new Map(h).set(divId,{ past:[...cur.past,{territories:before.territories,schedule:before.schedule}], future:[] })
    })
    setDivisionStates(prev=>new Map(prev).set(divId,after))
  }
  function resetDivHistory(divId:string) {
    setEditHistory(h=>{ if(!h.has(divId)) return h; const n=new Map(h); n.delete(divId); return n })
  }
  // Segarkan code-list di selectedSales dari schedule terbaru (anti tampilan basi).
  function refreshSelectedSales(sel:SelectedSales|null, schedule:SalesSchedule[]|undefined): SelectedSales|null {
    if (!sel || !schedule) return sel
    if (sel.dayViewSalesMap) return null   // per-hari view: rebuild non-trivial → clear demi aman
    const ss = schedule.find(s=>s.sales_name===sel.salesName)
    if (!ss) return null
    const dayMap = Object.fromEntries(ss.days.map(d=>[d.day_of_week,d.customer_codes]))
    if (sel.dayFilter) {
      const day = ss.days.find(d=>d.day_of_week===sel.dayFilter!.day_of_week)
      if (!day) return { ...sel, dayMap, dayFilter:undefined }
      return { ...sel, dayMap, dayFilter:{ ...sel.dayFilter, customer_codes:day.customer_codes, ganjil_codes:day.ganjil_codes, genap_codes:day.genap_codes } }
    }
    return { ...sel, dayMap }
  }
  function undoDiv(divId:string) {
    const hist=editHistory.get(divId); const cur=divisionStates.get(divId)
    if(!hist||hist.past.length===0||!cur) return
    const snap=hist.past[hist.past.length-1]
    setEditHistory(h=>{ const hh=h.get(divId)??{past:[],future:[]}; return new Map(h).set(divId,{ past:hh.past.slice(0,-1), future:[...hh.future,{territories:cur.territories,schedule:cur.schedule}] }) })
    setDivisionStates(ds=>new Map(ds).set(divId,{...cur,territories:snap.territories,schedule:snap.schedule}))
    setSelectedSales(prev=>prev?.divId===divId?refreshSelectedSales(prev,snap.schedule):prev)
    setSelectedStore(null); setMultiSelected(new Set())
  }
  function redoDiv(divId:string) {
    const hist=editHistory.get(divId); const cur=divisionStates.get(divId)
    if(!hist||hist.future.length===0||!cur) return
    const snap=hist.future[hist.future.length-1]
    setEditHistory(h=>{ const hh=h.get(divId)??{past:[],future:[]}; return new Map(h).set(divId,{ past:[...hh.past,{territories:cur.territories,schedule:cur.schedule}], future:hh.future.slice(0,-1) }) })
    setDivisionStates(ds=>new Map(ds).set(divId,{...cur,territories:snap.territories,schedule:snap.schedule}))
    setSelectedSales(prev=>prev?.divId===divId?refreshSelectedSales(prev,snap.schedule):prev)
    setSelectedStore(null); setMultiSelected(new Set())
  }

  // ── Store click (popup / multi-select) ───────────────────────────────
  function handleStoreClick(store: StorePoint, pos: ClickPos, isCtrl: boolean) {
    const divId    = store.div_sls ?? divisions[0]?.id ?? null
    if (!divId) return
    const divState = divisionStates.get(divId)

    if (isCtrl) {
      // Ctrl+klik → toggle multi-select (hanya saat ada data wilayah)
      if (!divState || divState.stage === 'idle') return
      setSelectedStore(null)
      setMultiSelected(prev => {
        const next = new Set(prev)
        if (next.has(store.customer_code)) next.delete(store.customer_code)
        else next.add(store.customer_code)
        return next
      })
      return
    }

    // Klik biasa → single popup, clear multi-select
    setMultiSelected(new Set())
    if (!divState || divState.stage === 'idle') return
    setSelectedStore({ store, divId, stage: divState.stage, pos })
  }

  // ── Territory reassignment (Tahap 2) ──────────────────────────────────
  function handleReassign(customerCode: string, fromDivId: string, newSalesName: string) {
    const cur = divisionStates.get(fromDivId)
    if (!cur?.territories || cur.stage !== 's1_done') return

    const newTerritories = cur.territories.map(t => {
      if (t.sales_name === newSalesName) {
        // Tambah ke territory tujuan
        return { ...t, customer_codes: [...t.customer_codes, customerCode], store_count: t.store_count + 1 }
      }
      if (t.customer_codes.includes(customerCode)) {
        // Hapus dari territory asal
        return { ...t, customer_codes: t.customer_codes.filter(c => c !== customerCode), store_count: t.store_count - 1 }
      }
      return t
    })

    commitDivEdit(fromDivId, cur, { ...cur, territories: newTerritories })
    // Update popup agar reflect salesperson baru
    setSelectedStore(prev => prev ? { ...prev } : null)
  }

  // ── Multi-select reassign (Ctrl+klik banyak toko) ─────────────────────
  function handleMultiReassign(divId: string, newSalesName: string) {
    const cur = divisionStates.get(divId)
    if (!cur?.territories || cur.stage !== 's1_done') return
    const codeSet = new Set(
      stores
        .filter(s => multiSelected.has(s.customer_code) && s.div_sls === divId)
        .map(s => s.customer_code)
    )
    if (codeSet.size === 0) return
    const newTerritories = cur.territories.map(t => {
      if (t.sales_name === newSalesName) {
        const toAdd = [...codeSet].filter(c => !t.customer_codes.includes(c))
        return { ...t, customer_codes: [...t.customer_codes, ...toAdd], store_count: t.store_count + toAdd.length }
      }
      const filtered = t.customer_codes.filter(c => !codeSet.has(c))
      return { ...t, customer_codes: filtered, store_count: filtered.length }
    })
    commitDivEdit(divId, cur, { ...cur, territories: newTerritories })
    setMultiSelected(new Set())
  }

  // ── Pindahkan kelurahan: set kode tertentu → sales lain (tab Wilayah) ──
  function handleReassignCodes(divId: string, codes: string[], toSales: string) {
    const cur = divisionStates.get(divId)
    if (!cur?.territories || cur.stage !== 's1_done') return
    const codeSet = new Set(codes)
    if (codeSet.size === 0) return
    const newTerritories = cur.territories.map(t => {
      if (t.sales_name === toSales) {
        const toAdd = [...codeSet].filter(c => !t.customer_codes.includes(c))
        return { ...t, customer_codes: [...t.customer_codes, ...toAdd], store_count: t.store_count + toAdd.length }
      }
      const filtered = t.customer_codes.filter(c => !codeSet.has(c))
      return { ...t, customer_codes: filtered, store_count: filtered.length }
    })
    commitDivEdit(divId, cur, { ...cur, territories: newTerritories })
  }

  // ── Pindah hari/pekan toko dalam satu sales (Tahap 3, s2_preview) ──────
  // targetPattern: 'M1' (tiap pekan) | 'M2C13' (ganjil) | 'M2C24' (genap).
  // Toko TETAP di sales asalnya — hanya hari & pola pekan yang berubah.
  function applyMove(divId: string, codes: string[], targetDay: string, targetPattern: 'M1'|'M2C13'|'M2C24') {
    const cur = divisionStates.get(divId)
    if (!cur?.schedule || cur.stage !== 's2_preview') return
    const moveSet = new Set(codes)
    if (moveSet.size === 0) return

    // Clone schedule (arrays) agar mutasi tak menyentuh snapshot lama (untuk undo)
    const sched: SalesSchedule[] = cur.schedule.map(ss => ({
      sales_name: ss.sales_name,
      days: ss.days.map(d => ({
        day_of_week   : d.day_of_week,
        store_count   : d.store_count,
        customer_codes: [...d.customer_codes],
        ganjil_codes  : [...d.ganjil_codes],
        genap_codes   : [...d.genap_codes],
      })),
    }))

    // Sales asal tiap kode (pindah tetap dalam sales yang sama)
    const salesOfCode = new Map<string,string>()
    sched.forEach(ss => ss.days.forEach(d => d.customer_codes.forEach(c => { if (moveSet.has(c)) salesOfCode.set(c, ss.sales_name) })))

    // 1. Cabut kode dari posisi lama
    sched.forEach(ss => ss.days.forEach(d => {
      d.customer_codes = d.customer_codes.filter(c => !moveSet.has(c))
      d.ganjil_codes   = d.ganjil_codes.filter(c => !moveSet.has(c))
      d.genap_codes    = d.genap_codes.filter(c => !moveSet.has(c))
    }))

    // 2. Taruh di hari tujuan dengan pola tujuan (dalam sales asal)
    moveSet.forEach(code => {
      const sn = salesOfCode.get(code); if (!sn) return
      const ss = sched.find(s => s.sales_name === sn); if (!ss) return
      let day = ss.days.find(d => d.day_of_week === targetDay)
      if (!day) { day = { day_of_week: targetDay, store_count: 0, customer_codes: [], ganjil_codes: [], genap_codes: [] }; ss.days.push(day) }
      if (!day.customer_codes.includes(code)) day.customer_codes.push(code)
      if (targetPattern === 'M2C13') day.ganjil_codes.push(code)
      else if (targetPattern === 'M2C24') day.genap_codes.push(code)
      // M1 → tidak masuk ganjil/genap (ganjil = genap = true di engine)
    })

    // 3. Rapikan: store_count, urut hari, buang hari kosong
    sched.forEach(ss => {
      ss.days.forEach(d => { d.store_count = d.customer_codes.length })
      ss.days = ss.days
        .filter(d => d.customer_codes.length > 0)
        .sort((a,b) => DAY_ORDER.indexOf(a.day_of_week) - DAY_ORDER.indexOf(b.day_of_week))
    })

    commitDivEdit(divId, cur, { ...cur, schedule: sched })
    setSelectedSales(prev => prev?.divId===divId ? refreshSelectedSales(prev, sched) : prev)
    setMultiSelected(new Set())
    setSelectedStore(null)
  }

  // ── Stage 1 ────────────────────────────────────────────────────────────
  async function runStage1(divSls:string) {
    const div=divisions.find(d=>d.id===divSls)
    if (!div||!isDivisionValid(div)||!activeArea) return
    setDivisionStates(prev=>new Map(prev).set(divSls,{stage:'s1_running'}))
    try {
      const {data:{session},error:se}=await supabase.auth.getSession()
      if(se||!session) throw new Error('Sesi expired')
      // engine same-origin bila VITE_ENGINE_URL kosong (deploy 1-container); set saat dev
      const eu=((window.__ENV__?.ENGINE_URL ?? import.meta.env.VITE_ENGINE_URL ?? '') as string).replace(/\/$/,'')
      const resp=await fetch(`${eu}/stage1`,{method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},
        body:JSON.stringify({area_id:activeArea.id,kd_dist:activeArea.kd_dist,depo_lat:Number(activeArea.lat),depo_lon:Number(activeArea.lon),
          divisions:[{div_sls:div.div_sls,n_sales:parseInt(div.n_sales,10),work_days:parseInt(div.work_days,10),philosophy:div.philosophy,balance_tolerance:div.balance_tolerance}]}),
        signal:AbortSignal.timeout(30_000)})
      if(!resp.ok){const b=await resp.json().catch(()=>({}));throw new Error(b.detail??`HTTP ${resp.status}`)}
      const data:{results:Array<{div_sls:string;territories:Territory[]}>}=await resp.json()
      const result=data.results.find(r=>r.div_sls===divSls)
      if(!result) throw new Error('Hasil tidak ditemukan')
      setDivisionStates(prev=>new Map(prev).set(divSls,{stage:'s1_done',territories:result.territories}))
      resetDivHistory(divSls)   // mulai sesi edit baru
      setRightHidden(false)   // buka panel kanan otomatis
    } catch(e) {
      setDivisionStates(prev=>new Map(prev).set(divSls,{stage:'idle',error:e instanceof Error?e.message:String(e)}))
    }
  }

  // ── Stage 2 — panggil /stage2 dengan territories (mungkin sudah diedit) ──
  async function runStage2(divId:string) {
    if (!activeArea) return
    const cur=divisionStates.get(divId)
    if (!cur?.territories) return   // butuh territories dari Stage 1
    setDivisionStates(prev=>new Map(prev).set(divId,{...cur,stage:'s2_running',error:undefined}))
    setSelectedSales(prev=>prev?.divId===divId?null:prev)
    setSelectedStore(prev=>prev?.divId===divId?null:prev)
    setMultiSelected(new Set())
    try {
      const {data:{session},error:se}=await supabase.auth.getSession()
      if(se||!session) throw new Error('Sesi expired')
      // engine same-origin bila VITE_ENGINE_URL kosong (deploy 1-container); set saat dev
      const eu=((window.__ENV__?.ENGINE_URL ?? import.meta.env.VITE_ENGINE_URL ?? '') as string).replace(/\/$/,'')
      const div=divisions.find(d=>d.id===divId)
      if(!div) throw new Error('Divisi tidak ditemukan')
      // Kirim territories yang mungkin sudah diedit user (Tahap 2)
      const territories=cur.territories.map(t=>({
        sales_index:t.sales_index,
        sales_name:t.sales_name,
        customer_codes:t.customer_codes,
      }))
      const resp=await fetch(`${eu}/stage2`,{method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},
        body:JSON.stringify({
          area_id:activeArea.id,kd_dist:activeArea.kd_dist,
          depo_lat:Number(activeArea.lat),depo_lon:Number(activeArea.lon),
          division:{div_sls:div.div_sls,n_sales:parseInt(div.n_sales,10),work_days:parseInt(div.work_days,10),
                    cycle:div.cycle,philosophy:div.philosophy,balance_tolerance:div.balance_tolerance},
          territories,
        }),
        signal:AbortSignal.timeout(60_000)})
      if(!resp.ok){const b=await resp.json().catch(()=>({}));throw new Error(b.detail??`HTTP ${resp.status}`)}
      const result:{div_sls:string;territories:Territory[];schedule:SalesSchedule[]}=await resp.json()
      setDivisionStates(prev=>new Map(prev).set(divId,{stage:'s2_preview',territories:result.territories,schedule:result.schedule}))
      resetDivHistory(divId)   // sesi edit jadwal baru (tak bisa undo tembus regenerate)
      setRightHidden(false)
    } catch(e) {
      setDivisionStates(prev=>{ const c=prev.get(divId); return new Map(prev).set(divId,{stage:c?.territories?'s1_done':'idle',territories:c?.territories,error:e instanceof Error?e.message:String(e)}) })
    }
  }

  // ── Save Plan — sertakan territories agar adjustments tidak hilang ────
  async function savePlan() {
    if (!activeArea) return
    const pvDivs=divisions.filter(d=>divisionStates.get(d.id)?.stage==='s2_preview')
    if(!pvDivs.length) return
    setDivisionStates(prev=>{ const n=new Map(prev); pvDivs.forEach(d=>{ const c=n.get(d.id); if(c) n.set(d.id,{...c,stage:'s2_saving',error:undefined}) }); return n })
    try {
      const {data:{session},error:se}=await supabase.auth.getSession()
      if(se||!session) throw new Error('Sesi expired')
      // engine same-origin bila VITE_ENGINE_URL kosong (deploy 1-container); set saat dev
      const eu=((window.__ENV__?.ENGINE_URL ?? import.meta.env.VITE_ENGINE_URL ?? '') as string).replace(/\/$/,'')
      const resp=await fetch(`${eu}/generate-plan`,{method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},
        body:JSON.stringify({area_id:activeArea.id,kd_dist:activeArea.kd_dist,depo_lat:Number(activeArea.lat),depo_lon:Number(activeArea.lon),dry_run:false,
          divisions:pvDivs.map(d=>{
            const st=divisionStates.get(d.id)
            return {
              div_sls:d.div_sls,
              n_sales:parseInt(d.n_sales,10),
              work_days:parseInt(d.work_days,10),
              cycle:d.cycle,
              philosophy:d.philosophy,
              balance_tolerance:d.balance_tolerance,
              // Sertakan territories jika ada — backend akan skip K-Means
              territories: st?.territories?.map(t=>({
                sales_index:t.sales_index,
                sales_name:t.sales_name,
                customer_codes:t.customer_codes,
              })) ?? null,
              // Jadwal hasil edit manual hari/pekan — HANYA bila ada editan;
              // engine pakai apa adanya (skip penjadwalan ulang)
              schedule_override: ((editHistory.get(d.id)?.past.length ?? 0) > 0 && st?.schedule)
                ? st.schedule.map(ss=>({
                    sales_name: ss.sales_name,
                    days: ss.days.map(dy=>({
                      day_of_week:    dy.day_of_week,
                      customer_codes: dy.customer_codes,
                      ganjil_codes:   dy.ganjil_codes,
                      genap_codes:    dy.genap_codes,
                    })),
                  }))
                : null,
            }
          })}),
        signal:AbortSignal.timeout(120_000)})
      if(!resp.ok){const b=await resp.json().catch(()=>({}));throw new Error(b.detail??`HTTP ${resp.status}`)}
      const result:{plan_id:string;plan_name:string}=await resp.json()
      setDivisionStates(prev=>{ const n=new Map(prev); pvDivs.forEach(d=>{ const c=n.get(d.id); if(c) n.set(d.id,{...c,stage:'s2_done',plan_id:result.plan_id,plan_name:result.plan_name}) }); return n })
    } catch(e) {
      const msg=e instanceof Error?e.message:String(e)
      setDivisionStates(prev=>{ const n=new Map(prev); pvDivs.forEach(d=>{ const c=n.get(d.id); if(c) n.set(d.id,{...c,stage:'s2_preview',error:msg}) }); return n })
    }
  }

  // ── Omset map ──────────────────────────────────────────────────────────
  const storeOmsetMap = useMemo(()=>{ const m:Record<string,number>={}; stores.forEach(s=>{ if(s.omset!=null&&s.omset>0) m[s.customer_code]=Number(s.omset) }); return m },[stores])

  // ── Active div (expanded in left panel) ───────────────────────────────
  const activeDivId = divisions.find(d=>d.expanded)?.id??null

  // ── Undo/redo: divisi yang difokuskan + status + listener keyboard ─────
  const focusedDivId = selectedSales?.divId ?? activeDivId ?? (divisions.length===1 ? divisions[0].id : null)
  const focusHist    = focusedDivId ? editHistory.get(focusedDivId) : undefined
  const canUndo      = (focusHist?.past.length   ?? 0) > 0
  const canRedo      = (focusHist?.future.length ?? 0) > 0
  const undoRedoRef  = useRef({ undo:()=>{}, redo:()=>{}, canUndo:false, canRedo:false })
  undoRedoRef.current = {
    undo: ()=>{ if(focusedDivId) undoDiv(focusedDivId) },
    redo: ()=>{ if(focusedDivId) redoDiv(focusedDivId) },
    canUndo, canRedo,
  }
  useEffect(()=>{
    function onKey(e:KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName==='INPUT' || tgt.tagName==='TEXTAREA' || tgt.isContentEditable)) return
      const k = e.key.toLowerCase()
      if (k==='z' && !e.shiftKey) { if (undoRedoRef.current.canUndo) { e.preventDefault(); undoRedoRef.current.undo() } }
      else if ((k==='z' && e.shiftKey) || k==='y') { if (undoRedoRef.current.canRedo) { e.preventDefault(); undoRedoRef.current.redo() } }
    }
    window.addEventListener('keydown', onKey)
    return ()=>window.removeEventListener('keydown', onKey)
  },[])

  // ── Panel kanan visible? ───────────────────────────────────────────────
  const hasRightData = divisions.some(d=>divisionStates.get(d.id)?.territories?.length)

  // ── Visible stores + styles ────────────────────────────────────────────
  // ── Wilayah (tab Wilayah): pilih kecamatan/kelurahan = HIGHLIGHT di peta (bukan filter) ──
  const inSelectedRegion = (s:StorePoint)=>{
    const kec=s.gadm_kecamatan||'—', kel=s.gadm_kelurahan||'—'
    return selectedRegions.has(`kec:${kec}`) || selectedRegions.has(`kel:${kec}|${kel}`)
  }
  const toggleRegion = (key:string)=>{
    // Single-select: klik wilayah lain mengganti pilihan; klik yg sama → lepas.
    // TIDAK clear selectedSales → highlight menyatu dgn fokus salesman (ter-scope ke toko salesman aktif).
    setSelectedRegions(prev=> prev.has(key) ? new Set() : new Set([key]))
  }
  const clearRegions = ()=>setSelectedRegions(new Set())
  // Kode toko di wilayah terpilih → peta perbesar + outline (warna fill tetap by sales, semua toko tetap tampil)
  const highlightCodes = useMemo(()=>{
    if (selectedRegions.size===0) return new Set<string>()
    const set=new Set<string>()
    stores.forEach(s=>{ if(inSelectedRegion(s)) set.add(s.customer_code) })
    return set
  },[stores,selectedRegions]) // eslint-disable-line react-hooks/exhaustive-deps

  const visibleStores = useMemo(()=>{
    if (selectedSales) {
      // 1. Filter ke hari tertentu (+ opsional filter ke satu minggu)
      if (selectedSales.dayFilter) {
        const df=selectedSales.dayFilter
        const base = selectedSales.weekView==='ganjil' ? df.ganjil_codes
                   : selectedSales.weekView==='genap'  ? df.genap_codes
                   : df.customer_codes
        const codes=new Set(base)
        return stores.filter(s=>codes.has(s.customer_code))
      }
      // 1.5 Per-Hari view: semua toko di hari ini (lintas semua sales)
      if (selectedSales.dayViewSalesMap) {
        const codes = new Set(Object.values(selectedSales.dayViewSalesMap).flat())
        return stores.filter(s => codes.has(s.customer_code))
      }
      // 2. Filter ke semua hari sales ini
      if (selectedSales.dayMap) {
        const codes=new Set(Object.values(selectedSales.dayMap).flat())
        return stores.filter(s=>codes.has(s.customer_code))
      }
      // 3. Territory-only mode
      // TRAFFIC s2_preview: territories = day-zones, tapi selectedSales.salesName = salesperson name.
      // Gunakan sched sebagai sumber kebenaran jika tersedia.
      const divDs = divisionStates.get(selectedSales.divId)
      const divPhil3 = divisions.find(d=>d.id===selectedSales.divId)?.philosophy
      if (divPhil3==='TRAFFIC' && divDs?.schedule && divDs.schedule.length>0) {
        const ss = divDs.schedule.find(s=>s.sales_name===selectedSales.salesName)
        if (ss) {
          const codes = new Set(ss.days.flatMap(d=>d.customer_codes))
          return stores.filter(s=>codes.has(s.customer_code))
        }
      }
      const t=divDs?.territories?.find(t=>t.sales_name===selectedSales.salesName)
      if (t) { const codes=new Set(t.customer_codes); return stores.filter(s=>codes.has(s.customer_code)) }
    }
    return activeDivId ? stores.filter(s=>s.div_sls===activeDivId) : stores
  },[stores,activeDivId,selectedSales,divisionStates,divisions])

  const storeStyles = useMemo<StoreStyleMap>(()=>{
    if (selectedSales) {
      // 1. Warna per minggu ganjil/genap (saat hari dipilih)
      if (selectedSales.dayFilter) {
        const { day_of_week, customer_codes, ganjil_codes, genap_codes, isM2 } = selectedSales.dayFilter
        const weekView = selectedSales.weekView
        const st:StoreStyleMap={}
        if (isM2 && (ganjil_codes.length>0||genap_codes.length>0)) {
          if (weekView==='ganjil') {
            ganjil_codes.forEach(c=>{ st[c]={fillColor:WEEK_GANJIL_COLOR,label:WEEK_LABEL_GANJIL} })
          } else if (weekView==='genap') {
            genap_codes.forEach(c=>{ st[c]={fillColor:WEEK_GENAP_COLOR,label:WEEK_LABEL_GENAP} })
          } else {
            const ganjilSet=new Set(ganjil_codes); const genapSet=new Set(genap_codes)
            customer_codes.forEach(c=>{
              if      (ganjilSet.has(c)) st[c]={fillColor:WEEK_GANJIL_COLOR,label:WEEK_LABEL_GANJIL}
              else if (genapSet.has(c))  st[c]={fillColor:WEEK_GENAP_COLOR, label:WEEK_LABEL_GENAP}
              else                       st[c]={fillColor:DAY_COLORS[day_of_week]??'#9099a8',label:'M1'}
            })
          }
        } else {
          const color=DAY_COLORS[day_of_week]??'#9099a8'
          customer_codes.forEach(c=>{ st[c]={fillColor:color,label:day_of_week} })
        }
        return st
      }
      // 1.5 Per-Hari view: warna per sales (biar bisa bedain siapa ke mana di hari yang sama)
      if (selectedSales.dayViewSalesMap) {
        const st: StoreStyleMap = {}
        Object.entries(selectedSales.dayViewSalesMap).forEach(([salesName, codes], idx) => {
          const color = TERRITORY_COLORS[idx % TERRITORY_COLORS.length]
          codes.forEach(c => { st[c] = { fillColor: color, label: salesLabel(salesName) } })
        })
        return st
      }
      // 2. Warna per hari (semua hari sales)
      if (selectedSales.dayMap) {
        const st:StoreStyleMap={}
        Object.entries(selectedSales.dayMap).forEach(([day,codes])=>{
          const color=DAY_COLORS[day]??'#9099a8'
          codes.forEach(c=>{ st[c]={fillColor:color,label:day} })
        })
        return st
      }
      // 3. Territory color
      // TRAFFIC s2_preview: territories = day-zones, selectedSales.salesName = salesperson name.
      // Gunakan sched sebagai sumber kebenaran jika tersedia.
      const selDs   = divisionStates.get(selectedSales.divId)
      const selPhil = divisions.find(d=>d.id===selectedSales.divId)?.philosophy
      if (selPhil==='TRAFFIC' && selDs?.schedule && selDs.schedule.length>0) {
        const ss = selDs.schedule.find(s=>s.sales_name===selectedSales.salesName)
        if (ss) {
          const idx   = selDs.schedule.indexOf(ss)
          const color = TERRITORY_COLORS[idx%TERRITORY_COLORS.length]
          const st:StoreStyleMap={}
          ss.days.forEach(d=>d.customer_codes.forEach(c=>{ st[c]={fillColor:color,label:salesLabel(ss.sales_name)} }))
          return st
        }
      }
      const t=selDs?.territories?.find(t=>t.sales_name===selectedSales.salesName)
      if (t) {
        const color=selPhil==='TRAFFIC'
          ?(DAY_COLORS[t.sales_name]??TERRITORY_COLORS[t.sales_index%TERRITORY_COLORS.length])
          :TERRITORY_COLORS[t.sales_index%TERRITORY_COLORS.length]
        const st:StoreStyleMap={}
        t.customer_codes.forEach(c=>{ st[c]={fillColor:color,label:t.sales_name} })
        return st
      }
    }
    if (!activeDivId) return {}
    const ds=divisionStates.get(activeDivId)
    if (!ds?.territories) return {}
    const divPhil=divisions.find(d=>d.id===activeDivId)?.philosophy
    // TRAFFIC + jadwal tersedia + mode Per Sales → warnai per salesman (bukan per day-zone)
    if (divPhil==='TRAFFIC' && ds.schedule && ds.schedule.length>0 && summaryViewMode==='sales') {
      const st:StoreStyleMap={}
      ds.schedule.forEach((ss,idx)=>{
        const color=TERRITORY_COLORS[idx%TERRITORY_COLORS.length]
        ss.days.forEach(day=>{ day.customer_codes.forEach(c=>{ st[c]={fillColor:color,label:salesLabel(ss.sales_name)} }) })
      })
      return st
    }
    // Default: warnai per territories (day-zones untuk TRAFFIC, per-sales untuk BLOCKING)
    const st:StoreStyleMap={}
    ds.territories.forEach(t=>{
      const color=divPhil==='TRAFFIC'
        ?(DAY_COLORS[t.sales_name]??TERRITORY_COLORS[t.sales_index%TERRITORY_COLORS.length])
        :TERRITORY_COLORS[t.sales_index%TERRITORY_COLORS.length]
      t.customer_codes.forEach(c=>{ st[c]={fillColor:color,label:t.sales_name} })
    })
    return st
  },[selectedSales,summaryViewMode,activeDivId,divisionStates,divisions])

  const mapLat  = activeArea?Number(activeArea.lat):-2.5
  const mapLon  = activeArea?Number(activeArea.lon):118
  const mapZoom = activeArea?12:5

  const anyRunning = divisions.some(d=>{ const s=divisionStates.get(d.id)?.stage; return s==='s1_running'||s==='s2_running'||s==='s2_saving' })

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="h-full relative overflow-hidden">

      <PlanMap lat={mapLat} lon={mapLon} zoom={mapZoom} stores={visibleStores} storeStyles={storeStyles}
               selectedCodes={multiSelected} highlightCodes={highlightCodes}
               onStoreClick={handleStoreClick}
               onMapInteract={() => setSelectedStore(null)}/>

      {/* ── Store Info Popup (Tahap 1 + 2) ─── */}
      {selectedStore && (() => {
        const divSt = divisionStates.get(selectedStore.divId)
        const terrs = divSt?.territories ?? []
        return (
          <StoreInfoCard
            sel={selectedStore}
            territories={terrs}
            schedule={divSt?.schedule}
            philosophy={divisions.find(d => d.id === selectedStore.divId)?.philosophy}
            onReassign={(newSalesName) => {
              handleReassign(selectedStore.store.customer_code, selectedStore.divId, newSalesName)
              // Update stage di card setelah reassign
              setSelectedStore(prev => prev ? { ...prev, stage: divSt?.stage ?? prev.stage } : null)
            }}
            onClose={() => setSelectedStore(null)}
          />
        )
      })()}

      {/* ── Multi-select bar ─── */}
      {multiSelected.size > 0 && (
        <MultiSelectBar
          selectedCodes={multiSelected}
          stores={stores}
          omsetByCode={storeOmsetMap}
          divisionStates={divisionStates}
          divisions={divisions}
          onReassignAll={handleMultiReassign}
          onApplyMove={applyMove}
          onClear={() => setMultiSelected(new Set())}
        />
      )}

      {/* ── Undo / Redo (semua adjustment manual) ─── */}
      {(canUndo||canRedo) && multiSelected.size===0 && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-[850] flex items-center gap-[2px] px-[4px] py-[4px] rounded-xl shadow-2xl select-none"
             style={{ background:'rgba(15,23,42,0.88)', border:'1px solid rgba(255,255,255,0.1)', backdropFilter:'blur(12px)' }}>
          <button onClick={()=>focusedDivId&&undoDiv(focusedDivId)} disabled={!canUndo} title="Urungkan (Ctrl+Z)"
                  className="flex items-center gap-[4px] px-sm py-[5px] rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-30 enabled:hover:bg-white/10"
                  style={{ color:'#fff' }}>
            <span className="material-symbols-outlined" style={{ fontSize:15 }}>undo</span>
            Urungkan
          </button>
          <div className="w-px h-4 shrink-0" style={{ background:'rgba(255,255,255,0.15)' }}/>
          <button onClick={()=>focusedDivId&&redoDiv(focusedDivId)} disabled={!canRedo} title="Ulangi (Ctrl+Shift+Z)"
                  className="flex items-center gap-[4px] px-sm py-[5px] rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-30 enabled:hover:bg-white/10"
                  style={{ color:'#fff' }}>
            <span className="material-symbols-outlined" style={{ fontSize:15 }}>redo</span>
            Ulangi
          </button>
        </div>
      )}

      {/* Overlay saat sales dipilih */}
      {selectedSales&&(
        <>
          {/* Pill indikator atas tengah */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[500] flex items-center gap-xs px-sm py-xs rounded-full shadow-lg"
               style={{background:'rgba(255,255,255,0.95)',border:'1px solid rgba(124,58,237,0.3)'}}>
            <span className="material-symbols-outlined ms-fill" style={{color:selectedSales.dayViewSalesMap?(DAY_COLORS[selectedSales.salesName]??'#7c3aed'):'#7c3aed',fontSize:13}}>
              {selectedSales.dayViewSalesMap?'calendar_today':'visibility'}
            </span>
            <span className="text-[11px] font-semibold text-on-surface">
              {selectedSales.dayViewSalesMap ? selectedSales.salesName : salesLabel(selectedSales.salesName)}
            </span>
            {selectedSales.dayFilter
              ? <span className="text-[10px] text-on-surface-variant">
                  · {selectedSales.dayFilter.day_of_week} · {selectedSales.dayFilter.customer_codes.length} toko
                  {selectedSales.dayFilter.isM2?' · warna minggu':''}
                </span>
              : selectedSales.dayViewSalesMap
              ? <span className="text-[10px] text-on-surface-variant">
                  · {Object.values(selectedSales.dayViewSalesMap).flat().length} toko · warna per sales
                </span>
              : selectedSales.dayMap
              ? <span className="text-[10px] text-on-surface-variant">· {Object.values(selectedSales.dayMap).flat().length} toko · warna hari</span>
              : <span className="text-[10px] text-on-surface-variant">· {divisionStates.get(selectedSales.divId)?.territories?.find(t=>t.sales_name===selectedSales.salesName)?.store_count??0} toko</span>
            }
            <button type="button" onClick={()=>setSelectedSales(null)}
                    className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-surface-container" style={{color:'#9099a8'}}>
              <span className="material-symbols-outlined" style={{fontSize:12}}>close</span>
            </button>
          </div>

          {/* Legend — ganjil/genap saat day filter M2, warna hari saat all-days */}
          {selectedSales.dayViewSalesMap ? (
            /* Per-Hari legend: warna per sales */
            <div className="absolute bottom-8 z-[500] flex flex-col gap-[4px] p-[8px] rounded-lg shadow-md"
                 style={{left:leftHidden?'16px':'340px',background:'rgba(255,255,255,0.96)',border:'1px solid rgba(80,95,118,0.15)',maxWidth:200}}>
              <span className="text-[8px] font-bold tracking-widest uppercase mb-[1px]" style={{color:'rgba(80,95,118,0.55)'}}>{selectedSales.salesName}</span>
              {Object.entries(selectedSales.dayViewSalesMap).map(([sn,codes],idx)=>(
                <div key={sn} className="flex items-center gap-[5px]">
                  <div className="w-[8px] h-[8px] rounded-[2px] shrink-0" style={{background:TERRITORY_COLORS[idx%TERRITORY_COLORS.length]}}/>
                  <span className="text-[9px] font-semibold flex-1 truncate" style={{color:'#45464d'}}>{salesLabel(sn)}</span>
                  <span className="text-[9px] font-data-mono text-on-surface-variant">{codes.length}</span>
                </div>
              ))}
            </div>
          ) : selectedSales.dayFilter?.isM2 ? (
            <div className="absolute bottom-8 z-[500] flex flex-col gap-[5px] p-[8px] rounded-lg shadow-md"
                 style={{left:leftHidden?'16px':'340px',background:'rgba(255,255,255,0.96)',border:'1px solid rgba(80,95,118,0.15)'}}>
              <span className="text-[8px] font-bold tracking-widest uppercase mb-[1px]" style={{color:'rgba(80,95,118,0.55)'}}>Minggu</span>
              <div className="flex items-center gap-[5px]">
                <div className="w-[8px] h-[8px] rounded-full" style={{background:WEEK_GANJIL_COLOR}}/>
                <span className="text-[9px] font-bold" style={{color:WEEK_GANJIL_COLOR}}>{WEEK_LABEL_GANJIL}</span>
                <span className="text-[9px] font-data-mono text-on-surface-variant">{selectedSales.dayFilter.ganjil_codes.length} toko</span>
              </div>
              <div className="flex items-center gap-[5px]">
                <div className="w-[8px] h-[8px] rounded-full" style={{background:WEEK_GENAP_COLOR}}/>
                <span className="text-[9px] font-bold" style={{color:WEEK_GENAP_COLOR}}>{WEEK_LABEL_GENAP}</span>
                <span className="text-[9px] font-data-mono text-on-surface-variant">{selectedSales.dayFilter.genap_codes.length} toko</span>
              </div>
            </div>
          ) : selectedSales.dayMap&&!selectedSales.dayFilter ? (
            <div className="absolute bottom-8 z-[500] flex flex-wrap gap-[5px] p-[6px] rounded-lg shadow-md"
                 style={{left:leftHidden?'16px':'340px',background:'rgba(255,255,255,0.94)',border:'1px solid rgba(80,95,118,0.15)',maxWidth:220}}>
              {Object.keys(selectedSales.dayMap)
                .sort((a,b)=>DAY_ORDER.indexOf(a)-DAY_ORDER.indexOf(b))
                .map(day=>(
                  <div key={day} className="flex items-center gap-[3px]">
                    <div className="w-[8px] h-[8px] rounded-full" style={{background:DAY_COLORS[day]??'#999'}}/>
                    <span className="text-[9px] font-semibold" style={{color:'#45464d'}}>
                      {DAY_ABBREV[day]??day}<span className="font-normal text-on-surface-variant ml-[2px]">{selectedSales.dayMap![day]?.length??0}</span>
                    </span>
                  </div>
                ))}
            </div>
          ) : null}
        </>
      )}

      {/* ── Panel KIRI: show button ── */}
      {leftHidden&&(
        <button type="button" onClick={()=>setLeftHidden(false)}
                className="absolute left-4 top-4 z-[500] flex items-center gap-xs px-sm py-sm rounded-xl shadow-lg border border-outline-variant text-[11px] font-semibold text-on-surface hover:bg-surface-container transition-colors"
                style={{background:'#fff'}}>
          <span className="material-symbols-outlined ms-fill" style={{color:'#0c9488',fontSize:18}}>tune</span>
          Parameter
          <span className="material-symbols-outlined" style={{fontSize:14}}>chevron_right</span>
        </button>
      )}

      {/* ── Panel KIRI ── */}
      {!leftHidden&&(
        <div className="absolute left-4 top-4 bottom-4 w-80 z-[400] flex flex-col rounded-xl shadow-xl overflow-hidden"
             style={{background:'#ffffff',border:'1px solid rgba(80,95,118,0.12)'}}>
          <div className="shrink-0 flex items-center gap-xs px-sm py-sm"
               style={{background:'#f2f4f6',borderBottom:'1px solid rgba(80,95,118,0.1)'}}>
            <span className="material-symbols-outlined ms-fill shrink-0" style={{color:'#0c9488',fontSize:18}}>tune</span>
            <div className="flex-1 min-w-0 px-xs">
              {activeArea?(
                <>
                  <p className="font-headline-md text-headline-md text-primary truncate leading-tight">{activeArea.nama_area}</p>
                  <p className="font-body-sm text-body-sm text-on-surface-variant truncate leading-tight">{activeArea.kd_dist} · {activeArea.cabang.nama_cabang}</p>
                </>
              ):<p className="font-headline-md text-headline-md text-primary">Pilih Area</p>}
            </div>
            {activeArea&&(
              <div className="flex items-center gap-[3px] px-[6px] py-[3px] rounded-full shrink-0" style={{background:'rgba(12,148,136,0.12)',color:'#0c9488'}}>
                <span className={`material-symbols-outlined ms-fill ${storesLoading?'animate-spin':''}`} style={{fontSize:11}}>{storesLoading?'sync':'storefront'}</span>
                <span className="text-[10px] font-bold font-data-mono">{storesLoading?'…':stores.length}</span>
              </div>
            )}
            <button type="button" onClick={()=>setLeftHidden(true)}
                    className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-surface-container transition-colors text-on-surface-variant shrink-0">
              <span className="material-symbols-outlined" style={{fontSize:16}}>chevron_left</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {!activeArea&&(
              <div className="flex flex-col items-center justify-center h-full gap-md p-xl text-center">
                <span className="material-symbols-outlined text-[48px]" style={{color:'#c6c6cd'}}>location_off</span>
                <p className="font-body-md text-body-md text-on-surface-variant">Belum ada area terpilih</p>
                <button type="button" onClick={()=>navigate('/')}
                        className="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-xl font-label-md text-label-md hover:bg-primary/90 transition-colors text-sm">
                  <span className="material-symbols-outlined" style={{fontSize:16}}>dashboard</span>Pilih area di Dashboard
                </button>
              </div>
            )}
            {activeArea&&(
              <div className="p-md flex flex-col gap-sm">
                {storesLoading&&(
                  <div className="flex items-center justify-center py-lg gap-sm text-on-surface-variant">
                    <span className="material-symbols-outlined animate-spin" style={{fontSize:16}}>sync</span>
                    <span className="text-[11px]">Memuat data toko…</span>
                  </div>
                )}
                {!storesLoading&&stores.length===0&&(
                  <div className="flex flex-col items-center gap-sm p-lg text-center">
                    <span className="material-symbols-outlined text-[36px]" style={{color:'#c6c6cd'}}>storefront</span>
                    <p className="font-body-sm text-body-sm text-on-surface-variant">Belum ada toko di area ini.<br/>Upload data toko terlebih dahulu.</p>
                  </div>
                )}
                {!storesLoading&&divisions.map(div=>(
                  <DivisionAccordion key={div.id}
                    div={div} divState={divisionStates.get(div.id)??{stage:'idle'}}
                    onParamChange={p=>updateDivisionParam(div.id,p)}
                    onToggle={()=>toggleExpand(div.id)}
                    onRunStage1={()=>runStage1(div.id)}
                    onRunStage2={()=>runStage2(div.id)}
                    onReset={()=>resetDivision(div.id)}
                  />
                ))}
                {activeArea&&!storesLoading&&(
                  <div className="flex items-center gap-xs px-xs mt-xs">
                    <span className="material-symbols-outlined text-on-surface-variant" style={{fontSize:12}}>warehouse</span>
                    <p className="text-[10px] text-on-surface-variant">
                      Depo: <code className="font-data-mono bg-surface-container px-xs rounded text-[10px]">{Number(activeArea.lat).toFixed(5)}, {Number(activeArea.lon).toFixed(5)}</code>
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Panel KANAN: show button ── */}
      {rightHidden&&hasRightData&&(
        <button type="button" onClick={()=>setRightHidden(false)}
                className="absolute right-4 top-4 z-[500] flex items-center gap-xs px-sm py-sm rounded-xl shadow-lg border border-outline-variant text-[11px] font-semibold text-on-surface hover:bg-surface-container transition-colors"
                style={{background:'#fff'}}>
          <span className="material-symbols-outlined" style={{fontSize:14}}>chevron_left</span>
          <span className="material-symbols-outlined ms-fill" style={{color:'#7c3aed',fontSize:18}}>analytics</span>
          Summary
        </button>
      )}

      {/* ── Panel KANAN ── */}
      {!rightHidden&&hasRightData&&(
        <SummaryPanel
          key={areaId??'no-area'}
          divisions={divisions}
          divisionStates={divisionStates}
          omsetByCode={storeOmsetMap}
          selectedSales={selectedSales}
          anyRunning={anyRunning}
          viewMode={summaryViewMode}
          stores={stores}
          onSelectSales={(s)=>{ if(s) setSelectedRegions(new Set()); setSelectedSales(s) }}
          onRunStage2={runStage2}
          onSavePlan={savePlan}
          onNavigatePlans={()=>navigate('/plans')}
          onHide={()=>setRightHidden(true)}
          onViewModeChange={(m)=>{ setSummaryViewMode(m); if(m==='wilayah') setSelectedSales(null) }}
          onReassignKelurahan={handleReassignCodes}
          regionFilter={{ selected: selectedRegions, toggle: toggleRegion, clear: clearRegions }}
        />
      )}
    </div>
  )
}

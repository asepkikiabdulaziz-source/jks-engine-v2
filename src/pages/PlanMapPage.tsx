import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import type { Map as LeafletMap, LayerGroup } from 'leaflet'
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
const DAY_COLORS: Record<string,string> = {
  'Senin':'#ef4444','Selasa':'#3b82f6','Rabu':'#22c55e',
  'Kamis':'#f59e0b','Jumat':'#a855f7','Sabtu':'#06b6d4','Minggu':'#f97316',
}
const DAY_ABBREV: Record<string,string> = {
  'Senin':'Sen','Selasa':'Sel','Rabu':'Rab',
  'Kamis':'Kam','Jumat':'Jum','Sabtu':'Sab','Minggu':'Min',
}
const DAY_ORDER = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu']
const WEEK_GANJIL_COLOR = '#6366f1'
const WEEK_GENAP_COLOR  = '#f97316'
const WEEK_LABEL_GANJIL = 'M2C13'
const WEEK_LABEL_GENAP  = 'M2C24'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface StorePoint {
  customer_code: string; customer_name: string
  longitude: number;     latitude: number
  div_sls: string|null;  omset: number|null
}
interface AssignmentRow {
  customer_code: string; div_sls: string; sales_person_name: string
  day_index: number;     day_of_week: string; visit_cycle: string
  visit_ganjil: boolean; visit_genap: boolean; visit_order: number
  qc_flag: string|null
}
interface DivMeta {
  div_sls: string; n_sales: number; work_days: number
  cycle: string;   philosophy: string; store_count: number
}
interface PlanInfo {
  id: string; plan_name: string
  status: 'DRAFT'|'APPROVED'|'ARCHIVED'
  divisions: DivMeta[]; store_count: number; created_at: string
}
interface Territory {
  sales_index: number; sales_name: string
  store_count: number; customer_codes: string[]
}
interface DaySchedule {
  day_of_week: string; store_count: number
  customer_codes: string[]; ganjil_codes: string[]; genap_codes: string[]
}
interface SalesSchedule { sales_name: string; days: DaySchedule[] }
interface DivResult { cycle: string; territories: Territory[]; schedule: SalesSchedule[] }
interface SelectedDayFilter {
  day_of_week: string; customer_codes: string[]
  ganjil_codes: string[]; genap_codes: string[]; isM2: boolean
}
interface SelectedSales {
  divId: string; salesName: string; salesIdx: number
  dayMap?: Record<string,string[]>
  dayFilter?: SelectedDayFilter
  weekView?: 'ganjil'|'genap'
}
interface StoreStyle { fillColor:string; label?:string }
type StoreStyleMap = Record<string,StoreStyle>

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatOmset(v:number):string {
  if (v>=1_000_000_000) return `${(v/1_000_000_000).toFixed(1)}M`
  if (v>=1_000_000)     return `${(v/1_000_000).toFixed(1)}jt`
  if (v>=1_000)         return `${(v/1_000).toFixed(0)}rb`
  return String(v)
}
function salesLabel(name:string):string { const p=name.split('-'); return `SLS ${p[p.length-1]}` }

function StatusBadge({ status }:{ status:PlanInfo['status'] }) {
  const cfg = {
    DRAFT:    { label:'Draft',  color:'#45464d', bg:'#e0e3e5' },
    APPROVED: { label:'Aktif',  color:'#0c9488', bg:'rgba(12,148,136,0.15)' },
    ARCHIVED: { label:'Arsip',  color:'#9099a8', bg:'rgba(80,95,118,0.08)' },
  }[status]
  return (
    <span className="text-[9px] font-bold px-[6px] py-[2px] rounded-full shrink-0"
          style={{color:cfg.color,background:cfg.bg}}>{cfg.label}</span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PlanMap
// ─────────────────────────────────────────────────────────────────────────────

function PlanMap({ lat, lon, zoom, stores, storeStyles }:{
  lat:number; lon:number; zoom:number; stores:StorePoint[]; storeStyles:StoreStyleMap
}) {
  const containerRef  = useRef<HTMLDivElement>(null)
  const mapRef        = useRef<LeafletMap|null>(null)
  const markerRef     = useRef<any|null>(null)
  const storeLayerRef = useRef<LayerGroup|null>(null)

  useEffect(()=>{
    if (!containerRef.current) return
    let disposed=false
    import('leaflet').then(L=>{
      if (disposed||!containerRef.current||mapRef.current) return
      const map=L.map(containerRef.current,{zoomControl:false,attributionControl:false}).setView([lat,lon],zoom)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map)
      L.control.zoom({position:'bottomright'}).addTo(map)
      L.control.attribution({position:'bottomleft',prefix:'© OpenStreetMap'}).addTo(map)
      const icon=L.divIcon({
        className:'',
        html:`<div style="background:#131b2e;color:#fff;border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);font-family:'Material Symbols Outlined';font-size:17px;">warehouse</div>`,
        iconSize:[34,34],iconAnchor:[17,17],
      })
      markerRef.current=L.marker([lat,lon],{icon}).addTo(map).bindPopup(`<b>Depo</b>`)
      storeLayerRef.current=L.layerGroup().addTo(map)
      mapRef.current=map
    })
    return ()=>{ disposed=true; mapRef.current?.remove(); mapRef.current=null; markerRef.current=null; storeLayerRef.current=null }
  },[]) // eslint-disable-line

  useEffect(()=>{
    if (!mapRef.current||!markerRef.current) return
    mapRef.current.setView([lat,lon],zoom,{animate:true}); markerRef.current.setLatLng([lat,lon])
  },[lat,lon,zoom])

  useEffect(()=>{
    if (!storeLayerRef.current) return
    import('leaflet').then(L=>{
      if (!storeLayerRef.current) return
      storeLayerRef.current.clearLayers()
      stores.forEach(s=>{
        const style=storeStyles[s.customer_code]
        const color=style?.fillColor??'#0c9488'
        L.circleMarker([s.latitude,s.longitude],{radius:5,fillColor:color,color:'#fff',weight:1,opacity:1,fillOpacity:0.85})
          .addTo(storeLayerRef.current!).bindPopup(
            `<b>${s.customer_name}</b><br><span style="color:#666;font-size:11px">${s.customer_code}</span>`+
            (style?.label?`<br><span style="color:${color};font-size:11px;font-weight:600">${style.label}</span>`:'')
          )
      })
    })
  },[stores,storeStyles])

  return <div ref={containerRef} className="absolute inset-0"/>
}

// ─────────────────────────────────────────────────────────────────────────────
// ReviewSummaryPanel
// ─────────────────────────────────────────────────────────────────────────────

function ReviewSummaryPanel({
  planInfo, divResults, omsetByCode, selectedSales, onSelectSales, onHide,
}:{
  planInfo       : PlanInfo
  divResults     : Map<string,DivResult>
  omsetByCode    : Record<string,number>
  selectedSales  : SelectedSales|null
  onSelectSales  : (s:SelectedSales|null)=>void
  onHide         : ()=>void
}) {
  const [exSales, setExSales] = useState<Set<string>>(new Set())
  const [exDays,  setExDays]  = useState<Set<string>>(new Set())
  const toggleSales=(k:string)=>setExSales(p=>{const n=new Set(p);n.has(k)?n.delete(k):n.add(k);return n})
  const toggleDay  =(k:string)=>setExDays (p=>{const n=new Set(p);n.has(k)?n.delete(k):n.add(k);return n})

  const divsWithData = planInfo.divisions.filter(d=>divResults.has(d.div_sls))

  return (
    <div className="absolute right-4 top-4 bottom-4 w-80 z-[400] flex flex-col rounded-xl shadow-xl overflow-hidden"
         style={{background:'#ffffff',border:'1px solid rgba(80,95,118,0.12)'}}>

      {/* Header */}
      <div className="shrink-0 flex items-center gap-xs px-sm py-sm" style={{background:'#f2f4f6',borderBottom:'1px solid rgba(80,95,118,0.1)'}}>
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
                : <><span style={{color:'#7c3aed'}} className="font-semibold">{salesLabel(selectedSales.salesName)}</span> · klik ✕ reset</>
              : 'Klik baris sales untuk filter peta'}
          </p>
        </div>
        {selectedSales&&(
          <button type="button" onClick={()=>onSelectSales(null)}
                  className="flex items-center justify-center w-6 h-6 rounded-lg hover:bg-surface-container transition-colors shrink-0" style={{color:'#7c3aed'}}>
            <span className="material-symbols-outlined" style={{fontSize:14}}>filter_alt_off</span>
          </button>
        )}
        <button type="button" onClick={onHide}
                className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-surface-container transition-colors text-on-surface-variant shrink-0">
          <span className="material-symbols-outlined" style={{fontSize:16}}>chevron_right</span>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {divsWithData.map(div=>{
          const dr = divResults.get(div.div_sls)!
          const isM2 = div.cycle==='M2'

          return (
            <div key={div.div_sls} className="px-sm pt-sm pb-[2px]">
              <div className="flex items-center gap-xs mb-[5px]">
                <span className="font-data-mono text-[10px] font-bold text-on-surface">{div.div_sls}</span>
                <span className="text-[9px] font-data-mono text-on-surface-variant">{div.cycle}</span>
                <div className="flex-1"/>
                <span className="text-[9px] text-on-surface-variant">{div.n_sales}S · {div.work_days}h</span>
              </div>

              <div className="rounded-lg overflow-hidden" style={{border:'1px solid rgba(80,95,118,0.12)'}}>
                {dr.territories.map((t,i)=>{
                  const color    = TERRITORY_COLORS[t.sales_index%TERRITORY_COLORS.length]
                  const salesKey = `${div.div_sls}||${t.sales_name}`
                  const isExSales= exSales.has(salesKey)
                  const isSelThisSales = selectedSales?.divId===div.div_sls&&selectedSales?.salesName===t.sales_name
                  const omset    = t.customer_codes.reduce((s,c)=>s+(omsetByCode[c]??0),0)
                  const salesSch = dr.schedule.find(s=>s.sales_name===t.sales_name)

                  return (
                    <div key={t.sales_name}>
                      {/* Sales row */}
                      <div className="flex items-center gap-[6px] px-sm py-[6px] cursor-pointer transition-colors"
                           style={{
                             background:isSelThisSales?'rgba(124,58,237,0.06)':i%2===0?'#f7f9fb':'#fff',
                             borderBottom:(isExSales||i<dr.territories.length-1)?'1px solid rgba(80,95,118,0.07)':undefined,
                             borderLeft:isSelThisSales?`3px solid ${color}`:'3px solid transparent',
                           }}
                           onClick={()=>{
                             toggleSales(salesKey)
                             if (isSelThisSales&&!selectedSales?.dayFilter){onSelectSales(null);return}
                             const dayMap=salesSch?Object.fromEntries(salesSch.days.map(d=>[d.day_of_week,d.customer_codes])):undefined
                             onSelectSales({divId:div.div_sls,salesName:t.sales_name,salesIdx:t.sales_index,dayMap})
                           }}>
                        <div className="w-[8px] h-[8px] rounded-[2px] shrink-0" style={{background:color}}/>
                        <span className="flex-1 font-data-mono text-[10px] font-semibold text-on-surface">{salesLabel(t.sales_name)}</span>
                        <span className="text-[10px] text-on-surface-variant font-data-mono shrink-0">{t.store_count} toko</span>
                        {omset>0&&<span className="text-[10px] font-data-mono shrink-0" style={{color:'#0c9488'}}>{formatOmset(omset)}</span>}
                        <span className="material-symbols-outlined text-on-surface-variant shrink-0" style={{fontSize:12}}>
                          {isExSales?'expand_less':'expand_more'}
                        </span>
                      </div>

                      {/* Day rows */}
                      {isExSales&&salesSch&&(
                        <div style={{borderBottom:i<dr.territories.length-1?'1px solid rgba(80,95,118,0.07)':undefined}}>
                          {salesSch.days.map(day=>{
                            const dayKey   = `${salesKey}||${day.day_of_week}`
                            const isExDay  = exDays.has(dayKey)
                            const hasWeeks = isM2&&(day.ganjil_codes.length>0||day.genap_codes.length>0)
                            const dayColor = DAY_COLORS[day.day_of_week]??'#9099a8'
                            const isDayActive = selectedSales?.divId===div.div_sls&&selectedSales?.salesName===t.sales_name&&selectedSales?.dayFilter?.day_of_week===day.day_of_week

                            return (
                              <div key={day.day_of_week}>
                                <div className="flex items-center gap-[6px] px-[24px] py-[4px] transition-colors cursor-pointer"
                                     style={{
                                       background:isDayActive?'rgba(99,102,241,0.08)':isExDay?'rgba(80,95,118,0.04)':'rgba(80,95,118,0.02)',
                                       borderLeft:isDayActive?`2px solid ${dayColor}`:'2px solid transparent',
                                     }}
                                     onClick={()=>{
                                       if (hasWeeks) toggleDay(dayKey)
                                       if (isDayActive) {
                                         const dm=salesSch?Object.fromEntries(salesSch.days.map(d=>[d.day_of_week,d.customer_codes])):undefined
                                         onSelectSales({divId:div.div_sls,salesName:t.sales_name,salesIdx:t.sales_index,dayMap:dm})
                                       } else {
                                         onSelectSales({divId:div.div_sls,salesName:t.sales_name,salesIdx:t.sales_index,
                                           dayMap:salesSch?Object.fromEntries(salesSch.days.map(d=>[d.day_of_week,d.customer_codes])):undefined,
                                           dayFilter:{day_of_week:day.day_of_week,customer_codes:day.customer_codes,ganjil_codes:day.ganjil_codes,genap_codes:day.genap_codes,isM2},
                                         })
                                       }
                                     }}>
                                  <div className="w-[6px] h-[6px] rounded-full shrink-0" style={{background:dayColor}}/>
                                  <span className="flex-1 text-[10px] font-semibold" style={{color:isDayActive?'#3b3f4a':'#45464d'}}>{day.day_of_week}</span>
                                  <span className="text-[10px] font-data-mono text-on-surface-variant shrink-0">{day.store_count} toko</span>
                                  {hasWeeks&&<span className="material-symbols-outlined text-on-surface-variant shrink-0" style={{fontSize:10}}>{isExDay?'expand_less':'expand_more'}</span>}
                                </div>
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
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Total row */}
                <div className="flex items-center gap-[6px] px-sm py-[6px]"
                     style={{borderTop:'1px solid rgba(80,95,118,0.15)',background:'rgba(12,148,136,0.04)'}}>
                  <div className="w-[8px] h-[8px] shrink-0"/>
                  <span className="flex-1 text-[10px] font-bold text-on-surface">TOTAL</span>
                  <span className="text-[10px] font-bold font-data-mono text-on-surface shrink-0">
                    {dr.territories.reduce((s,t)=>s+t.store_count,0)} toko
                  </span>
                  {Object.keys(omsetByCode).length>0&&(
                    <span className="text-[10px] font-bold font-data-mono shrink-0" style={{color:'#0c9488'}}>
                      {formatOmset(dr.territories.reduce((s,t)=>s+t.customer_codes.reduce((ss,c)=>ss+(omsetByCode[c]??0),0),0))}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        <div className="h-sm"/>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PlanMapPage
// ─────────────────────────────────────────────────────────────────────────────

export default function PlanMapPage() {
  const { planId }     = useParams<{ planId:string }>()
  const { activeArea } = useArea()
  const navigate       = useNavigate()

  const [stores,     setStores]     = useState<StorePoint[]>([])
  const [planInfo,   setPlanInfo]   = useState<PlanInfo|null>(null)
  const [divResults, setDivResults] = useState<Map<string,DivResult>>(new Map())
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string|null>(null)
  const [leftHidden, setLeftHidden] = useState(false)
  const [rightHidden,setRightHidden]= useState(false)
  const [selectedSales, setSelectedSales] = useState<SelectedSales|null>(null)

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if (!activeArea||!planId){ setLoading(false); return }
    let cancelled=false
    setLoading(true); setError(null)

    Promise.all([
      supabase.rpc('get_stores_by_area',{p_area_id:activeArea.id}),
      supabase.rpc('get_plans_by_area', {p_area_id:activeArea.id}),
      supabase.rpc('get_plan_assignments',{p_plan_id:planId}),
    ]).then(([sR,pR,aR])=>{
      if (cancelled) return
      const storeData = (sR.data as StorePoint[]) ?? []
      const planData  = (pR.data as PlanInfo[]) ?? []
      const plan      = planData.find(p=>p.id===planId)
      const asgData   = (aR.data as AssignmentRow[]) ?? []

      if (!plan){ setError('Plan tidak ditemukan'); setLoading(false); return }

      setStores(storeData)
      setPlanInfo(plan)

      // Reconstruct divResults from assignments
      const byDiv: Record<string,AssignmentRow[]> = {}
      for (const a of asgData) {
        if (!byDiv[a.div_sls]) byDiv[a.div_sls]=[]
        byDiv[a.div_sls].push(a)
      }

      const results = new Map<string,DivResult>()
      for (const [divSls, divAsg] of Object.entries(byDiv)) {
        const divMeta = plan.divisions.find(d=>d.div_sls===divSls)
        const cycle   = divMeta?.cycle ?? 'M1'

        const bySales: Record<string,AssignmentRow[]> = {}
        for (const a of divAsg) {
          if (!bySales[a.sales_person_name]) bySales[a.sales_person_name]=[]
          bySales[a.sales_person_name].push(a)
        }
        const salesNames = Object.keys(bySales).sort()

        const territories: Territory[] = salesNames.map((sn,idx)=>({
          sales_index: idx,
          sales_name:  sn,
          store_count: bySales[sn].length,
          customer_codes: bySales[sn].map(a=>a.customer_code),
        }))

        const schedule: SalesSchedule[] = salesNames.map(sn=>{
          const byDay: Record<string,AssignmentRow[]> = {}
          for (const a of bySales[sn]) {
            if (!byDay[a.day_of_week]) byDay[a.day_of_week]=[]
            byDay[a.day_of_week].push(a)
          }
          const days = Object.entries(byDay)
            .sort(([a],[b])=>DAY_ORDER.indexOf(a)-DAY_ORDER.indexOf(b))
            .map(([dow,da])=>({
              day_of_week: dow, store_count: da.length,
              customer_codes: da.map(a=>a.customer_code),
              ganjil_codes:   da.filter(a=>a.visit_ganjil&&!a.visit_genap).map(a=>a.customer_code),
              genap_codes:    da.filter(a=>a.visit_genap&&!a.visit_ganjil).map(a=>a.customer_code),
            }))
          return { sales_name:sn, days }
        })

        results.set(divSls,{cycle,territories,schedule})
      }

      setDivResults(results)
      setLoading(false)
    }).catch(e=>{ if (!cancelled){ setError(String(e)); setLoading(false) } })

    return ()=>{ cancelled=true }
  },[activeArea,planId])

  // ── Derived ───────────────────────────────────────────────────────────────
  const omsetByCode = useMemo(()=>{
    const m:Record<string,number>={}
    stores.forEach(s=>{if(s.omset!=null&&s.omset>0) m[s.customer_code]=Number(s.omset)})
    return m
  },[stores])

  const visibleStores = useMemo(()=>{
    if (selectedSales) {
      if (selectedSales.dayFilter) {
        const df=selectedSales.dayFilter
        const base=selectedSales.weekView==='ganjil'?df.ganjil_codes:selectedSales.weekView==='genap'?df.genap_codes:df.customer_codes
        const codes=new Set(base); return stores.filter(s=>codes.has(s.customer_code))
      }
      if (selectedSales.dayMap) {
        const codes=new Set(Object.values(selectedSales.dayMap).flat())
        return stores.filter(s=>codes.has(s.customer_code))
      }
      const t=divResults.get(selectedSales.divId)?.territories.find(t=>t.sales_name===selectedSales.salesName)
      if (t){ const codes=new Set(t.customer_codes); return stores.filter(s=>codes.has(s.customer_code)) }
    }
    return stores
  },[stores,selectedSales,divResults])

  const storeStyles = useMemo<StoreStyleMap>(()=>{
    if (selectedSales) {
      if (selectedSales.dayFilter) {
        const {day_of_week,customer_codes,ganjil_codes,genap_codes,isM2}=selectedSales.dayFilter
        const wv=selectedSales.weekView; const st:StoreStyleMap={}
        if (isM2&&(ganjil_codes.length>0||genap_codes.length>0)) {
          if (wv==='ganjil') ganjil_codes.forEach(c=>{st[c]={fillColor:WEEK_GANJIL_COLOR,label:WEEK_LABEL_GANJIL}})
          else if (wv==='genap') genap_codes.forEach(c=>{st[c]={fillColor:WEEK_GENAP_COLOR,label:WEEK_LABEL_GENAP}})
          else {
            const gs=new Set(ganjil_codes); const es=new Set(genap_codes)
            customer_codes.forEach(c=>{
              if(gs.has(c))      st[c]={fillColor:WEEK_GANJIL_COLOR,label:WEEK_LABEL_GANJIL}
              else if(es.has(c)) st[c]={fillColor:WEEK_GENAP_COLOR, label:WEEK_LABEL_GENAP}
              else               st[c]={fillColor:DAY_COLORS[day_of_week]??'#9099a8',label:'M1'}
            })
          }
        } else { const c=DAY_COLORS[day_of_week]??'#9099a8'; customer_codes.forEach(cc=>{st[cc]={fillColor:c,label:day_of_week}}) }
        return st
      }
      if (selectedSales.dayMap) {
        const st:StoreStyleMap={}
        Object.entries(selectedSales.dayMap).forEach(([day,codes])=>{
          const c=DAY_COLORS[day]??'#9099a8'; codes.forEach(cc=>{st[cc]={fillColor:c,label:day}})
        }); return st
      }
      const t=divResults.get(selectedSales.divId)?.territories.find(t=>t.sales_name===selectedSales.salesName)
      if (t){
        const c=TERRITORY_COLORS[t.sales_index%TERRITORY_COLORS.length]; const st:StoreStyleMap={}
        t.customer_codes.forEach(cc=>{st[cc]={fillColor:c,label:t.sales_name}}); return st
      }
    }
    // Default: semua territory berwarna berdasarkan sales
    const st:StoreStyleMap={}
    for (const dr of divResults.values()) {
      dr.territories.forEach(t=>{
        const c=TERRITORY_COLORS[t.sales_index%TERRITORY_COLORS.length]
        t.customer_codes.forEach(cc=>{st[cc]={fillColor:c,label:t.sales_name}})
      })
    }
    return st
  },[selectedSales,divResults])

  const mapLat  = activeArea?Number(activeArea.lat):-2.5
  const mapLon  = activeArea?Number(activeArea.lon):118
  const mapZoom = activeArea?12:5

  // ── Guard ─────────────────────────────────────────────────────────────────
  if (!activeArea) return (
    <div className="h-full flex flex-col items-center justify-center gap-md text-center p-xl">
      <span className="material-symbols-outlined text-[48px]" style={{color:'#c6c6cd'}}>location_off</span>
      <p className="font-body-sm text-body-sm text-on-surface-variant">Belum ada area terpilih</p>
      <button onClick={()=>navigate('/')} className="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-xl text-sm font-semibold">
        Ke Dashboard
      </button>
    </div>
  )

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="h-full relative overflow-hidden">
      <PlanMap lat={mapLat} lon={mapLon} zoom={mapZoom} stores={visibleStores} storeStyles={storeStyles}/>

      {/* Loading overlay */}
      {loading&&(
        <div className="absolute inset-0 z-[600] flex items-center justify-center" style={{background:'rgba(247,249,251,0.88)'}}>
          <div className="flex items-center gap-sm text-on-surface-variant">
            <span className="material-symbols-outlined animate-spin" style={{fontSize:22}}>sync</span>
            <span className="text-sm">Memuat plan…</span>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {!loading&&error&&(
        <div className="absolute inset-0 z-[600] flex flex-col items-center justify-center gap-md p-xl text-center">
          <span className="material-symbols-outlined text-[40px]" style={{color:'#ba1a1a'}}>error</span>
          <p className="text-sm font-semibold" style={{color:'#ba1a1a'}}>{error}</p>
          <button onClick={()=>navigate('/plans')} className="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-xl text-sm font-semibold">
            Kembali ke Daftar
          </button>
        </div>
      )}

      {/* Selected sales pill + legend */}
      {selectedSales&&(
        <>
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[500] flex items-center gap-xs px-sm py-xs rounded-full shadow-lg"
               style={{background:'rgba(255,255,255,0.95)',border:'1px solid rgba(124,58,237,0.3)'}}>
            <span className="material-symbols-outlined ms-fill" style={{color:'#7c3aed',fontSize:13}}>visibility</span>
            <span className="text-[11px] font-semibold text-on-surface">{salesLabel(selectedSales.salesName)}</span>
            {selectedSales.dayFilter
              ? <span className="text-[10px] text-on-surface-variant">
                  · {selectedSales.dayFilter.day_of_week} · {selectedSales.dayFilter.customer_codes.length} toko
                  {selectedSales.dayFilter.isM2?' · warna minggu':''}
                </span>
              : selectedSales.dayMap
              ? <span className="text-[10px] text-on-surface-variant">· {Object.values(selectedSales.dayMap).flat().length} toko · warna hari</span>
              : <span className="text-[10px] text-on-surface-variant">· {divResults.get(selectedSales.divId)?.territories.find(t=>t.sales_name===selectedSales.salesName)?.store_count??0} toko</span>
            }
            <button type="button" onClick={()=>setSelectedSales(null)}
                    className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-surface-container" style={{color:'#9099a8'}}>
              <span className="material-symbols-outlined" style={{fontSize:12}}>close</span>
            </button>
          </div>

          {selectedSales.dayFilter?.isM2?(
            <div className="absolute bottom-8 z-[500] flex flex-col gap-[5px] p-[8px] rounded-lg shadow-md"
                 style={{left:leftHidden?'16px':'340px',background:'rgba(255,255,255,0.96)',border:'1px solid rgba(80,95,118,0.15)'}}>
              <span className="text-[8px] font-bold tracking-widest uppercase mb-[1px]" style={{color:'rgba(80,95,118,0.55)'}}>Minggu</span>
              <div className="flex items-center gap-[5px] cursor-pointer"
                   onClick={()=>setSelectedSales(p=>p?{...p,weekView:p.weekView==='ganjil'?undefined:'ganjil'}:null)}
                   style={{background:selectedSales.weekView==='ganjil'?'rgba(99,102,241,0.1)':'transparent',borderRadius:4,padding:'2px 4px'}}>
                <div className="w-[8px] h-[8px] rounded-full" style={{background:WEEK_GANJIL_COLOR}}/>
                <span className="text-[9px] font-bold" style={{color:WEEK_GANJIL_COLOR}}>{WEEK_LABEL_GANJIL}</span>
                <span className="text-[9px] font-data-mono text-on-surface-variant">{selectedSales.dayFilter.ganjil_codes.length} toko</span>
              </div>
              <div className="flex items-center gap-[5px] cursor-pointer"
                   onClick={()=>setSelectedSales(p=>p?{...p,weekView:p.weekView==='genap'?undefined:'genap'}:null)}
                   style={{background:selectedSales.weekView==='genap'?'rgba(249,115,22,0.1)':'transparent',borderRadius:4,padding:'2px 4px'}}>
                <div className="w-[8px] h-[8px] rounded-full" style={{background:WEEK_GENAP_COLOR}}/>
                <span className="text-[9px] font-bold" style={{color:WEEK_GENAP_COLOR}}>{WEEK_LABEL_GENAP}</span>
                <span className="text-[9px] font-data-mono text-on-surface-variant">{selectedSales.dayFilter.genap_codes.length} toko</span>
              </div>
            </div>
          ):selectedSales.dayMap&&!selectedSales.dayFilter?(
            <div className="absolute bottom-8 z-[500] flex flex-wrap gap-[5px] p-[6px] rounded-lg shadow-md"
                 style={{left:leftHidden?'16px':'340px',background:'rgba(255,255,255,0.94)',border:'1px solid rgba(80,95,118,0.15)',maxWidth:220}}>
              {Object.keys(selectedSales.dayMap).sort((a,b)=>DAY_ORDER.indexOf(a)-DAY_ORDER.indexOf(b)).map(day=>(
                <div key={day} className="flex items-center gap-[3px]">
                  <div className="w-[8px] h-[8px] rounded-full" style={{background:DAY_COLORS[day]??'#999'}}/>
                  <span className="text-[9px] font-semibold" style={{color:'#45464d'}}>
                    {DAY_ABBREV[day]??day}<span className="font-normal text-on-surface-variant ml-[2px]">{selectedSales.dayMap![day]?.length??0}</span>
                  </span>
                </div>
              ))}
            </div>
          ):null}
        </>
      )}

      {/* ── Panel KIRI show button ── */}
      {leftHidden&&(
        <button type="button" onClick={()=>setLeftHidden(false)}
                className="absolute left-4 top-4 z-[500] flex items-center gap-xs px-sm py-sm rounded-xl shadow-lg border border-outline-variant text-[11px] font-semibold text-on-surface hover:bg-surface-container"
                style={{background:'#fff'}}>
          <span className="material-symbols-outlined ms-fill" style={{color:'#0c9488',fontSize:18}}>list_alt</span>
          Plan
          <span className="material-symbols-outlined" style={{fontSize:14}}>chevron_right</span>
        </button>
      )}

      {/* ── Panel KIRI ── */}
      {!leftHidden&&planInfo&&(
        <div className="absolute left-4 top-4 bottom-4 w-80 z-[400] flex flex-col rounded-xl shadow-xl overflow-hidden"
             style={{background:'#ffffff',border:'1px solid rgba(80,95,118,0.12)'}}>

          {/* Header */}
          <div className="shrink-0 flex items-center gap-xs px-sm py-sm" style={{background:'#f2f4f6',borderBottom:'1px solid rgba(80,95,118,0.1)'}}>
            <button type="button" onClick={()=>navigate('/plans')} title="Kembali ke daftar"
                    className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-surface-container text-on-surface-variant shrink-0">
              <span className="material-symbols-outlined" style={{fontSize:18}}>arrow_back</span>
            </button>
            <div className="flex-1 min-w-0 px-[3px]">
              <p className="font-data-mono font-bold text-sm text-on-surface truncate leading-tight">{planInfo.plan_name}</p>
              <p className="text-[9px] text-on-surface-variant truncate">{activeArea.nama_area} · {activeArea.kd_dist}</p>
            </div>
            <StatusBadge status={planInfo.status}/>
            <button type="button" onClick={()=>setLeftHidden(true)}
                    className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-surface-container text-on-surface-variant shrink-0">
              <span className="material-symbols-outlined" style={{fontSize:16}}>chevron_left</span>
            </button>
          </div>

          {/* Division list */}
          <div className="flex-1 overflow-y-auto p-sm flex flex-col gap-sm">
            {planInfo.divisions.map(div=>{
              const dr=divResults.get(div.div_sls)
              return (
                <div key={div.div_sls} className="rounded-xl overflow-hidden" style={{border:'1px solid rgba(80,95,118,0.15)'}}>
                  <div className="flex items-center gap-xs px-sm py-[7px]" style={{background:'#f7f9fb'}}>
                    <span className="font-data-mono text-[11px] font-bold text-on-surface">{div.div_sls}</span>
                    <span className="text-[10px] text-on-surface-variant">{div.store_count} toko</span>
                    <div className="flex-1"/>
                    <span className="text-[9px] font-data-mono text-on-surface-variant">{div.n_sales}S·{div.work_days}h·{div.cycle}</span>
                  </div>
                  {dr?.territories.map((t,ti)=>{
                    const color=TERRITORY_COLORS[t.sales_index%TERRITORY_COLORS.length]
                    const isActive=selectedSales?.divId===div.div_sls&&selectedSales?.salesName===t.sales_name&&!selectedSales.dayFilter
                    return (
                      <div key={t.sales_name}
                           className="flex items-center gap-[6px] px-sm py-[5px] cursor-pointer transition-colors"
                           style={{
                             background:isActive?'rgba(124,58,237,0.05)':ti%2===0?'#fafafa':'#fff',
                             borderTop:'1px solid rgba(80,95,118,0.06)',
                             borderLeft:isActive?`2px solid ${color}`:'2px solid transparent',
                           }}
                           onClick={()=>{
                             const salesSch=dr?.schedule.find(s=>s.sales_name===t.sales_name)
                             const dayMap=salesSch?Object.fromEntries(salesSch.days.map(d=>[d.day_of_week,d.customer_codes])):undefined
                             if (isActive){setSelectedSales(null);return}
                             setSelectedSales({divId:div.div_sls,salesName:t.sales_name,salesIdx:t.sales_index,dayMap})
                             setRightHidden(false)
                           }}>
                        <div className="w-[8px] h-[8px] rounded-[2px] shrink-0" style={{background:color}}/>
                        <span className="font-data-mono text-[10px] font-semibold flex-1 text-on-surface">{salesLabel(t.sales_name)}</span>
                        <span className="text-[10px] text-on-surface-variant font-data-mono">{t.store_count}</span>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>

          {/* Footer */}
          <div className="shrink-0 px-sm py-sm" style={{borderTop:'1px solid rgba(80,95,118,0.1)'}}>
            <button type="button" onClick={()=>navigate('/routing')}
                    className="w-full flex items-center justify-center gap-xs py-sm rounded-xl text-sm font-semibold transition-colors hover:bg-primary/90"
                    style={{background:'#0c9488',color:'#fff'}}>
              <span className="material-symbols-outlined" style={{fontSize:15}}>add</span>
              Buat Plan Baru
            </button>
          </div>
        </div>
      )}

      {/* ── Panel KANAN show button ── */}
      {rightHidden&&divResults.size>0&&(
        <button type="button" onClick={()=>setRightHidden(false)}
                className="absolute right-4 top-4 z-[500] flex items-center gap-xs px-sm py-sm rounded-xl shadow-lg border border-outline-variant text-[11px] font-semibold text-on-surface hover:bg-surface-container"
                style={{background:'#fff'}}>
          <span className="material-symbols-outlined" style={{fontSize:14}}>chevron_left</span>
          <span className="material-symbols-outlined ms-fill" style={{color:'#7c3aed',fontSize:18}}>analytics</span>
          Summary
        </button>
      )}

      {/* ── Panel KANAN ── */}
      {!rightHidden&&divResults.size>0&&planInfo&&(
        <ReviewSummaryPanel
          planInfo={planInfo} divResults={divResults} omsetByCode={omsetByCode}
          selectedSales={selectedSales} onSelectSales={setSelectedSales}
          onHide={()=>setRightHidden(true)}
        />
      )}
    </div>
  )
}

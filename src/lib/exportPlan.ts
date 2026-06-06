/**
 * exportPlan.ts — Export plan assignments ke XLSX
 *
 * Menggunakan SheetJS (xlsx ^0.18) yang sudah ada di dependencies.
 * Dipanggil dari PlansPage dan PlanMapPage.
 *
 * Struktur workbook:
 *   Sheet "Info Plan" — metadata plan + ringkasan divisi
 *   Sheet per divisi  — tabel assignment lengkap, diurutkan sales→hari→urut
 */

import * as XLSX from 'xlsx'
import type { SupabaseClient } from '@supabase/supabase-js'

// ── Types (minimal, hanya yang dipakai di sini) ───────────────────────────────

interface StoreRow {
  customer_code : string
  customer_name : string
  latitude      : number | null
  longitude     : number | null
  omset         : number | null
}

interface AssignmentRow {
  customer_code    : string
  div_sls          : string
  sales_person_name: string
  day_index        : number
  day_of_week      : string
  visit_ganjil     : boolean
  visit_genap      : boolean
  visit_order      : number
  qc_flag          : string | null
}

interface DivisionMeta {
  div_sls    : string
  n_sales    : number
  work_days  : number
  cycle      : string
  philosophy : string
  store_count: number
}

/**
 * Tipe minimum yang dibutuhkan exportPlanExcel.
 * Compatible dengan Plan (PlansPage) dan PlanInfo (PlanMapPage).
 */
export interface PlanForExport {
  plan_name   : string
  status      : 'DRAFT' | 'APPROVED' | 'ARCHIVED'
  divisions   : DivisionMeta[]
  store_count : number
  created_at  : string
  approved_at : string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function salesLabel(name: string): string {
  const p = name.split('-')
  if (p.length >= 3) return `${p[1]}-SLS-${p[p.length - 1]}`
  return name
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('id-ID', {
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function setColWidths(ws: XLSX.WorkSheet, widths: number[]): void {
  ws['!cols'] = widths.map(w => ({ wch: w }))
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function exportPlanExcel(
  planId   : string,
  plan     : PlanForExport,
  areaId   : string,
  areaName : string,
  kdDist   : string,
  supabase : SupabaseClient,
): Promise<void> {
  // Load assignments + stores secara paralel
  const [asgRes, storeRes] = await Promise.all([
    supabase.rpc('get_plan_assignments', { p_plan_id: planId }),
    supabase.rpc('get_stores_by_area',   { p_area_id: areaId }),
  ])

  if (asgRes.error)   throw new Error(`Gagal load assignments: ${asgRes.error.message}`)
  if (storeRes.error) throw new Error(`Gagal load data toko: ${storeRes.error.message}`)

  const assignments = (asgRes.data  as AssignmentRow[]) ?? []
  const stores      = (storeRes.data as StoreRow[])      ?? []
  const storeMap    = new Map(stores.map(s => [s.customer_code, s]))

  const wb = XLSX.utils.book_new()

  // ── Sheet 1: Info Plan ─────────────────────────────────────────────────────
  const statusLabel =
    plan.status === 'APPROVED' ? 'Submitted ke Field' :
    plan.status === 'DRAFT'    ? 'Draft' : 'Diarsipkan'

  const infoData: (string | number | null)[][] = [
    ['Plan',         plan.plan_name],
    ['Area',         `${areaName} (${kdDist})`],
    ['Status',       statusLabel],
    ['Dibuat',       fmtDate(plan.created_at)],
    ['Submitted',    fmtDate(plan.approved_at)],
    ['Total Toko',   plan.store_count],
    [],
    ['Divisi', 'Jumlah Sales', 'Hari/Siklus', 'Siklus', 'Philosophy', 'Jumlah Toko'],
    ...plan.divisions.map(d => [
      d.div_sls, d.n_sales, d.work_days, d.cycle, d.philosophy, d.store_count,
    ]),
  ]

  const wsInfo = XLSX.utils.aoa_to_sheet(infoData)
  setColWidths(wsInfo, [18, 38, 18, 8, 12, 12])
  XLSX.utils.book_append_sheet(wb, wsInfo, 'Info Plan')

  // ── Group assignments by divisi ────────────────────────────────────────────
  const byDiv: Record<string, AssignmentRow[]> = {}
  for (const a of assignments) {
    ;(byDiv[a.div_sls] ??= []).push(a)
  }

  // ── Sheet per divisi ───────────────────────────────────────────────────────
  for (const divSls of Object.keys(byDiv).sort()) {
    const divAsg  = byDiv[divSls]
    const divMeta = plan.divisions.find(d => d.div_sls === divSls)
    const isM2    = divMeta?.cycle === 'M2'

    // Urutkan: sales_person_name → day_index → visit_order
    const sorted = [...divAsg].sort((a, b) => {
      const sc = a.sales_person_name.localeCompare(b.sales_person_name)
      if (sc !== 0) return sc
      if (a.day_index !== b.day_index) return a.day_index - b.day_index
      return a.visit_order - b.visit_order
    })

    const headers = [
      'No', 'Kode Toko', 'Nama Toko', 'Sales', 'Hari', 'No. Urut',
      ...(isM2 ? ['M2C13 (Ganjil)', 'M2C24 (Genap)'] : []),
      'Omset', 'Lat', 'Lon', 'QC Flag',
    ]

    const dataRows = sorted.map((a, idx) => {
      const store = storeMap.get(a.customer_code)
      const row: (string | number | null)[] = [
        idx + 1,
        a.customer_code,
        store?.customer_name ?? '',
        salesLabel(a.sales_person_name),
        a.day_of_week,
        a.visit_order,
      ]
      if (isM2) {
        row.push(a.visit_ganjil ? 'Ya' : '-')
        row.push(a.visit_genap  ? 'Ya' : '-')
      }
      row.push(store?.omset     != null ? store.omset     : '')
      row.push(store?.latitude  != null ? store.latitude  : '')
      row.push(store?.longitude != null ? store.longitude : '')
      row.push(a.qc_flag ?? '')
      return row
    })

    const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows])

    // Lebar kolom
    const widths = [5, 14, 32, 14, 10, 8]
    if (isM2) widths.push(14, 14)
    widths.push(14, 12, 12, 26)
    setColWidths(ws, widths)

    // Freeze baris header
    ws['!freeze'] = { xSplit: 0, ySplit: 1 }

    // Nama sheet maks 31 karakter (batas Excel)
    XLSX.utils.book_append_sheet(wb, ws, divSls.slice(0, 31))
  }

  // ── Download ───────────────────────────────────────────────────────────────
  const safeName = plan.plan_name.replace(/[\\/:*?"<>|]/g, '_')
  XLSX.writeFile(wb, `${safeName}.xlsx`)
}

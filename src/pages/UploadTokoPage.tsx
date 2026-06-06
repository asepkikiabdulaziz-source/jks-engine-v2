import React, { useState, useRef, useCallback } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { useArea } from '../context/AreaContext'

// --- Types ---
interface RawRow {
  customer_code: string
  customer_name: string
  latitude: number
  longitude: number
  div_sls?: string
  type?: string
  omset?: number
}

interface ValidationError {
  row: number
  field: string
  message: string
}

interface ParseResult {
  rows: RawRow[]
  errors: ValidationError[]
  totalRaw: number
}

interface KecamatanSummaryRow {
  name_1: string
  name_2: string
  name_3: string
  jumlah: number
  pct: number
}

interface StagingResult {
  staging_session_id: string
  total: number
  geocoded: number
  not_found: Array<{ customer_code: string; customer_name: string; lat: number; lon: number }>
  summary: KecamatanSummaryRow[]
}

interface CommitResult {
  upserted: number
  total: number
  empty?: boolean
}

const REQUIRED_COLUMNS = ['customer_code', 'customer_name', 'latitude', 'longitude']

const COLUMN_ALIASES: Record<string, string> = {
  customer_code: 'customer_code', kode: 'customer_code', code: 'customer_code',
  customer_name: 'customer_name', nama: 'customer_name', name: 'customer_name', toko: 'customer_name',
  latitude: 'latitude', lat: 'latitude',
  longitude: 'longitude', lon: 'longitude', lng: 'longitude',
  div_sls: 'div_sls', divisi: 'div_sls', division: 'div_sls',
  type: 'type', tier: 'type', tipe: 'type',
  omset: 'omset', omzet: 'omset',
}

function parseExcel(file: File): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer)
        const workbook = XLSX.read(data, { type: 'array' })
        const sheet = workbook.Sheets[workbook.SheetNames[0]]
        const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })

        if (raw.length === 0) {
          resolve({ rows: [], errors: [{ row: 0, field: '-', message: 'File kosong atau tidak ada data' }], totalRaw: 0 })
          return
        }

        const normalizedRows = raw.map(r => {
          const norm: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(r)) {
            const lk = k.toLowerCase().trim().replace(/\s+/g, '_')
            const mapped = COLUMN_ALIASES[lk]
            if (mapped) norm[mapped] = v
          }
          return norm
        })

        const firstRow = normalizedRows[0]
        const missingCols = REQUIRED_COLUMNS.filter(c => !(c in firstRow))
        if (missingCols.length > 0) {
          resolve({
            rows: [],
            errors: [{ row: 0, field: missingCols.join(', '), message: `Kolom wajib tidak ditemukan: ${missingCols.join(', ')}` }],
            totalRaw: raw.length,
          })
          return
        }

        const errors: ValidationError[] = []
        const rows: RawRow[] = []
        const seenCodes = new Set<string>()

        normalizedRows.forEach((r, i) => {
          const rowNum = i + 2
          const code = String(r.customer_code ?? '').trim()
          const name = String(r.customer_name ?? '').trim()
          const lat = parseFloat(String(r.latitude ?? ''))
          const lon = parseFloat(String(r.longitude ?? ''))

          if (!code) { errors.push({ row: rowNum, field: 'customer_code', message: 'Kosong' }); return }
          if (!name) { errors.push({ row: rowNum, field: 'customer_name', message: 'Kosong' }); return }
          if (isNaN(lat)) { errors.push({ row: rowNum, field: 'latitude', message: 'Bukan angka' }); return }
          if (isNaN(lon)) { errors.push({ row: rowNum, field: 'longitude', message: 'Bukan angka' }); return }
          if (lat < -11 || lat > 6) { errors.push({ row: rowNum, field: 'latitude', message: `${lat} di luar range Indonesia (-11..6)` }); return }
          if (lon < 95 || lon > 141) { errors.push({ row: rowNum, field: 'longitude', message: `${lon} di luar range Indonesia (95..141)` }); return }
          if (seenCodes.has(code)) { errors.push({ row: rowNum, field: 'customer_code', message: `Duplikat dalam file: ${code}` }); return }
          seenCodes.add(code)

          rows.push({
            customer_code: code,
            customer_name: name,
            latitude: lat,
            longitude: lon,
            div_sls: r.div_sls ? String(r.div_sls).trim() : undefined,
            type: r.type ? String(r.type).trim() : undefined,
            omset: r.omset ? parseInt(String(r.omset), 10) : undefined,
          })
        })

        resolve({ rows, errors, totalRaw: raw.length })
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

function downloadNotFound(
  notFound: Array<{ customer_code: string; customer_name: string; lat: number; lon: number }>,
  sourceFileName: string,
) {
  const headers = [
    'customer_code', 'customer_name', 'latitude', 'longitude', 'catatan',
  ]
  const rows = notFound.map(nf => [
    nf.customer_code,
    nf.customer_name,
    nf.lat,
    nf.lon,
    'Koordinat tidak cocok wilayah GADM — periksa & koreksi lat/lon',
  ])
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  ws['!cols'] = [{ wch: 16 }, { wch: 36 }, { wch: 12 }, { wch: 12 }, { wch: 52 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Tidak Ditemukan GADM')
  const base = sourceFileName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_')
  XLSX.writeFile(wb, `${base}_not_found_gadm.xlsx`)
}

// Hanya export baris yang mencurigakan (jumlah ≤ 2) — bukan semua distribusi
function downloadKecamatanAnomali(
  summary: KecamatanSummaryRow[],
  sourceFileName: string,
) {
  const anomali = summary.filter(r => r.jumlah <= 2)
  if (anomali.length === 0) return
  const headers = ['Provinsi', 'Kab/Kota', 'Kecamatan', 'Jumlah Toko', '%', 'Catatan']
  const rows = anomali.map(r => [
    r.name_1, r.name_2, r.name_3, r.jumlah, r.pct,
    'Terlalu sedikit toko — periksa apakah kecamatan sudah benar',
  ])
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  ws['!cols'] = [{ wch: 22 }, { wch: 24 }, { wch: 24 }, { wch: 12 }, { wch: 6 }, { wch: 50 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Perlu Cek')
  const base = sourceFileName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_')
  XLSX.writeFile(wb, `${base}_perlu_cek.xlsx`)
}

function downloadTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([
    ['customer_code', 'customer_name', 'latitude', 'longitude', 'div_sls', 'type', 'omset'],
    ['C2305001', 'TOKO CONTOH 1', -6.8253554, 107.1383675, 'TX2DA', 'RT-S', 500000],
    ['C2305002', 'TOKO CONTOH 2', -6.8300000, 107.1400000, 'TX2DA', 'RT-L', 1000000],
  ])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Stores')
  XLSX.writeFile(wb, 'template_toko.xlsx')
}

// idle   → user belum upload
// parsing → membaca Excel client-side
// staging → mengirim ke DB + geocode GADM (otomatis setelah parse)
// staged  → hasil geocoding siap di-review
// committing → menyimpan ke tabel stores
// result  → selesai
type PageState = 'idle' | 'parsing' | 'staging' | 'staged' | 'committing' | 'result'

export default function UploadTokoPage() {
  const { activeArea } = useArea()
  const [pageState, setPageState] = useState<PageState>('idle')
  const [isDragOver, setIsDragOver] = useState(false)
  const [fileName, setFileName] = useState('')
  const [parseResult, setParseResult] = useState<ParseResult | null>(null)
  const [stagingResult, setStagingResult] = useState<StagingResult | null>(null)
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null)
  const [stageError, setStageError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Setelah file dipilih: parse → otomatis stage + geocode
  const handleFile = useCallback(async (file: File) => {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      alert('Hanya file .xlsx atau .xls yang diterima.')
      return
    }
    if (!activeArea) {
      alert('Pilih area distribusi terlebih dahulu.')
      return
    }

    setFileName(file.name)
    setStageError('')
    setPageState('parsing')

    let parsed: ParseResult
    try {
      parsed = await parseExcel(file)
    } catch {
      parsed = {
        rows: [],
        errors: [{ row: 0, field: '-', message: 'Gagal membaca file. Pastikan format .xlsx yang valid.' }],
        totalRaw: 0,
      }
    }
    setParseResult(parsed)

    if (parsed.rows.length === 0) {
      setStageError(parsed.errors[0]?.message ?? 'Tidak ada baris yang valid untuk diupload.')
      setPageState('idle')
      return
    }

    // Langsung staging — geocoding GADM terjadi di server
    setPageState('staging')
    try {
      const { data, error } = await supabase.rpc('stage_stores', {
        p_area_id: activeArea.id,
        p_stores: parsed.rows,
      })
      if (error) throw error
      setStagingResult(data as StagingResult)
      setPageState('staged')
    } catch (err: unknown) {
      setStageError(err instanceof Error ? err.message : String(err))
      setPageState('idle')
    }
  }, [activeArea])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  // Simpan staging ke tabel stores
  const handleCommit = async () => {
    if (!stagingResult) return
    setStageError('')
    setPageState('committing')
    try {
      const { data, error } = await supabase.rpc('commit_staging', {
        p_staging_session_id: stagingResult.staging_session_id,
      })
      if (error) throw error
      const result = data as CommitResult
      // Guard: staging session sudah kosong (ter-wipe oleh upload lain ke area
      // sama, atau kedaluwarsa). Jangan tampilkan sukses palsu — minta upload ulang.
      if (result.empty || result.total === 0) {
        setStageError('Sesi staging sudah tidak berlaku (mungkin tertimpa upload lain ke area ini). Tidak ada data yang disimpan — silakan upload ulang file.')
        setStagingResult(null)
        setPageState('idle')
        return
      }
      setCommitResult(result)
      setPageState('result')
    } catch (err: unknown) {
      setStageError(err instanceof Error ? err.message : String(err))
      setPageState('staged')
    }
  }

  // Reset ke awal — bersihkan staging di DB jika ada
  const handleReset = () => {
    if (stagingResult) {
      supabase.rpc('discard_staging', {
        p_staging_session_id: stagingResult.staging_session_id,
      })
    }
    setPageState('idle')
    setParseResult(null)
    setStagingResult(null)
    setCommitResult(null)
    setStageError('')
    setFileName('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const isProcessing = pageState === 'parsing' || pageState === 'staging'

  return (
    <main className="px-margin-desktop py-lg max-w-[1600px] w-full mx-auto">

      {/* Page header */}
      <section className="mb-lg">
        <h1 className="font-headline-lg-mobile md:font-headline-lg text-headline-lg-mobile md:text-headline-lg text-primary mb-xs">
          Upload Toko
        </h1>
        <p className="font-body-md text-body-md text-on-surface-variant">
          Import data toko dari file Excel ke database area aktif.
        </p>
      </section>

      {/* Area belum dipilih */}
      {!activeArea && (
        <div className="bg-surface-container-lowest border border-secondary/10 rounded-xl p-lg shadow-sm flex items-start gap-md">
          <span className="material-symbols-outlined mt-[2px]" style={{ color: '#c6c6cd', fontSize: 24 }}>location_off</span>
          <div>
            <p className="font-headline-md text-headline-md text-on-surface-variant">Area belum dipilih</p>
            <p className="font-body-sm text-body-sm text-on-surface-variant mt-xs">
              Pilih area distribusi (depo) terlebih dahulu melalui picker di pojok kanan atas.
            </p>
          </div>
        </div>
      )}

      {activeArea && (
        <>
          {/* Area aktif badge */}
          <div className="mb-lg p-md rounded-lg border border-on-tertiary-container/20 flex items-center gap-md"
               style={{ background: 'rgba(12,148,136,0.05)' }}>
            <span className="material-symbols-outlined" style={{ color: '#0c9488' }}>location_on</span>
            <div className="flex-1 flex flex-wrap items-center gap-md">
              <span className="font-headline-md text-headline-md text-primary">{activeArea.nama_area}</span>
              <span className="font-label-md text-label-md px-sm py-[2px] rounded"
                    style={{ color: '#0c9488', background: 'rgba(107,216,203,0.2)' }}>
                {activeArea.kd_dist}
              </span>
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                {activeArea.cabang.nama_cabang} · {activeArea.region.nama_region}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-xl">

            {/* Left col */}
            <section className="lg:col-span-8 flex flex-col gap-lg">

              {/* --- IDLE / PARSING --- */}
              {(pageState === 'idle' || pageState === 'parsing') && (
                <div className="bg-surface-container-lowest border border-secondary/10 rounded-xl p-xl flex flex-col gap-lg shadow-sm">
                  <div className="flex items-center justify-between">
                    <h3 className="font-headline-md text-headline-md text-primary">Sumber Data</h3>
                    <div className="flex gap-sm">
                      <span className="bg-secondary-container text-on-secondary-container px-md py-xs text-label-md rounded-lg font-label-md">XLSX</span>
                      <span className="bg-secondary-container text-on-secondary-container px-md py-xs text-label-md rounded-lg font-label-md">XLS</span>
                    </div>
                  </div>

                  {/* Error banner */}
                  {stageError && (
                    <div className="rounded-lg border p-md flex items-center gap-sm"
                         style={{ borderColor: 'rgba(186,26,26,0.2)', background: 'rgba(255,218,214,0.2)' }}>
                      <span className="material-symbols-outlined text-error" style={{ fontSize: 18 }}>warning</span>
                      <p className="font-body-sm text-body-sm text-error flex-1">{stageError}</p>
                      <button onClick={() => setStageError('')}
                              className="p-xs rounded hover:bg-error/10 text-error">
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                      </button>
                    </div>
                  )}

                  {/* Drop zone */}
                  <div
                    className={`border-2 border-dashed rounded-xl p-xl flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-200 min-h-[280px] group ${
                      pageState === 'parsing'
                        ? 'border-primary/40 bg-surface-container-low cursor-wait'
                        : isDragOver
                        ? 'border-primary bg-surface-container-low'
                        : 'border-outline-variant hover:bg-surface-container-low hover:border-primary/40'
                    }`}
                    onClick={() => pageState === 'idle' && fileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
                    onDragLeave={() => setIsDragOver(false)}
                    onDrop={handleDrop}
                  >
                    {pageState === 'parsing' ? (
                      <>
                        <span className="material-symbols-outlined text-5xl animate-spin mb-md" style={{ color: '#0c9488' }}>autorenew</span>
                        <p className="font-headline-md text-headline-md text-primary">{fileName}</p>
                        <p className="font-body-sm text-body-sm text-on-surface-variant mt-xs">Membaca file Excel...</p>
                      </>
                    ) : (
                      <>
                        <div className="w-20 h-20 rounded-full flex items-center justify-center mb-lg group-hover:scale-105 transition-transform"
                             style={{ background: '#dae2fd' }}>
                          <span className="material-symbols-outlined text-primary text-[40px]">upload_file</span>
                        </div>
                        <p className="font-headline-md text-headline-md text-primary mb-sm" style={{ width: 280 }}>
                          Klik atau drag &amp; drop file
                        </p>
                        <p className="font-body-md text-body-md text-on-surface-variant" style={{ width: 280 }}>
                          File Excel (.xlsx / .xls). Maksimum 25MB.
                        </p>
                      </>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".xlsx,.xls"
                      className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
                    />
                  </div>

                  {/* Info row */}
                  <div className="flex flex-col md:flex-row items-start md:items-center gap-md">
                    <div className="flex items-start gap-sm flex-1">
                      <span className="material-symbols-outlined text-on-secondary-container mt-0.5" style={{ fontSize: 18 }}>info</span>
                      <p className="font-body-sm text-body-sm text-on-surface-variant">
                        Kolom wajib:{' '}
                        {REQUIRED_COLUMNS.map(c => (
                          <code key={c} className="font-data-mono bg-surface-container px-1 rounded text-primary mx-0.5">{c}</code>
                        ))}
                      </p>
                    </div>
                    <button
                      onClick={downloadTemplate}
                      className="flex items-center gap-sm px-md py-sm rounded-lg border border-secondary/20 font-label-md text-label-md text-on-surface-variant hover:bg-surface-container transition-colors shrink-0"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>download</span>
                      Download Template
                    </button>
                  </div>
                </div>
              )}

              {/* --- STAGING (otomatis, tidak ada tombol) --- */}
              {pageState === 'staging' && parseResult && (
                <div className="bg-surface-container-lowest border border-secondary/10 rounded-xl p-xl shadow-sm flex flex-col gap-lg">
                  {/* File info */}
                  <div className="flex items-center gap-sm">
                    <span className="material-symbols-outlined" style={{ color: '#0c9488' }}>description</span>
                    <div>
                      <p className="font-headline-md text-headline-md text-primary">{fileName}</p>
                      <p className="font-body-sm text-body-sm text-on-surface-variant">
                        {parseResult.totalRaw} baris dibaca · {parseResult.rows.length} valid
                        {parseResult.errors.length > 0 && ` · ${parseResult.errors.length} dilewati`}
                      </p>
                    </div>
                  </div>

                  {/* Validation errors (collapsed) */}
                  {parseResult.errors.length > 0 && (
                    <div className="rounded-lg border p-md" style={{ borderColor: 'rgba(186,26,26,0.2)', background: 'rgba(255,218,214,0.15)' }}>
                      <div className="flex items-center gap-sm mb-sm">
                        <span className="material-symbols-outlined text-error" style={{ fontSize: 16 }}>error</span>
                        <p className="font-label-md text-label-md text-error">
                          {parseResult.errors.length} baris tidak valid (tidak akan diupload)
                        </p>
                      </div>
                      <div className="max-h-24 overflow-y-auto space-y-0.5">
                        {parseResult.errors.slice(0, 10).map((e, i) => (
                          <p key={i} className="font-body-sm text-body-sm text-error">
                            Baris {e.row} · <code className="font-data-mono">{e.field}</code>: {e.message}
                          </p>
                        ))}
                        {parseResult.errors.length > 10 && (
                          <p className="font-body-sm text-body-sm text-error">... dan {parseResult.errors.length - 10} lainnya</p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Geocoding progress */}
                  <div className="flex flex-col items-center py-xl gap-md">
                    <div className="w-14 h-14 rounded-full flex items-center justify-center"
                         style={{ background: 'rgba(12,148,136,0.08)' }}>
                      <span className="material-symbols-outlined animate-spin" style={{ color: '#0c9488', fontSize: 32 }}>autorenew</span>
                    </div>
                    <div className="text-center">
                      <p className="font-headline-md text-headline-md text-primary">
                        Menganalisis {parseResult.rows.length} toko...
                      </p>
                      <p className="font-body-sm text-body-sm text-on-surface-variant mt-xs">
                        Memetakan koordinat ke kecamatan &amp; kelurahan via GADM
                      </p>
                    </div>
                    <button
                      onClick={handleReset}
                      className="px-lg py-sm rounded-lg border border-secondary/20 font-label-md text-label-md text-on-surface-variant hover:bg-surface-container transition-colors"
                    >
                      Batal
                    </button>
                  </div>
                </div>
              )}

              {/* --- STAGED / COMMITTING --- */}
              {(pageState === 'staged' || pageState === 'committing') && stagingResult && (
                <div className="bg-surface-container-lowest border border-secondary/10 rounded-xl p-xl shadow-sm flex flex-col gap-lg">
                  {/* Header */}
                  <div className="flex items-center gap-md">
                    <div className="w-12 h-12 rounded-full flex items-center justify-center shrink-0"
                         style={{ background: 'rgba(12,148,136,0.08)' }}>
                      <span className="material-symbols-outlined" style={{ color: '#0c9488', fontSize: 28 }}>location_searching</span>
                    </div>
                    <div className="flex-1">
                      <p className="font-headline-md text-headline-md text-primary">Geocoding selesai — periksa sebelum menyimpan</p>
                      <p className="font-body-sm text-body-sm text-on-surface-variant">
                        {fileName} · {activeArea.nama_area}
                      </p>
                    </div>
                    <button onClick={handleReset} disabled={pageState === 'committing'}
                            className="p-sm rounded-lg hover:bg-surface-container transition-colors text-on-surface-variant disabled:opacity-40">
                      <span className="material-symbols-outlined" style={{ fontSize: 20 }}>close</span>
                    </button>
                  </div>

                  {/* Stats */}
                  <div className="grid grid-cols-3 gap-md">
                    <StatCard label="Total Toko" value={stagingResult.total} />
                    <StatCard label="Ter-geocode" value={stagingResult.geocoded} accent />
                    <StatCard label="Tidak Ditemukan" value={stagingResult.not_found.length}
                              error={stagingResult.not_found.length > 0} />
                  </div>

                  {/* Baris di-skip saat parsing (tetap terlihat di langkah keputusan) */}
                  {parseResult && parseResult.errors.length > 0 && (
                    <div className="rounded-lg border p-md" style={{ borderColor: 'rgba(186,26,26,0.2)', background: 'rgba(255,218,214,0.15)' }}>
                      <div className="flex items-center gap-sm mb-sm">
                        <span className="material-symbols-outlined text-error" style={{ fontSize: 16 }}>error</span>
                        <p className="font-label-md text-label-md text-error flex-1">
                          {parseResult.errors.length} dari {parseResult.totalRaw} baris dilewati saat parsing (tidak ikut disimpan)
                        </p>
                      </div>
                      <div className="max-h-24 overflow-y-auto space-y-0.5">
                        {parseResult.errors.slice(0, 10).map((e, i) => (
                          <p key={i} className="font-body-sm text-body-sm text-error">
                            Baris {e.row} · <code className="font-data-mono">{e.field}</code>: {e.message}
                          </p>
                        ))}
                        {parseResult.errors.length > 10 && (
                          <p className="font-body-sm text-body-sm text-error">... dan {parseResult.errors.length - 10} lainnya</p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Review tabs: Not Found GADM + Kecamatan Mencurigakan */}
                  <ReviewPanel
                    notFound={stagingResult.not_found}
                    summary={stagingResult.summary}
                    fileName={fileName}
                  />

                  {/* Commit error */}
                  {stageError && (
                    <div className="rounded-lg border p-md flex items-center gap-sm"
                         style={{ borderColor: 'rgba(186,26,26,0.2)', background: 'rgba(255,218,214,0.2)' }}>
                      <span className="material-symbols-outlined text-error" style={{ fontSize: 18 }}>warning</span>
                      <p className="font-body-sm text-body-sm text-error">{stageError}</p>
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex items-center gap-md pt-xs border-t border-secondary/10">
                    <button
                      onClick={handleCommit}
                      disabled={pageState === 'committing'}
                      className="flex-1 flex items-center justify-center gap-sm bg-primary text-on-primary py-md px-xl rounded-lg font-label-md text-label-md transition-all hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {pageState === 'committing' ? (
                        <>
                          <span className="material-symbols-outlined animate-spin" style={{ fontSize: 18 }}>autorenew</span>
                          Menyimpan ke database...
                        </>
                      ) : (
                        <>
                          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>save</span>
                          Simpan {stagingResult.total} Toko ke {activeArea.nama_area}
                        </>
                      )}
                    </button>
                    <button
                      onClick={handleReset}
                      disabled={pageState === 'committing'}
                      className="px-lg py-md rounded-lg border border-secondary/20 font-label-md text-label-md text-on-surface-variant hover:bg-surface-container transition-colors disabled:opacity-60"
                    >
                      Batal
                    </button>
                  </div>
                </div>
              )}

              {/* --- RESULT --- */}
              {pageState === 'result' && commitResult && (
                <div className="bg-surface-container-lowest border border-secondary/10 rounded-xl p-xl shadow-sm flex flex-col gap-lg">
                  <div className="flex items-center gap-md">
                    <div className="w-12 h-12 rounded-full flex items-center justify-center shrink-0"
                         style={{ background: 'rgba(12,148,136,0.12)' }}>
                      <span className="material-symbols-outlined" style={{ color: '#0c9488', fontSize: 28 }}>check_circle</span>
                    </div>
                    <div>
                      <p className="font-headline-md text-headline-md text-primary">Data berhasil disimpan!</p>
                      <p className="font-body-sm text-body-sm text-on-surface-variant">
                        {fileName} → {activeArea.nama_area} — lengkap dengan Provinsi · Kota · Kecamatan · Kelurahan
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-md">
                    <StatCard label="Tersimpan / Diperbarui" value={commitResult.upserted} accent />
                    <StatCard label="Total Diproses" value={commitResult.total} />
                  </div>

                  <button
                    onClick={handleReset}
                    className="flex items-center justify-center gap-sm bg-primary text-on-primary py-md px-xl rounded-lg font-label-md text-label-md hover:bg-primary/90 transition-all"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>upload_file</span>
                    Upload File Lain
                  </button>
                </div>
              )}
            </section>

            {/* Right col — Quick Guide */}
            <aside className="lg:col-span-4">
              <div className="bg-surface-container border border-secondary/10 rounded-xl p-xl shadow-sm sticky top-4">
                <h3 className="font-headline-md text-headline-md text-primary mb-xl">Panduan Upload</h3>
                <ul className="flex flex-col gap-lg">
                  {GUIDE_STEPS.map(step => (
                    <li key={step.n} className="flex gap-md">
                      <div className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm"
                           style={{ background: isProcessing && step.active ? '#0c9488' : '#7c839b', color: '#fff' }}>
                        {step.n}
                      </div>
                      <div>
                        <p className="font-bold text-sm text-primary mb-xs">{step.title}</p>
                        <p className="font-body-sm text-body-sm text-on-surface-variant">{step.desc}</p>
                      </div>
                    </li>
                  ))}
                </ul>

                <div className="mt-xl pt-xl border-t border-secondary/10">
                  <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wide mb-md">Kolom Excel</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-secondary/10">
                        <th className="py-1 text-left font-label-md text-label-md text-on-surface-variant">Kolom</th>
                        <th className="py-1 text-left font-label-md text-label-md text-on-surface-variant">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {COLUMN_DOCS.map(r => (
                        <tr key={r.col} className="border-b border-secondary/10 last:border-0">
                          <td className="py-1.5 font-data-mono text-data-mono text-primary">{r.col}</td>
                          <td className="py-1.5">
                            {r.req
                              ? <span className="text-[10px] font-bold px-1 py-0.5 rounded" style={{ background: 'rgba(12,148,136,0.15)', color: '#0c9488' }}>WAJIB</span>
                              : <span className="text-[10px] font-bold px-1 py-0.5 rounded text-on-surface-variant" style={{ background: '#eceef0' }}>opsional</span>
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <button
                    onClick={downloadTemplate}
                    className="mt-lg w-full flex items-center justify-center gap-sm border border-secondary/20 rounded-lg py-sm font-label-md text-label-md text-on-surface-variant hover:bg-surface-container-low transition-colors"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>download</span>
                    Download Template
                  </button>
                </div>
              </div>
            </aside>

          </div>
        </>
      )}
    </main>
  )
}

// --- Sub-components ---
function StatCard({ label, value, accent, error }: { label: string; value: number; accent?: boolean; error?: boolean }) {
  return (
    <div className="rounded-lg p-md border text-center"
         style={{
           borderColor: error ? 'rgba(186,26,26,0.2)' : 'rgba(80,95,118,0.1)',
           background: accent ? 'rgba(12,148,136,0.05)' : error ? 'rgba(255,218,214,0.2)' : '#f7f9fb',
         }}>
      <p className="font-headline-lg text-headline-lg"
         style={{ color: accent ? '#0c9488' : error ? '#ba1a1a' : '#000' }}>
        {value}
      </p>
      <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wide">{label}</p>
    </div>
  )
}

function ReviewPanel({
  notFound, summary, fileName,
}: {
  notFound : StagingResult['not_found']
  summary  : KecamatanSummaryRow[]
  fileName : string
}) {
  const anomali     = summary.filter(r => r.jumlah <= 2)
  const hasNotFound = notFound.length > 0
  const hasAnomali  = anomali.length > 0

  // Default ke tab pertama yang punya isu
  const [tab, setTab] = React.useState<'not_found' | 'anomali'>(
    hasNotFound ? 'not_found' : 'anomali',
  )

  // Panel tidak ditampilkan sama sekali kalau tidak ada isu
  if (!hasNotFound && !hasAnomali) return null

  return (
    <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'rgba(80,95,118,0.15)' }}>

      {/* ── Tab headers — hanya tab yang punya isu ── */}
      <div className="flex" style={{ background: '#f2f4f6', borderBottom: '1px solid rgba(80,95,118,0.1)' }}>
        {hasNotFound && (
          <button
            onClick={() => setTab('not_found')}
            className="flex items-center gap-[5px] px-md py-sm text-xs font-semibold border-b-2 transition-colors"
            style={{
              borderColor: tab === 'not_found' ? '#ba1a1a' : 'transparent',
              color:       tab === 'not_found' ? '#ba1a1a' : '#9099a8',
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 13 }}>location_off</span>
            Tidak Ditemukan GADM
            <span className="ml-[3px] px-[5px] py-[1px] rounded-full text-[10px] font-bold"
                  style={{ background: 'rgba(186,26,26,0.15)', color: '#ba1a1a' }}>
              {notFound.length}
            </span>
          </button>
        )}
        {hasAnomali && (
          <button
            onClick={() => setTab('anomali')}
            className="flex items-center gap-[5px] px-md py-sm text-xs font-semibold border-b-2 transition-colors"
            style={{
              borderColor: tab === 'anomali' ? '#ba1a1a' : 'transparent',
              color:       tab === 'anomali' ? '#ba1a1a' : '#9099a8',
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 13 }}>warning</span>
            Kecamatan Mencurigakan
            <span className="ml-[3px] px-[5px] py-[1px] rounded-full text-[10px] font-bold"
                  style={{ background: 'rgba(186,26,26,0.15)', color: '#ba1a1a' }}>
              {anomali.length}
            </span>
          </button>
        )}
      </div>

      {/* ── Konten Tab 1: Tidak Ditemukan GADM ── */}
      {tab === 'not_found' && hasNotFound && (
        <>
          <div className="flex items-center gap-sm px-md py-xs"
               style={{ background: 'rgba(255,218,214,0.12)', borderBottom: '1px solid rgba(186,26,26,0.08)' }}>
            <p className="text-[11px] text-on-surface-variant flex-1">
              Kolom gadm_* akan kosong — periksa & koreksi koordinat toko ini
            </p>
            <button
              onClick={() => downloadNotFound(notFound, fileName)}
              className="flex items-center gap-[4px] px-sm py-[3px] rounded text-[11px] font-semibold border transition-colors hover:bg-error/5"
              style={{ borderColor: 'rgba(186,26,26,0.3)', color: '#ba1a1a', background: 'rgba(255,255,255,0.85)' }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>download</span>
              Download
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            <table className="w-full text-xs">
              <thead style={{ background: '#f7f9fb', position: 'sticky', top: 0 }}>
                <tr>
                  <th className="px-3 py-1.5 text-left font-label-md text-label-md text-on-surface-variant">Kode</th>
                  <th className="px-3 py-1.5 text-left font-label-md text-label-md text-on-surface-variant">Nama</th>
                  <th className="px-3 py-1.5 text-left font-label-md text-label-md text-on-surface-variant">Lat</th>
                  <th className="px-3 py-1.5 text-left font-label-md text-label-md text-on-surface-variant">Lon</th>
                </tr>
              </thead>
              <tbody>
                {notFound.map((nf, i) => (
                  <tr key={i} className="border-t border-secondary/10">
                    <td className="px-3 py-1 font-data-mono text-data-mono">{nf.customer_code}</td>
                    <td className="px-3 py-1 font-body-sm text-body-sm max-w-[180px] truncate"
                        title={nf.customer_name}>{nf.customer_name}</td>
                    <td className="px-3 py-1 font-data-mono text-data-mono text-on-surface-variant">{nf.lat.toFixed(5)}</td>
                    <td className="px-3 py-1 font-data-mono text-data-mono text-on-surface-variant">{nf.lon.toFixed(5)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Konten Tab 2: Kecamatan Mencurigakan ── */}
      {tab === 'anomali' && hasAnomali && (
        <>
          <div className="flex items-center gap-sm px-md py-xs"
               style={{ background: 'rgba(255,218,214,0.12)', borderBottom: '1px solid rgba(186,26,26,0.08)' }}>
            <p className="text-[11px] text-on-surface-variant flex-1">
              Kecamatan dengan ≤ 2 toko — kemungkinan koordinat salah kecamatan
            </p>
            <button
              onClick={() => downloadKecamatanAnomali(summary, fileName)}
              className="flex items-center gap-[4px] px-sm py-[3px] rounded text-[11px] font-semibold border transition-colors hover:bg-error/5"
              style={{ borderColor: 'rgba(186,26,26,0.3)', color: '#ba1a1a', background: 'rgba(255,255,255,0.85)' }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>download</span>
              Download
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            <table className="w-full text-xs">
              <thead style={{ background: '#f7f9fb', position: 'sticky', top: 0 }}>
                <tr>
                  <th className="px-3 py-1.5 text-left font-label-md text-label-md text-on-surface-variant">Provinsi</th>
                  <th className="px-3 py-1.5 text-left font-label-md text-label-md text-on-surface-variant">Kab/Kota</th>
                  <th className="px-3 py-1.5 text-left font-label-md text-label-md text-on-surface-variant">Kecamatan</th>
                  <th className="px-3 py-1.5 text-right font-label-md text-label-md text-on-surface-variant">Toko</th>
                  <th className="px-3 py-1.5 text-right font-label-md text-label-md text-on-surface-variant">%</th>
                </tr>
              </thead>
              <tbody>
                {anomali.map((row, i) => (
                  <tr key={i} className="border-t border-secondary/10"
                      style={{ background: 'rgba(255,218,214,0.25)' }}>
                    <td className="px-3 py-1.5 font-body-sm text-body-sm text-on-surface-variant">{row.name_1}</td>
                    <td className="px-3 py-1.5 font-body-sm text-body-sm">{row.name_2}</td>
                    <td className="px-3 py-1.5 font-body-sm text-body-sm font-semibold">{row.name_3}</td>
                    <td className="px-3 py-1.5 font-data-mono text-data-mono text-right font-bold"
                        style={{ color: '#ba1a1a' }}>{row.jumlah}</td>
                    <td className="px-3 py-1.5 font-data-mono text-data-mono text-right text-on-surface-variant">{row.pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// --- Static data ---
const GUIDE_STEPS = [
  { n: '1', title: 'Siapkan File', desc: 'Download template Excel dan isi data toko: kode, nama, koordinat GPS.', active: false },
  { n: '2', title: 'Pilih Area', desc: 'Pastikan area distribusi yang tepat sudah dipilih di picker kanan atas.', active: false },
  { n: '3', title: 'Upload File', desc: 'Drag-drop atau klik untuk memilih file. Geocoding kecamatan & kelurahan berjalan otomatis.', active: true },
  { n: '4', title: 'Simpan', desc: 'Periksa distribusi kecamatan. Klik Simpan — toko baru ditambah, lama diperbarui (upsert).', active: false },
]

const COLUMN_DOCS = [
  { col: 'customer_code', req: true },
  { col: 'customer_name', req: true },
  { col: 'latitude', req: true },
  { col: 'longitude', req: true },
  { col: 'div_sls', req: false },
  { col: 'type', req: false },
  { col: 'omset', req: false },
]

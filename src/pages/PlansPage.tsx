import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useArea } from '../context/AreaContext'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface DivisionMeta {
  div_sls           : string
  n_sales           : number
  work_days         : number
  cycle             : string
  philosophy        : string
  store_count       : number
  balance_tolerance?: number
}

interface Plan {
  id          : string
  plan_name   : string
  status      : 'DRAFT' | 'APPROVED' | 'ARCHIVED'
  divisions   : DivisionMeta[]
  summary     : Record<string, unknown>
  store_count : number
  created_by  : string | null
  created_at  : string
  approved_at : string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function StatusBadge({ status }: { status: Plan['status'] }) {
  const cfg = {
    DRAFT:    { label: 'Draft',   color: '#45464d', bg: '#e0e3e5' },
    APPROVED: { label: 'Aktif',   color: '#0c9488', bg: 'rgba(12,148,136,0.15)' },
    ARCHIVED: { label: 'Arsip',   color: '#9099a8', bg: 'rgba(80,95,118,0.08)' },
  }[status]
  return (
    <span className="text-[10px] font-bold px-sm py-[3px] rounded-full"
          style={{ color: cfg.color, background: cfg.bg }}>
      {cfg.label}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PlanCard
// ─────────────────────────────────────────────────────────────────────────────

function PlanCard({
  plan, onApprove, onDiscard, approving, discarding, onViewMap,
}: {
  plan      : Plan
  onApprove : (id: string) => void
  onDiscard : (id: string) => void
  approving : boolean
  discarding: boolean
  onViewMap : (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-surface-container-lowest border rounded-xl overflow-hidden shadow-sm transition-all"
         style={{
           borderColor: plan.status === 'APPROVED'
             ? 'rgba(12,148,136,0.4)'
             : plan.status === 'DRAFT'
             ? 'rgba(80,95,118,0.2)'
             : 'rgba(80,95,118,0.1)',
         }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-sm p-md cursor-pointer select-none"
           onClick={() => setExpanded(e => !e)}
           style={{
             background: plan.status === 'APPROVED' ? 'rgba(12,148,136,0.04)' : '#f2f4f6',
           }}>

        {/* Status icon */}
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-[2px]"
             style={{
               background: plan.status === 'APPROVED'
                 ? 'rgba(12,148,136,0.15)'
                 : plan.status === 'DRAFT'
                 ? 'rgba(59,130,246,0.12)'
                 : 'rgba(80,95,118,0.08)',
             }}>
          <span className="material-symbols-outlined ms-fill" style={{
            fontSize: 18,
            color: plan.status === 'APPROVED' ? '#0c9488'
                 : plan.status === 'DRAFT'    ? '#3b82f6'
                 :                             '#9099a8',
          }}>
            {plan.status === 'APPROVED' ? 'check_circle'
           : plan.status === 'DRAFT'    ? 'edit_note'
           :                             'inventory_2'}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-xs flex-wrap mb-[2px]">
            <span className="font-data-mono font-bold text-sm text-on-surface truncate">{plan.plan_name}</span>
            <StatusBadge status={plan.status} />
          </div>
          <div className="flex items-center gap-xs text-[10px] text-on-surface-variant flex-wrap">
            <span className="material-symbols-outlined" style={{ fontSize: 11 }}>store</span>
            <span>{plan.store_count} toko</span>
            <span>·</span>
            <span className="material-symbols-outlined" style={{ fontSize: 11 }}>group</span>
            <span>{plan.divisions.reduce((s, d) => s + (d.n_sales || 0), 0)} sales</span>
            <span>·</span>
            <span className="material-symbols-outlined" style={{ fontSize: 11 }}>schedule</span>
            <span>{fmtDate(plan.created_at)}</span>
            {plan.approved_at && (
              <>
                <span>·</span>
                <span className="font-semibold" style={{ color: '#0c9488' }}>
                  Aktif sejak {fmtDate(plan.approved_at)}
                </span>
              </>
            )}
          </div>
        </div>

        <span className="material-symbols-outlined text-on-surface-variant shrink-0 self-start mt-1" style={{ fontSize: 18 }}>
          {expanded ? 'expand_less' : 'expand_more'}
        </span>
      </div>

      {/* ── Detail (expanded) ───────────────────────────────────────────────── */}
      {expanded && (
        <div className="p-md flex flex-col gap-md" style={{ borderTop: '1px solid rgba(80,95,118,0.1)' }}>

          {/* Divisi */}
          {plan.divisions.length > 0 && (
            <div>
              <p className="text-[9px] font-bold tracking-widest uppercase text-on-surface-variant mb-xs">
                Konfigurasi Divisi
              </p>
              <div className="flex flex-col gap-[4px]">
                {plan.divisions.map((d, i) => (
                  <div key={i} className="flex items-center gap-sm text-[11px] rounded-lg px-sm py-xs"
                       style={{ background: '#f7f9fb', border: '1px solid rgba(80,95,118,0.1)' }}>
                    <span className="font-data-mono font-bold text-primary w-16 shrink-0">{d.div_sls}</span>
                    <span className="text-on-surface-variant">
                      {d.n_sales} sales · {d.work_days} hari/siklus · {d.cycle} · {d.philosophy}
                    </span>
                    <span className="ml-auto font-data-mono text-on-surface-variant">{d.store_count} toko</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Lihat di Peta */}
          <button
            onClick={() => onViewMap(plan.id)}
            className="w-full flex items-center justify-center gap-xs py-sm rounded-xl border font-label-md text-label-md text-sm transition-all hover:bg-surface-container-high"
            style={{ borderColor: 'rgba(80,95,118,0.2)', color: '#45464d', background: '#f7f9fb' }}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>map</span>
            Lihat di Peta
          </button>

          {/* Action buttons */}
          <div className="flex gap-sm">
            {plan.status === 'DRAFT' && (
              <>
                <button
                  onClick={() => onApprove(plan.id)}
                  disabled={approving}
                  className="flex-1 flex items-center justify-center gap-xs py-sm rounded-xl font-label-md text-label-md transition-all disabled:opacity-50 text-sm"
                  style={{ background: '#0c9488', color: '#fff' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                    {approving ? 'sync' : 'check_circle'}
                  </span>
                  {approving ? 'Mengaktifkan…' : 'Aktifkan Plan'}
                </button>
                <button
                  onClick={() => onDiscard(plan.id)}
                  disabled={discarding}
                  className="flex items-center justify-center gap-xs px-md py-sm rounded-xl border font-label-md text-label-md text-sm transition-all disabled:opacity-50 hover:bg-error/5 hover:border-error/30 hover:text-error"
                  style={{ borderColor: 'rgba(80,95,118,0.2)', color: '#9099a8' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
                    {discarding ? 'sync' : 'delete'}
                  </span>
                  {discarding ? 'Menghapus…' : 'Hapus Draft'}
                </button>
              </>
            )}
            {plan.status === 'APPROVED' && (
              <div className="flex items-center gap-xs px-sm py-xs rounded-lg text-[11px] font-semibold w-full"
                   style={{ background: 'rgba(12,148,136,0.08)', color: '#0c9488' }}>
                <span className="material-symbols-outlined ms-fill" style={{ fontSize: 14 }}>verified</span>
                Plan aktif — digunakan oleh field sales
              </div>
            )}
            {plan.status === 'ARCHIVED' && (
              <div className="flex items-center gap-xs px-sm py-xs rounded-lg text-[11px] w-full"
                   style={{ background: 'rgba(80,95,118,0.06)', color: '#9099a8' }}>
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>history</span>
                Plan diarsipkan — sudah digantikan plan baru
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PlansPage
// ─────────────────────────────────────────────────────────────────────────────

export default function PlansPage() {
  const { activeArea }   = useArea()
  const { user }         = useAuth()
  const navigate         = useNavigate()

  const [plans,    setPlans]    = useState<Plan[]>([])
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  // Per-plan action loading state
  const [approvingId,  setApprovingId]  = useState<string | null>(null)
  const [discardingId, setDiscardingId] = useState<string | null>(null)

  // ── Load plans ─────────────────────────────────────────────────────────────
  const loadPlans = useCallback(async () => {
    if (!activeArea) return
    setLoading(true); setError(null)
    const { data, error: err } = await supabase
      .rpc('get_plans_by_area', { p_area_id: activeArea.id })
    if (err) setError(err.message)
    else setPlans((data as Plan[]) ?? [])
    setLoading(false)
  }, [activeArea])

  useEffect(() => { loadPlans() }, [loadPlans])

  // ── Approve ────────────────────────────────────────────────────────────────
  async function handleApprove(planId: string) {
    if (!user) return
    setApprovingId(planId)
    const { error: err } = await supabase
      .rpc('approve_plan', { p_plan_id: planId, p_user_id: user.id })
    if (err) alert(`Gagal mengaktifkan plan: ${err.message}`)
    else await loadPlans()
    setApprovingId(null)
  }

  // ── Discard ────────────────────────────────────────────────────────────────
  async function handleDiscard(planId: string) {
    const plan = plans.find(p => p.id === planId)
    if (!plan) return
    if (!window.confirm(`Hapus draft "${plan.plan_name}"? Aksi ini tidak bisa dibatalkan.`)) return
    setDiscardingId(planId)
    const { error: err } = await supabase
      .rpc('discard_plan', { p_plan_id: planId })
    if (err) alert(`Gagal menghapus draft: ${err.message}`)
    else await loadPlans()
    setDiscardingId(null)
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (!activeArea) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-md text-center p-xl">
        <span className="material-symbols-outlined text-[48px]" style={{ color: '#c6c6cd' }}>location_off</span>
        <p className="font-headline-md text-headline-md text-primary">Belum ada area terpilih</p>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Pilih area di Dashboard untuk melihat daftar plan.
        </p>
        <button onClick={() => navigate('/')}
                className="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors">
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>dashboard</span>
          Ke Dashboard
        </button>
      </div>
    )
  }

  const draftPlans    = plans.filter(p => p.status === 'DRAFT')
  const approvedPlan  = plans.find(p => p.status === 'APPROVED')
  const archivedPlans = plans.filter(p => p.status === 'ARCHIVED')

  return (
    <div className="px-margin-desktop py-lg max-w-[960px] w-full mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between mb-lg gap-md flex-wrap">
        <div>
          <h1 className="font-headline-lg text-headline-lg text-primary">Daftar Plan</h1>
          <p className="font-body-md text-body-md text-on-surface-variant mt-xs">
            {activeArea.nama_area} · {activeArea.kd_dist}
          </p>
        </div>
        <button onClick={() => navigate('/routing')}
                className="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-xl font-label-md text-label-md hover:bg-primary/90 transition-colors text-sm shrink-0">
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
          Buat Plan Baru
        </button>
      </div>

      {/* ── Loading / Error ─────────────────────────────────────────────────── */}
      {loading && (
        <div className="flex items-center justify-center py-xl gap-sm text-on-surface-variant">
          <span className="material-symbols-outlined animate-spin" style={{ fontSize: 20 }}>sync</span>
          <span className="text-sm">Memuat plan…</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-sm p-md rounded-xl mb-lg text-sm"
             style={{ background: 'rgba(186,26,26,0.06)', border: '1px solid rgba(186,26,26,0.2)', color: '#ba1a1a' }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>error</span>
          {error}
          <button onClick={loadPlans} className="ml-auto underline text-xs">Coba lagi</button>
        </div>
      )}

      {!loading && !error && plans.length === 0 && (
        <div className="flex flex-col items-center justify-center py-xl gap-md text-center">
          <span className="material-symbols-outlined text-[48px]" style={{ color: '#c6c6cd' }}>route</span>
          <p className="font-headline-md text-headline-md text-primary">Belum ada plan</p>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Generate plan pertama dari Routing Engine.
          </p>
          <button onClick={() => navigate('/routing')}
                  className="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>route</span>
            Ke Routing Engine
          </button>
        </div>
      )}

      {/* ── Plan Aktif ─────────────────────────────────────────────────────── */}
      {approvedPlan && (
        <section className="mb-lg">
          <p className="text-[9px] font-bold tracking-widest uppercase text-on-surface-variant mb-sm">
            Plan Aktif
          </p>
          <PlanCard
            plan={approvedPlan}
            onApprove={handleApprove} onDiscard={handleDiscard}
            approving={approvingId === approvedPlan.id}
            discarding={discardingId === approvedPlan.id}
            onViewMap={id => navigate(`/plans/${id}/map`)}
          />
        </section>
      )}

      {/* ── Draft Plans ────────────────────────────────────────────────────── */}
      {draftPlans.length > 0 && (
        <section className="mb-lg">
          <p className="text-[9px] font-bold tracking-widest uppercase text-on-surface-variant mb-sm">
            Draft ({draftPlans.length})
          </p>
          <div className="flex flex-col gap-sm">
            {draftPlans.map(p => (
              <PlanCard key={p.id} plan={p}
                onApprove={handleApprove} onDiscard={handleDiscard}
                approving={approvingId === p.id} discarding={discardingId === p.id}
                onViewMap={id => navigate(`/plans/${id}/map`)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Arsip ──────────────────────────────────────────────────────────── */}
      {archivedPlans.length > 0 && (
        <section>
          <p className="text-[9px] font-bold tracking-widest uppercase text-on-surface-variant mb-sm">
            Arsip ({archivedPlans.length})
          </p>
          <div className="flex flex-col gap-sm">
            {archivedPlans.map(p => (
              <PlanCard key={p.id} plan={p}
                onApprove={handleApprove} onDiscard={handleDiscard}
                approving={false} discarding={false}
                onViewMap={id => navigate(`/plans/${id}/map`)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

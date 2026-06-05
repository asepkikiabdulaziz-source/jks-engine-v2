// ==============================================================================
// generate-plan  —  Edge Function
//
// Flow:
//   1. Verifikasi JWT user
//   2. Load stores aktif dari DB (via get_stores_by_area)
//   3. POST ke Python engine (ROUTE_ENGINE_URL)
//   4. Simpan atomik ke DB via save_plan RPC
//   5. Return { plan_id, plan_name }
//
// Env vars yang wajib diset di Supabase dashboard:
//   ROUTE_ENGINE_URL      = https://engine.your-vps.com   (tanpa trailing slash)
//   ROUTE_ENGINE_SECRET   = <shared-secret>
// ==============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface DivisionIn {
  div_sls:    string
  n_sales:    number
  work_days:  number
  cycle:      'M1' | 'M2'
  philosophy: 'BLOCKING' | 'TRAFFIC'
}

interface RequestBody {
  area_id:    string
  kd_dist:    string
  depo_lat:   number
  depo_lon:   number
  divisions:  DivisionIn[]
  plan_name?: string        // opsional — auto-generate jika tidak diisi
}

// ── CORS ──────────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

function fail(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

// ── Handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    // ── Auth ─────────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) return fail('Unauthorized', 401)
    const jwt = authHeader.slice(7)

    const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!
    const SERVICE_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const ANON_KEY        = Deno.env.get('SUPABASE_ANON_KEY')!
    const ENGINE_URL      = Deno.env.get('ROUTE_ENGINE_URL')
    const ENGINE_SECRET   = Deno.env.get('ROUTE_ENGINE_SECRET') ?? ''

    if (!ENGINE_URL) return fail('ROUTE_ENGINE_URL not configured', 500)

    // Verify user JWT
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    })
    const { data: { user }, error: authErr } = await userClient.auth.getUser()
    if (authErr || !user) return fail('Unauthorized', 401)

    // Service client — bypass RLS, akses semua schema
    const db = createClient(SUPABASE_URL, SERVICE_KEY)

    // ── Parse body ────────────────────────────────────────────────────────
    const body: RequestBody = await req.json()
    const { area_id, kd_dist, depo_lat, depo_lon, divisions } = body

    if (!area_id)           return fail('area_id required')
    if (!divisions?.length) return fail('divisions required (min 1)')
    if (!kd_dist)           return fail('kd_dist required')

    // ── Load stores ───────────────────────────────────────────────────────
    const { data: stores, error: storesErr } = await db
      .rpc('get_stores_by_area', { p_area_id: area_id })

    if (storesErr)    return fail(`load stores: ${storesErr.message}`, 500)
    if (!stores?.length) return fail('Belum ada toko aktif untuk area ini', 400)

    // ── Plan ID + name ─────────────────────────────────────────────────────
    const planId = crypto.randomUUID()

    let planName = body.plan_name
    if (!planName) {
      const { data: ver } = await db.rpc('next_plan_version', { p_area_id: area_id })
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      planName = `${kd_dist}_${today}_V${ver ?? 1}`
    }

    // ── Call Python engine ─────────────────────────────────────────────────
    // Timeout 90s: engine bisa lebih lama untuk area dengan banyak toko
    let engineResp: Response
    try {
      engineResp = await fetch(`${ENGINE_URL}/generate-plan`, {
        method:  'POST',
        headers: {
          'Content-Type':          'application/json',
          'X-Engine-Secret':       ENGINE_SECRET,
          'Bypass-Tunnel-Reminder': 'true',   // localtunnel bypass
        },
        body: JSON.stringify({
          plan_id:   planId,
          depo_lat,
          depo_lon,
          kd_dist,
          stores,     // array dari get_stores_by_area
          divisions,  // array dari frontend
        }),
        signal: AbortSignal.timeout(90_000),
      })
    } catch (e) {
      return fail(`Engine unreachable: ${e}`, 502)
    }

    if (!engineResp.ok) {
      const text = await engineResp.text()
      return fail(`Engine ${engineResp.status}: ${text}`, 502)
    }

    const engineResult = await engineResp.json() as {
      plan_id: string
      results: Record<string, {
        version_id:  string
        assignments: unknown[]
        summary:     unknown
      }>
    }

    // ── Build save_plan args ──────────────────────────────────────────────
    const versionIds: Record<string, string>  = {}
    const summaryMap: Record<string, unknown> = {}
    const allAssignments: unknown[]           = []

    for (const [divSls, result] of Object.entries(engineResult.results)) {
      versionIds[divSls] = result.version_id
      summaryMap[divSls] = result.summary
      allAssignments.push(...result.assignments)
    }

    const divisionsMeta = divisions.map(d => ({
      ...d,
      store_count: (stores as Record<string, unknown>[])
        .filter(s => s['div_sls'] === d.div_sls).length,
    }))

    // ── Atomic save ───────────────────────────────────────────────────────
    const { error: saveErr } = await db.rpc('save_plan', {
      p_plan_id:     planId,
      p_area_id:     area_id,
      p_plan_name:   planName,
      p_divisions:   divisionsMeta,
      p_version_ids: versionIds,
      p_summary:     summaryMap,
      p_created_by:  user.id,
      p_assignments: allAssignments,
    })

    if (saveErr) return fail(`save plan: ${saveErr.message}`, 500)

    console.log(`[generate-plan] plan saved: ${planName} (${planId}), ` +
                `${allAssignments.length} assignments`)

    return ok({ plan_id: planId, plan_name: planName })

  } catch (e) {
    console.error('[generate-plan] fatal:', e)
    return fail(String(e), 500)
  }
})

# ==============================================================================
# viz.py  —  Visualizer OFFLINE (HTML mandiri) untuk mengintip hasil engine.
# ==============================================================================
#
# Bukan bagian dari jalur logic. Tujuannya supaya manusia bisa "membayangkan"
# rekomendasi engine sebelum membangun UI penuh. Konsisten dengan ethos:
#   - Offline total: tidak ada map-tiles, CDN, atau network. Toko diproyeksikan
#     dari lat/lon ke kanvas (deterministik).
#   - Hanya membaca hasil Plan; tidak mengubah logic apa pun.
#
# Pakai:
#   from route_engine.viz import render_plans_html
#   render_plans_html({"BLOCKING": plan_b, "TRAFFIC": plan_t}, "demo_plan.html")
# ==============================================================================
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict


def plan_to_payload(plan) -> dict:
    """Serialisasi Plan → dict ringan untuk visualizer (read-only)."""
    cfg = plan.config
    stores = {
        code: [s.latitude, s.longitude]
        for code, s in plan._store_index.items()
    }
    assignments = [
        {
            "code": a.customer_code,
            "sales": a.sales_person_name,
            "day": a.day_index,
            "order": a.visit_order,
            "ganjil": a.visit_ganjil,
            "genap": a.visit_genap,
            "qc": a.qc_flag,
        }
        for a in plan.assignments
    ]
    return {
        "philosophy": cfg.philosophy.value,
        "cycle": cfg.cycle.value,
        "n_sales": cfg.n_sales,
        "work_days": cfg.work_days,
        "depo": [cfg.depo_lat, cfg.depo_lon],
        "version_id": plan.version_id,
        "stores": stores,
        "assignments": assignments,
        "summary": plan.summary,
    }


def render_plans_html(plans: Dict[str, object], out_path: str) -> str:
    """Tulis satu file HTML mandiri berisi beberapa plan (mis. BLOCKING/TRAFFIC).

    `plans`: {label -> Plan}. Return path absolut file yang ditulis.
    """
    payload = {label: plan_to_payload(p) for label, p in plans.items()}
    html = _TEMPLATE.replace("__PAYLOAD__", json.dumps(payload))
    out = Path(out_path).resolve()
    out.write_text(html, encoding="utf-8")
    return str(out)


_TEMPLATE = r"""<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8"/>
<title>JKS Route Engine v2 — Preview</title>
<style>
  :root { --bg:#0f1419; --panel:#1a2029; --line:#2a3340; --text:#dfe6ee; --muted:#8a97a6; }
  * { box-sizing:border-box; }
  body { margin:0; font:13px/1.45 system-ui,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); }
  header { padding:10px 16px; border-bottom:1px solid var(--line); display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  .wrap { display:flex; height:calc(100vh - 52px); }
  .stage { flex:1; position:relative; }
  canvas { display:block; width:100%; height:100%; }
  .side { width:340px; border-left:1px solid var(--line); overflow:auto; padding:12px 14px; background:var(--panel); }
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:7px; overflow:hidden; }
  .seg button { background:transparent; color:var(--muted); border:0; padding:5px 11px; cursor:pointer; font:inherit; }
  .seg button.on { background:#2b6cb0; color:#fff; }
  label.chk { color:var(--muted); cursor:pointer; user-select:none; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:16px 0 6px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:3px 6px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .legend { display:flex; flex-direction:column; gap:3px; }
  .lg { display:flex; align-items:center; gap:7px; padding:3px 5px; border-radius:5px; cursor:pointer; }
  .lg:hover { background:#222b36; }
  .lg.dim { opacity:.35; }
  .sw { width:12px; height:12px; border-radius:3px; flex:0 0 auto; }
  .pill { font-size:11px; color:var(--muted); }
  .qc { color:#f6ad55; }
  #tip { position:absolute; pointer-events:none; background:#000d; border:1px solid var(--line); padding:6px 8px; border-radius:6px; font-size:12px; display:none; max-width:240px; }
  .imb { display:flex; gap:14px; }
  .imb div { background:#222b36; padding:6px 10px; border-radius:6px; }
  .imb b { display:block; font-size:16px; }
  .muted { color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>JKS Route Engine v2 · preview</h1>
  <span class="seg" id="philSeg"></span>
  <span class="seg" id="modeSeg">
    <button data-m="sales" class="on">Sales</button>
    <button data-m="day">Hari</button>
    <button data-m="week">Pekan (M2)</button>
    <button data-m="qc">QC</button>
  </span>
  <label class="chk"><input type="checkbox" id="routesChk"/> rute per hari (pilih sales)</label>
  <span class="pill" id="verPill"></span>
</header>
<div class="wrap">
  <div class="stage">
    <canvas id="cv"></canvas>
    <div id="tip"></div>
  </div>
  <div class="side" id="side"></div>
</div>
<script>
const DATA = __PAYLOAD__;
let phil = Object.keys(DATA)[0];
let mode = "sales";
let selectedSales = null;
let showRoutes = false;

const cv = document.getElementById("cv"), ctx = cv.getContext("2d");
const tip = document.getElementById("tip");
let pts = [], proj = null;

function palette(n){ const a=[]; for(let i=0;i<n;i++){ a.push(`hsl(${Math.round(360*i/n)} 70% 55%)`);} return a; }

function curPlan(){ return DATA[phil]; }

function salesList(){
  const s=new Set(); curPlan().assignments.forEach(a=>s.add(a.sales)); return [...s].sort();
}
function dayList(){ const n=curPlan().work_days; return Array.from({length:n},(_,i)=>i+1); }

function colorOf(a, sIdx, dCols){
  if(mode==="sales") return sIdx[a.sales];
  if(mode==="day") return dCols[a.day-1];
  if(mode==="week"){
    if(a.ganjil&&a.genap) return "#a0aec0";      // WEEKLY (dua pekan)
    return a.ganjil ? "#48bb78" : "#ed64a6";      // ganjil hijau / genap merah-muda
  }
  if(mode==="qc") return a.qc ? "#f6ad55" : "#3a4654";
  return "#888";
}

function computeProj(){
  const p=curPlan(); const lats=[p.depo[0]], lons=[p.depo[1]];
  for(const c in p.stores){ lats.push(p.stores[c][0]); lons.push(p.stores[c][1]); }
  const minLa=Math.min(...lats),maxLa=Math.max(...lats),minLo=Math.min(...lons),maxLo=Math.max(...lons);
  const W=cv.width,H=cv.height,m=40;
  const sLa=(H-2*m)/Math.max(1e-9,(maxLa-minLa)), sLo=(W-2*m)/Math.max(1e-9,(maxLo-minLo));
  const s=Math.min(sLa,sLo);
  const cx=(minLo+maxLo)/2, cy=(minLa+maxLa)/2;
  return (la,lo)=>[ W/2+(lo-cx)*s, H/2-(la-cy)*s ];   // lat ke atas
}

function draw(){
  const p=curPlan(); cv.width=cv.clientWidth*devicePixelRatio; cv.height=cv.clientHeight*devicePixelRatio;
  ctx.setTransform(1,0,0,1,0,0); proj=computeProj();
  ctx.clearRect(0,0,cv.width,cv.height);
  const sl=salesList(); const sIdxColor={}; const pal=palette(sl.length); sl.forEach((s,i)=>sIdxColor[s]=pal[i]);
  const dCols=palette(p.work_days);

  // routes (per sales terpilih, per hari)
  if(showRoutes && selectedSales){
    const byDay={};
    p.assignments.filter(a=>a.sales===selectedSales).forEach(a=>{(byDay[a.day]=byDay[a.day]||[]).push(a);});
    for(const d in byDay){
      const seq=byDay[d].slice().sort((x,y)=>x.order-y.order);
      ctx.beginPath(); ctx.strokeStyle=dCols[d-1]+"99"; ctx.lineWidth=1.2*devicePixelRatio;
      const dp=proj(p.depo[0],p.depo[1]); ctx.moveTo(dp[0],dp[1]);
      seq.forEach(a=>{const c=p.stores[a.code]; const xy=proj(c[0],c[1]); ctx.lineTo(xy[0],xy[1]);});
      ctx.stroke();
    }
  }

  // titik toko
  pts=[];
  for(const a of p.assignments){
    const c=p.stores[a.code]; const xy=proj(c[0],c[1]);
    const dim = selectedSales && a.sales!==selectedSales;
    const r=(dim?2.5:4.0)*devicePixelRatio;
    ctx.beginPath(); ctx.fillStyle=colorOf(a,sIdxColor,dCols);
    ctx.globalAlpha = dim?0.25:1; ctx.arc(xy[0],xy[1],r,0,7); ctx.fill();
    if(a.qc && mode!=="qc"){ ctx.globalAlpha=0.9; ctx.strokeStyle="#f6ad55"; ctx.lineWidth=1.5*devicePixelRatio; ctx.stroke(); }
    ctx.globalAlpha=1;
    pts.push({x:xy[0],y:xy[1],a});
  }
  // depo
  const dp=proj(p.depo[0],p.depo[1]);
  ctx.fillStyle="#fff"; ctx.beginPath(); ctx.arc(dp[0],dp[1],6*devicePixelRatio,0,7); ctx.fill();
  ctx.fillStyle="#000"; ctx.font=`${10*devicePixelRatio}px sans-serif`; ctx.textAlign="center"; ctx.fillText("D",dp[0],dp[1]+3.5*devicePixelRatio);

  renderSide(sIdxColor);
}

function renderSide(sIdxColor){
  const p=curPlan(), s=p.summary; const side=document.getElementById("side");
  document.getElementById("verPill").textContent = `${phil} · ${p.cycle} · ${p.n_sales} sales × ${p.work_days} hari · ${p.version_id}`;
  let h="";
  h+=`<div class="imb"><div><span class="muted">Δ count</span><b>${s.imbalance.count_spread_pct}%</b></div>`+
     `<div><span class="muted">Δ est-length</span><b>${s.imbalance.est_length_spread_pct}%</b></div></div>`;
  h+=`<h2>Per sales (klik = sorot)</h2><div class="legend">`;
  for(const row of s.per_sales){
    const dim = selectedSales && row.sales!==selectedSales;
    h+=`<div class="lg ${dim?'dim':''}" data-sales="${row.sales}"><span class="sw" style="background:${sIdxColor[row.sales]}"></span>`+
       `<span style="flex:1">${row.sales}</span><span class="pill">${row.count} · ${row.est_route_length.toFixed(0)}km</span></div>`;
  }
  h+=`</div>`;
  h+=`<h2>Per hari ${selectedSales?'· '+selectedSales:''}</h2><table><tr><th>Sales</th><th>Hari</th><th class="num">Toko</th><th class="num">Est km</th></tr>`;
  for(const row of s.per_day){
    if(selectedSales && row.sales!==selectedSales) continue;
    h+=`<tr><td>${row.sales.split('-').pop()}</td><td>${row.day}</td><td class="num">${row.count}</td><td class="num">${row.est_route_length.toFixed(0)}</td></tr>`;
  }
  h+=`</table>`;
  h+=`<h2>QC flags (${s.qc_flags.length})</h2>`;
  if(s.qc_flags.length===0) h+=`<div class="muted">tidak ada — data bersih</div>`;
  else { h+=`<div class="legend">`; for(const q of s.qc_flags.slice(0,40)){ h+=`<div class="qc">${q.customer_code}: <span class="muted">${q.reason}</span></div>`; } h+=`</div>`; }
  side.innerHTML=h;
  side.querySelectorAll(".lg").forEach(el=>el.onclick=()=>{ const v=el.dataset.sales; selectedSales = selectedSales===v?null:v; draw(); });
}

// interaksi
document.getElementById("modeSeg").onclick=e=>{ if(e.target.dataset.m){ mode=e.target.dataset.m;
  [...e.currentTarget.children].forEach(b=>b.classList.toggle("on",b===e.target)); draw(); } };
document.getElementById("routesChk").onchange=e=>{ showRoutes=e.target.checked; draw(); };
cv.onmousemove=e=>{ const r=cv.getBoundingClientRect(); const mx=(e.clientX-r.left)*devicePixelRatio, my=(e.clientY-r.top)*devicePixelRatio;
  let best=null,bd=1e9; for(const pt of pts){ const d=(pt.x-mx)**2+(pt.y-my)**2; if(d<bd){bd=d;best=pt;} }
  if(best && bd<160*devicePixelRatio){ const a=best.a; tip.style.display="block"; tip.style.left=(e.clientX-r.left+12)+"px"; tip.style.top=(e.clientY-r.top+12)+"px";
    tip.innerHTML=`<b>${a.code}</b><br>${a.sales}<br>Hari ${a.day} · urut ${a.order}<br>${a.ganjil&&a.genap?'WEEKLY (2 pekan)':(a.ganjil?'ganjil':'genap')}`+(a.qc?`<br><span class="qc">${a.qc}</span>`:''); }
  else tip.style.display="none"; };
cv.onmouseleave=()=>tip.style.display="none";

// segmen philosophy
const ps=document.getElementById("philSeg");
Object.keys(DATA).forEach((k,i)=>{ const b=document.createElement("button"); b.textContent=k; if(i===0)b.classList.add("on");
  b.onclick=()=>{ phil=k; selectedSales=null; [...ps.children].forEach(x=>x.classList.toggle("on",x===b)); draw(); }; ps.appendChild(b); });

addEventListener("resize",draw); draw();
</script>
</body>
</html>
"""

__all__ = ["render_plans_html", "plan_to_payload"]

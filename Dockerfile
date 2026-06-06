# syntax=docker/dockerfile:1
# ==============================================================================
# Dockerfile (ROOT) — bundle 1-container: frontend Vite + engine FastAPI.
#
# FastAPI (api.py) menyajikan hasil build Vite dari ./dist pada origin yang SAMA,
# sehingga TIDAK perlu CORS dan TIDAK ada mixed-content. Satu URL untuk semuanya.
#
# Build (context = ROOT; VITE_* di-inline ke bundle saat build — BUKAN rahasia,
# anon key memang dikirim ke setiap browser):
#   docker build \
#     --build-arg VITE_SUPABASE_URL="https://<ref>.supabase.co" \
#     --build-arg VITE_SUPABASE_ANON_KEY="<anon-key>" \
#     -t jks-app .
#
# Run (SERVICE key RAHASIA → hanya runtime -e, tak masuk layer image):
#   docker run -p 8000:8000 \
#     -e SUPABASE_URL="https://<ref>.supabase.co" \
#     -e SUPABASE_SERVICE_KEY="<service-role-key>" \
#     jks-app
#   → buka http://localhost:8000
#
# Catatan: route_engine/Dockerfile tetap ada untuk varian engine-only (tanpa FE).
# ==============================================================================

# ── Stage 1: build frontend (Node) ────────────────────────────────────────────
FROM node:20-slim AS frontend
WORKDIR /fe

# Layer cache: install deps dulu (berubah jarang) — butuh package-lock.json (npm ci).
COPY package.json package-lock.json ./
RUN npm ci

# Source + config build (node_modules/referensi/.env disaring oleh .dockerignore).
COPY . .

# Vite meng-inline VITE_* saat build → WAJIB tersedia sebagai env DI SINI.
# VITE_ENGINE_URL dikosongkan → frontend memanggil engine same-origin (1-container).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_ENGINE_URL=
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_ENGINE_URL=$VITE_ENGINE_URL
RUN npm run build      # → /fe/dist

# ── Stage 2: runtime (Python) ─────────────────────────────────────────────────
FROM python:3.11-slim
WORKDIR /app

# Dependency engine + API (di-pin == untuk determinisme; lihat fail-loud preflight).
COPY route_engine/requirements.txt      ./engine-requirements.txt
COPY route_engine/requirements-api.txt  ./api-requirements.txt
RUN pip install --no-cache-dir \
    -r engine-requirements.txt \
    -r api-requirements.txt

# Engine source + root API entry-point.
# PENTING: api.py harus di root /app — route_engine/api.py hanya re-export.
COPY route_engine/ ./route_engine/
COPY api.py .

# Hasil build frontend → ./dist (dilayani oleh api.py bila ada).
COPY --from=frontend /fe/dist ./dist

# Non-root user.
RUN useradd -m appuser
USER appuser

EXPOSE 8000

# Worker stateless (RouteEngine tak simpan state) → aman multi-worker.
# Jalankan api:app (root api.py), bukan route_engine.api:app.
# PORT di-inject host (Render/Railway) → bind $PORT; fallback 8000 (lokal/Fly).
# WEB_CONCURRENCY: jumlah worker. Free tier 512MB → set 1 (numpy/sklearn berat).
# 'exec' agar uvicorn jadi PID 1 → terima SIGTERM untuk graceful shutdown.
CMD ["sh", "-c", "exec uvicorn api:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WEB_CONCURRENCY:-2}"]

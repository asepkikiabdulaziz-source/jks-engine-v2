FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY route_engine/requirements.txt      ./engine-requirements.txt
COPY route_engine/requirements-api.txt  ./api-requirements.txt
RUN pip install --no-cache-dir \
    -r engine-requirements.txt \
    -r api-requirements.txt

# Copy engine source + root API entry-point
# PENTING: api.py harus ada di root /app — route_engine/api.py hanya re-export darinya
COPY route_engine/ ./route_engine/
COPY api.py .

# Non-root user
RUN useradd -m appuser
USER appuser

EXPOSE 8000

# --workers 2: tiap worker stateless, RouteEngine tidak menyimpan state
# Jalankan api:app (root api.py), bukan route_engine.api:app
CMD ["uvicorn", "api:app", \
     "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]

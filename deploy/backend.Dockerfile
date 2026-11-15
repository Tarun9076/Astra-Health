# ASTRA HEALTH backend (FastAPI). One image for both nodes: Habitat (spacecraft) and Ground (Earth);
# docker-compose.yml chooses the role with environment variables. Build context: the repo root.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

# The backend reads protocols/ and knowledge/ from the repo root, and the demo data loader lives in simulator/
COPY services/backend/pyproject.toml services/backend/
COPY services/backend/astra services/backend/astra
COPY services/backend/seed.example.json services/backend/
COPY protocols protocols
COPY knowledge knowledge
COPY simulator simulator
# editable install: the package stays under /app, so it finds /app/protocols and /app/knowledge
RUN pip install -e services/backend

COPY deploy/backend-entrypoint.sh /usr/local/bin/astra-entrypoint
RUN chmod +x /usr/local/bin/astra-entrypoint && useradd --create-home astra && mkdir -p /data && chown astra /data
USER astra
WORKDIR /app/services/backend
VOLUME ["/data"]
ENTRYPOINT ["astra-entrypoint"]

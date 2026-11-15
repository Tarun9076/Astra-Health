#!/bin/sh
# First start: create the database (mission, crew, demo accounts). Habitat only: then load the simulated
# mission history once, through the normal API, so it is assessed and synced to Ground like live data.
set -e
DB_FILE="${ASTRA_DB_FILE:?set ASTRA_DB_FILE, e.g. /data/habitat.db}"
PORT="${PORT:-8000}"

if [ ! -f "$DB_FILE" ]; then
  echo "Creating $DB_FILE (today = mission day ${ASTRA_MISSION_DAY:-121})"
  python -m astra.seed --mission-day-today "${ASTRA_MISSION_DAY:-121}"
fi

if [ "${ASTRA_NODE_ROLE:-Habitat}" = "Habitat" ] && [ ! -f /data/.mission-loaded ]; then
  (
    until python -c "import httpx; httpx.get('http://127.0.0.1:${PORT}/health').raise_for_status()" 2>/dev/null; do
      sleep 2
    done
    echo "Loading the simulated mission data (about 6,600 readings)..."
    python /app/simulator/simulate.py seed --api "http://127.0.0.1:${PORT}" && touch /data/.mission-loaded
  ) &
fi

exec uvicorn astra.main:app --host 0.0.0.0 --port "$PORT" --proxy-headers --forwarded-allow-ips='*'

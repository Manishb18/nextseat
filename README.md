# Watch Party

A 2-person browser app for watching local movie files together via WebRTC. The movie streams peer-to-peer — it never touches the server.

## Quick Start (Development)

### Prerequisites

- Python 3.11+
- Node.js 18+ and pnpm
- Copy `.env.example` to `.env` and fill in TURN credentials if needed

### Backend

```bash
cd backend
python -m venv venv
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
pnpm install
pnpm dev
```

The frontend dev server runs on `http://localhost:5173` and proxies `/api/*` and `/ws/*` to the backend on port 8000.

## Testing

### Health Check

```bash
curl http://localhost:8000/api/health
# → {"status":"ok"}
```

### Two-Tab Test

1. Open `http://localhost:5173` in two browser tabs.
2. Create a room in one tab, join with the code in the other.

## Deployment

See Phase 5 — Docker Compose with Caddy for automatic HTTPS.

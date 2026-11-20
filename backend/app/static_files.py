"""Serve the built frontend when the backend runs in production."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger("nextseat")


def mount_frontend(app: FastAPI) -> None:
    """Mount built assets and a final SPA fallback when a frontend build exists."""
    dist = Path(__file__).parent.parent.parent / "frontend" / "dist"
    if not dist.exists():
        dist = Path("/app/frontend/dist")

    if not dist.exists():
        logger.info("No frontend/dist found — running in API-only mode (use Vite in development)")
        return

    index = dist / "index.html"
    app.mount("/assets", StaticFiles(directory=str(dist / "assets")), name="assets")

    @app.get("/favicon.svg")
    async def favicon() -> FileResponse:
        return FileResponse(str(dist / "favicon.svg"))

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str) -> FileResponse:  # noqa: ARG001
        return FileResponse(str(index))

    logger.info("Serving frontend from %s", dist)

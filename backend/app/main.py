"""FastAPI application assembly and production frontend mounting."""

from fastapi import FastAPI

from .api import health, ice, ip_report, rooms, signaling
from .static_files import mount_frontend


def create_app() -> FastAPI:
    app = FastAPI(title="Nextseat", version="0.1.0")
    app.include_router(health.router)
    app.include_router(rooms.router)
    app.include_router(ice.router)
    app.include_router(ip_report.router)
    app.include_router(signaling.router)
    mount_frontend(app)
    return app


app = create_app()

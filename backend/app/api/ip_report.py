
"""Visitor IP email reporting endpoint."""

from __future__ import annotations

import ipaddress
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..config import settings
from ..services.client_ip import resolve_client_ip
from ..services.email import EmailDeliveryError, send_local_ip_report

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/api/ip-report")
def email_ip_report(request: Request):
    import json

    diagnostics = {
        "client_host": request.client.host if request.client else None,
        "forwarded_for": request.headers.get("x-forwarded-for"),
        "real_ip": request.headers.get("x-real-ip"),
        "resolved_ip": resolve_client_ip(
            request.client.host if request.client else None,
            request.headers.get("x-forwarded-for"),
        ),
    }

    print(
        "IP REPORT DIAGNOSTICS:",
        json.dumps(diagnostics),
        flush=True,
    )

    return diagnostics
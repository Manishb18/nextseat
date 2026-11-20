
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
def email_ip_report(request: Request) -> dict:
    """Email the public IP address of a website visitor."""

    # Temporary diagnostic logs
    logger.info(
        "Socket peer: %s",
        request.client.host if request.client else None,
    )
    logger.info(
        "X-Forwarded-For: %s",
        request.headers.get("x-forwarded-for"),
    )
    logger.info(
        "X-Real-IP: %s",
        request.headers.get("x-real-ip"),
    )

    ip = resolve_client_ip(
        request.client.host if request.client else None,
        request.headers.get("x-forwarded-for"),
    )

    try:
        parsed_ip = ipaddress.ip_address(ip)

        if not parsed_ip.is_global:
            return JSONResponse(
                {"error": "public_ip_unavailable"},
                status_code=400,
            )

        ip = str(parsed_ip)

    except ValueError:
        return JSONResponse(
            {"error": "ip_unavailable"},
            status_code=400,
        )

    # Verify email configuration
    if not all((
        settings.smtp_host,
        settings.smtp_from,
        settings.smtp_to,
    )):
        return JSONResponse(
            {"error": "email_not_configured"},
            status_code=503,
        )

    # Send email using your existing SMTP service
    try:
        send_local_ip_report(ip)

    except EmailDeliveryError:
        logger.exception("Failed to send visitor IP report")

        return JSONResponse(
            {"error": "email_send_failed"},
            status_code=502,
        )

    return {"status": "sent"}

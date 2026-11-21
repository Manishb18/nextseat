
"""Visitor IP email reporting endpoint."""

from __future__ import annotations

import ipaddress
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..services.client_ip import resolve_client_ip
from ..services.email import EmailDeliveryError, is_email_configured, send_local_ip_report

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/api/ip-report")
def email_ip_report(request: Request) -> dict:
    """Email complete visitor IP diagnostics."""

    client_host = request.client.host if request.client else None
    forwarded_for = request.headers.get("x-forwarded-for")
    real_ip = request.headers.get("x-real-ip")

    # Resolve candidate visitor IP
    resolved_ip = resolve_client_ip(client_host, forwarded_for)

    # Validate the resolved IP
    try:
        parsed_ip = ipaddress.ip_address(resolved_ip)

        if not parsed_ip.is_global:
            return JSONResponse(
                {"error": "public_ip_unavailable"},
                status_code=400,
            )

        resolved_ip = str(parsed_ip)

    except ValueError:
        return JSONResponse(
            {"error": "ip_unavailable"},
            status_code=400,
        )

    # Collect the entire forwarding chain
    report = (
        "Visitor IP Diagnostics\n"
        "========================\n\n"
        f"Socket Peer IP: {client_host or 'Unavailable'}\n"
        f"X-Forwarded-For: {forwarded_for or 'Unavailable'}\n"
        f"X-Real-IP: {real_ip or 'Unavailable'}\n"
        f"Resolved Public IP: {resolved_ip}\n"
    )

    logger.info("Visitor IP diagnostics:\n%s", report)

    # Check Gmail API credentials and message address configuration.
    if not is_email_configured():
        return JSONResponse(
            {"error": "email_not_configured"},
            status_code=503,
        )

    # Send using existing email service
    try:
        send_local_ip_report(report)

    except EmailDeliveryError:
        logger.exception("Failed to send visitor IP report")

        return JSONResponse(
            {"error": "email_send_failed"},
            status_code=502,
        )

    return {"status": "sent"}

"""Email delivery for the IP diagnostic through the Gmail API."""

from __future__ import annotations

import base64
import json
import logging
import os
from email.message import EmailMessage
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..config import settings

logger = logging.getLogger("nextseat")


class EmailDeliveryError(Exception):
    """Raised when the email provider cannot deliver a message."""


def is_email_configured() -> bool:
    """Return whether the Gmail API credentials and message addresses exist."""
    return all(
        os.getenv(key, "").strip()
        for key in (
            "GMAIL_CLIENT_ID",
            "GMAIL_CLIENT_SECRET",
            "GMAIL_REFRESH_TOKEN",
        )
    ) and bool(settings.smtp_from.strip() and settings.smtp_to.strip())


def send_local_ip_report(report: str) -> None:
    """Send the IP diagnostic report using Gmail's HTTPS API."""
    if not is_email_configured():
        raise EmailDeliveryError("Gmail API credentials or email addresses are not configured")

    try:
        access_token = _get_access_token()

        message = EmailMessage()
        message["To"] = settings.smtp_to
        message["From"] = settings.smtp_from
        message["Subject"] = "Nextseat IP diagnostic report"
        message.set_content(report)
        raw_message = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")

        request = Request(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            data=json.dumps({"raw": raw_message}).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urlopen(request, timeout=20) as response:
            if not 200 <= response.status < 300:
                raise EmailDeliveryError(f"Gmail API returned HTTP {response.status}")
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
        logger.exception("Failed to send IP diagnostic email through Gmail API")
        raise EmailDeliveryError("Gmail API email delivery failed") from exc


def _get_access_token() -> str:
    """Exchange the stored refresh token for a short-lived OAuth access token."""
    form_data = urlencode(
        {
            "client_id": os.environ["GMAIL_CLIENT_ID"].strip(),
            "client_secret": os.environ["GMAIL_CLIENT_SECRET"].strip(),
            "refresh_token": os.environ["GMAIL_REFRESH_TOKEN"].strip(),
            "grant_type": "refresh_token",
        }
    ).encode("ascii")
    request = Request(
        "https://oauth2.googleapis.com/token",
        data=form_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urlopen(request, timeout=20) as response:
        token_response = json.loads(response.read().decode("utf-8"))

    access_token = token_response.get("access_token")
    if not access_token:
        raise ValueError("Google OAuth response did not include an access token")
    return access_token

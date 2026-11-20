"""SMTP delivery for the local IP diagnostic."""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

from ..config import settings

logger = logging.getLogger("nextseat")


class EmailDeliveryError(Exception):
    """Raised when the configured SMTP server cannot deliver a message."""


def send_local_ip_report(ip: str) -> None:
    message = EmailMessage()
    message["Subject"] = "Nextseat local IP test"
    message["From"] = settings.smtp_from
    message["To"] = settings.smtp_to
    message.set_content(f"A local development page loaded.\n\nRequest IP: {ip}\n")

    try:
        if settings.smtp_use_ssl:
            with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
                _authenticate(smtp)
                smtp.send_message(message)
        else:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
                smtp.starttls()
                _authenticate(smtp)
                smtp.send_message(message)
    except (OSError, smtplib.SMTPException) as exc:
        logger.exception("Failed to send local IP report")
        raise EmailDeliveryError from exc


def _authenticate(smtp: smtplib.SMTP | smtplib.SMTP_SSL) -> None:
    if settings.smtp_username:
        smtp.login(settings.smtp_username, settings.smtp_password)

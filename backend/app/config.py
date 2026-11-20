"""Configuration loaded from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    # STUN/TURN servers (comma-separated URLs)
    stun_urls: list[str] = field(default_factory=lambda: _csv("STUN_URLS", "stun:stun.l.google.com:19302"))
    turn_urls: list[str] = field(default_factory=lambda: _csv("TURN_URLS", ""))
    turn_username: str = field(default_factory=lambda: os.getenv("TURN_USERNAME", ""))
    turn_credential: str = field(default_factory=lambda: os.getenv("TURN_CREDENTIAL", ""))

    # Force TURN relay for testing
    force_relay: bool = field(default_factory=lambda: os.getenv("FORCE_RELAY", "").lower() == "true")

    # Rate limiting
    room_create_limit: int = field(default_factory=lambda: int(os.getenv("ROOM_CREATE_LIMIT", "10")))  # per IP per minute
    room_join_limit: int = field(default_factory=lambda: int(os.getenv("ROOM_JOIN_LIMIT", "20")))  # per IP per minute

    # Only honor forwarded client IPs from private-network reverse proxies.
    trusted_proxy_networks: list[str] = field(default_factory=lambda: _csv(
        "TRUSTED_PROXY_NETWORKS", "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,::1/128,fc00::/7"
    ))

    # Email settings for the local-only IP diagnostic.
    smtp_host: str = field(default_factory=lambda: os.getenv("SMTP_HOST", ""))
    smtp_port: int = field(default_factory=lambda: int(os.getenv("SMTP_PORT", "587")))
    smtp_username: str = field(default_factory=lambda: os.getenv("SMTP_USERNAME", ""))
    smtp_password: str = field(default_factory=lambda: os.getenv("SMTP_PASSWORD", ""))
    smtp_from: str = field(default_factory=lambda: os.getenv("SMTP_FROM", ""))
    smtp_to: str = field(default_factory=lambda: os.getenv("SMTP_TO", ""))
    smtp_use_ssl: bool = field(default_factory=lambda: os.getenv("SMTP_USE_SSL", "false").lower() == "true")
    ip_report_auto_local: bool = field(default_factory=lambda: os.getenv("IP_REPORT_AUTO_LOCAL", "false").lower() == "true")

    # Room cleanup
    room_empty_timeout: int = 60  # seconds


def _csv(key: str, default: str) -> list[str]:
    """Parse a comma-separated env var into a list, filtering empty strings."""
    raw = os.getenv(key, default)
    return [s.strip() for s in raw.split(",") if s.strip()]


settings = Settings()

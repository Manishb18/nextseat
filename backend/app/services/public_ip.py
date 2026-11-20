"""Lookup the public egress IP for local development diagnostics."""

from __future__ import annotations

import ipaddress
from urllib.request import Request, urlopen


class PublicIPLookupError(Exception):
    """Raised when the public IP lookup service cannot return a valid address."""


def get_public_ip() -> str:
    request = Request(
        "https://api.ipify.org",
        headers={"User-Agent": "Nextseat-local-diagnostic/1.0"},
    )
    try:
        with urlopen(request, timeout=5) as response:
            value = response.read(64).decode("ascii").strip()
        address = ipaddress.ip_address(value)
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise PublicIPLookupError from exc

    if not address.is_global:
        raise PublicIPLookupError("Lookup service returned a non-global address")
    return str(address)

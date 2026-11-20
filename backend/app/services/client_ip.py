
"""Client IP resolution."""

from __future__ import annotations

import ipaddress


def resolve_client_ip(
    host: str | None,
    forwarded: str | None,
) -> str:
    """Resolve a candidate public visitor IP from forwarded headers."""

    if forwarded:
        for value in forwarded.split(","):
            candidate = value.strip()

            try:
                parsed_ip = ipaddress.ip_address(candidate)

                if parsed_ip.is_global:
                    return str(parsed_ip)

            except ValueError:
                continue

    return host or "unknown"

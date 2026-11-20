"""Client IP resolution that only trusts forwarding headers from known proxies."""

from __future__ import annotations

import ipaddress

from ..config import settings


def resolve_client_ip(host: str | None, forwarded: str | None) -> str:
    """Return the socket peer, or a validated forwarded IP from a trusted proxy."""
    if not host:
        return "unknown"

    try:
        peer = ipaddress.ip_address(host)
        trusted_proxy = any(
            peer in ipaddress.ip_network(network)
            for network in settings.trusted_proxy_networks
        )
    except ValueError:
        trusted_proxy = False

    if trusted_proxy and forwarded:
        # Proxies append the observed client address; ignore spoofed leftmost entries.
        candidate = forwarded.split(",")[-1].strip()
        try:
            return str(ipaddress.ip_address(candidate))
        except ValueError:
            pass

    return host

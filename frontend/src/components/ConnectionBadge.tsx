/**
 * ConnectionBadge — polls RTCPeerConnection.getStats() every 2 seconds
 * to display connection type (direct/relay), current bitrate, and RTT.
 */

import { useEffect, useState } from 'react';

interface ConnectionBadgeProps {
  pc: RTCPeerConnection | null;
}

interface ConnectionStats {
  type: 'connecting' | 'direct' | 'relay';
  bitrateMbps: number | null;    // send bitrate in Mbps
  rttMs: number | null;          // round-trip time in milliseconds
}

// Track previous bytesSent for delta-based bitrate calculation
let prevBytesSent = 0;
let prevTimestamp = 0;

export default function ConnectionBadge({ pc }: ConnectionBadgeProps) {
  const [stats, setStats] = useState<ConnectionStats>({ type: 'connecting', bitrateMbps: null, rttMs: null });

  useEffect(() => {
    if (!pc) return;
    prevBytesSent = 0;
    prevTimestamp = 0;

    const interval = window.setInterval(async () => {
      try {
        const report = await pc.getStats();
        let type: ConnectionStats['type'] = 'connecting';
        let bitrateMbps: number | null = null;
        let rttMs: number | null = null;

        report.forEach((s) => {
          // Find the active candidate pair
          if (s.type === 'candidate-pair' && s.state === 'succeeded') {
            const pair = s as RTCIceCandidatePairStats;
            if (pair.currentRoundTripTime !== undefined) {
              rttMs = Math.round(pair.currentRoundTripTime * 1000);
            }
          }

          // Find selected local candidate to determine relay vs direct
          if (s.type === 'local-candidate') {
            const cand = s as RTCStats & { candidateType?: string };
            if (cand.candidateType === 'relay') type = 'relay';
            else if (type !== 'relay') type = 'direct';
          }

          // Outbound RTP for bitrate calculation
          if (s.type === 'outbound-rtp' && (s as RTCOutboundRtpStreamStats).kind === 'video') {
            const rtp = s as RTCOutboundRtpStreamStats;
            const now = rtp.timestamp;
            const bytes = rtp.bytesSent ?? 0;
            if (prevTimestamp && prevBytesSent) {
              const dt = (now - prevTimestamp) / 1000; // seconds
              const db = bytes - prevBytesSent;         // bytes
              if (dt > 0) bitrateMbps = Math.round((db * 8) / dt / 1_000_000 * 10) / 10;
            }
            prevBytesSent = bytes;
            prevTimestamp = now;
          }
        });

        // If pc is connected but no active candidate found yet, show 'direct'
        if (pc.connectionState === 'connected' && type === 'connecting') {
          type = 'direct';
        }

        setStats({ type, bitrateMbps, rttMs });
      } catch {
        // Ignore stats errors
      }
    }, 2000);

    return () => window.clearInterval(interval);
  }, [pc]);

  const { type, bitrateMbps, rttMs } = stats;

  const badgeColor =
    type === 'direct' ? 'bg-green-900 text-green-300' :
    type === 'relay'  ? 'bg-blue-900 text-blue-300' :
    'bg-yellow-900 text-yellow-300';

  const icon = type === 'direct' ? '🟢' : type === 'relay' ? '🔵' : '⏳';
  const label = type === 'direct' ? 'Direct' : type === 'relay' ? 'Relay' : 'Connecting';

  return (
    <div className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${badgeColor}`}>
      <span>{icon} {label}</span>
      {bitrateMbps !== null && <span>· {bitrateMbps} Mbps</span>}
      {rttMs !== null && <span>· {rttMs}ms</span>}
    </div>
  );
}

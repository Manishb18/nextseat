/**
 * ConnectionBadge — polls RTCPeerConnection.getStats() every 2 seconds
 * to display connection type (direct/relay), current bitrate, and RTT.
 */

import { useEffect, useRef, useState } from 'react';

interface ConnectionBadgeProps {
  pc: RTCPeerConnection | null;
}

interface ConnectionStats {
  type: 'connecting' | 'direct' | 'relay' | 'failed';
  bitrateMbps: number | null;    // send bitrate in Mbps
  rttMs: number | null;          // round-trip time in milliseconds
}

export default function ConnectionBadge({ pc }: ConnectionBadgeProps) {
  const [stats, setStats] = useState<ConnectionStats>({ type: 'connecting', bitrateMbps: null, rttMs: null });
  const previousVideoStats = useRef<{ bytes: number; timestamp: number } | null>(null);

  useEffect(() => {
    previousVideoStats.current = null;
    if (!pc) return;

    const interval = window.setInterval(async () => {
      try {
        const report = await pc.getStats();
        let type: ConnectionStats['type'] = 'connecting';
        let bitrateMbps: number | null = null;
        let rttMs: number | null = null;
        let selectedPair: RTCIceCandidatePairStats | undefined;
        let videoBytes = 0;
        let videoTimestamp = 0;

        report.forEach((s) => {
          if (s.type === 'candidate-pair' && s.state === 'succeeded') {
            const pair = s as RTCIceCandidatePairStats & { selected?: boolean };
            if (pair.selected || pair.nominated) selectedPair = pair;
          }

          if (s.type === 'outbound-rtp' && (s as RTCOutboundRtpStreamStats).kind === 'video') {
            const rtp = s as RTCOutboundRtpStreamStats;
            videoBytes += rtp.bytesSent ?? 0;
            videoTimestamp = Math.max(videoTimestamp, rtp.timestamp);
          }
        });

        // Report the candidate actually in use, rather than any gathered
        // candidate (which could incorrectly label a relay path as direct).
        if (selectedPair) {
          const localCandidate = report.get(selectedPair.localCandidateId) as
            | (RTCStats & { candidateType?: string })
            | undefined;
          type = localCandidate?.candidateType === 'relay' ? 'relay' : 'direct';
          if (selectedPair.currentRoundTripTime !== undefined) {
            rttMs = Math.round(selectedPair.currentRoundTripTime * 1000);
          }
        }

        const previous = previousVideoStats.current;
        if (previous?.bytes && previous.timestamp && videoTimestamp > previous.timestamp && videoBytes >= previous.bytes) {
          const seconds = (videoTimestamp - previous.timestamp) / 1000;
          bitrateMbps = Math.round(((videoBytes - previous.bytes) * 8) / seconds / 1_000_000 * 10) / 10;
        }
        previousVideoStats.current = { bytes: videoBytes, timestamp: videoTimestamp };

        setStats({ type, bitrateMbps, rttMs });
      } catch {
        // Ignore stats errors
      }
    }, 2000);

    return () => window.clearInterval(interval);
  }, [pc]);

  const type: ConnectionStats['type'] = pc?.connectionState === 'failed'
    ? 'failed'
    : pc?.connectionState === 'connected'
      ? stats.type
      : 'connecting';
  const { bitrateMbps, rttMs } = pc
    ? stats
    : { bitrateMbps: null, rttMs: null };

  const badgeColor =
    type === 'direct' ? 'bg-green-900 text-green-300' :
    type === 'relay'  ? 'bg-blue-900 text-blue-300' :
    type === 'failed' ? 'bg-red-900 text-red-300' :
    'bg-yellow-900 text-yellow-300';

  const icon = type === 'direct' ? '🟢' : type === 'relay' ? '🔵' : '⏳';
  const label = type === 'direct' ? 'Direct' : type === 'relay' ? 'Relay' : type === 'failed' ? 'Failed' : 'Connecting';

  return (
    <div className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${badgeColor}`}>
      <span>{icon} {label}</span>
      {bitrateMbps !== null && <span>· {bitrateMbps} Mbps</span>}
      {rttMs !== null && <span>· {rttMs}ms</span>}
    </div>
  );
}

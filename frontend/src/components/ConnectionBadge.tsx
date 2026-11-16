import { useEffect, useRef, useState } from 'react';

interface ConnectionBadgeProps { pc: RTCPeerConnection | null }
type Path = 'connecting' | 'direct' | 'relay' | 'failed';
type Quality = 'connecting' | 'good' | 'fair' | 'weak' | 'failed';
interface ConnectionStats {
  path: Path;
  bitrateMbps: number | null;
  rttMs: number | null;
  packetLoss: number | null;
}
interface PreviousVideoStats { bytes: number; timestamp: number }

export default function ConnectionBadge({ pc }: ConnectionBadgeProps) {
  const [stats, setStats] = useState<ConnectionStats>({ path: 'connecting', bitrateMbps: null, rttMs: null, packetLoss: null });
  const previousVideoStats = useRef<PreviousVideoStats | null>(null);

  useEffect(() => {
    previousVideoStats.current = null;
    if (!pc) {
      setStats({ path: 'connecting', bitrateMbps: null, rttMs: null, packetLoss: null });
      return;
    }

    let active = true;
    async function readStats() {
      try {
        const report = await pc!.getStats();
        let path: Path = 'connecting';
        let rttMs: number | null = null;
        let selectedPair: (RTCIceCandidatePairStats & { selected?: boolean }) | undefined;
        let videoBytes = 0;
        let videoTimestamp = 0;
        let packetsReceived = 0;
        let packetsLost = 0;

        report.forEach((entry) => {
          if (entry.type === 'candidate-pair' && entry.state === 'succeeded') {
            const pair = entry as RTCIceCandidatePairStats & { selected?: boolean };
            if (pair.selected || pair.nominated) selectedPair = pair;
          }
          if (entry.type === 'outbound-rtp' && (entry as RTCOutboundRtpStreamStats).kind === 'video') {
            const video = entry as RTCOutboundRtpStreamStats;
            videoBytes += video.bytesSent ?? 0;
            videoTimestamp = Math.max(videoTimestamp, video.timestamp);
          }
          if (entry.type === 'inbound-rtp' && (entry as RTCInboundRtpStreamStats).kind === 'video') {
            const video = entry as RTCInboundRtpStreamStats;
            videoBytes += video.bytesReceived ?? 0;
            videoTimestamp = Math.max(videoTimestamp, video.timestamp);
            packetsReceived += video.packetsReceived ?? 0;
            packetsLost += Math.max(0, video.packetsLost ?? 0);
          }
        });

        if (selectedPair) {
          const candidate = report.get(selectedPair.localCandidateId) as (RTCStats & { candidateType?: string }) | undefined;
          path = candidate?.candidateType === 'relay' ? 'relay' : 'direct';
          if (selectedPair.currentRoundTripTime !== undefined) rttMs = Math.round(selectedPair.currentRoundTripTime * 1000);
        }

        let bitrateMbps: number | null = null;
        const previous = previousVideoStats.current;
        if (previous && videoTimestamp > previous.timestamp && videoBytes >= previous.bytes) {
          const seconds = (videoTimestamp - previous.timestamp) / 1000;
          if (seconds > 0) bitrateMbps = Math.round(((videoBytes - previous.bytes) * 8) / seconds / 1_000_000 * 10) / 10;
        }
        previousVideoStats.current = { bytes: videoBytes, timestamp: videoTimestamp };
        const packetLoss = packetsReceived + packetsLost > 0 ? Math.round((packetsLost / (packetsReceived + packetsLost)) * 100) : null;
        if (active) setStats({ path, bitrateMbps, rttMs, packetLoss });
      } catch {
        // Keep the most recent metrics when browser stats are temporarily unavailable.
      }
    }

    void readStats();
    const timer = window.setInterval(() => { void readStats(); }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [pc]);

  const failed = pc?.connectionState === 'failed';
  const connecting = !pc || pc.connectionState === 'new' || pc.connectionState === 'connecting' || pc.connectionState === 'disconnected';
  const quality: Quality = failed ? 'failed' : connecting || stats.path === 'connecting' ? 'connecting' :
    (stats.rttMs !== null && stats.rttMs > 250) || (stats.packetLoss !== null && stats.packetLoss > 5) || (stats.bitrateMbps !== null && stats.bitrateMbps < 0.4) ? 'weak' :
      (stats.rttMs !== null && stats.rttMs > 120) || (stats.packetLoss !== null && stats.packetLoss > 2) || (stats.bitrateMbps !== null && stats.bitrateMbps < 1.2) ? 'fair' : 'good';

  const presentation: Record<Quality, { label: string; dot: string }> = {
    connecting: { label: connecting ? 'Connecting' : 'Checking quality', dot: 'bg-amber-400' },
    good: { label: 'Good connection', dot: 'bg-emerald-400' },
    fair: { label: 'Fair connection', dot: 'bg-amber-400' },
    weak: { label: 'Weak connection', dot: 'bg-rose-400' },
    failed: { label: 'Connection lost', dot: 'bg-rose-400' },
  };
  const current = presentation[quality];
  const tips = quality === 'failed'
    ? ['Try reconnecting to the room.', 'If it keeps failing, refresh both room tabs and rejoin.']
    : quality === 'weak'
      ? ['Ask the person sharing the movie to switch to 480p.', 'Pause other downloads or video calls on either network.', 'If you are on a VPN, try reconnecting without it.']
      : quality === 'fair'
        ? ['A relay connection can add a little delay.', 'Lowering the shared video quality can make playback smoother.']
        : quality === 'connecting'
          ? ['Keep both room tabs open while the connection is being established.', 'If this takes more than a few seconds, try Reconnect.']
          : ['Your peer connection looks healthy. Headphones help avoid audio echo.'];

  return (
    <details className="connection-popover">
      <summary className={`connection-pill connection-${quality}`} aria-label={`${current.label}. Open connection details`}>
        <span className={`connection-dot ${current.dot}`} />
        <span>{current.label}</span>
        <span className="connection-caret" aria-hidden="true">⌄</span>
      </summary>
      <div className="connection-panel">
        <div className="flex items-center justify-between gap-3"><p className="text-sm font-semibold text-white">Connection details</p><span className="text-[11px] text-slate-500">Live</span></div>
        <dl className="connection-metrics">
          <div><dt>Route</dt><dd>{stats.path === 'direct' ? 'Direct peer link' : stats.path === 'relay' ? 'Relay connection' : failed ? 'Disconnected' : 'Negotiating'}</dd></div>
          <div><dt>Round trip</dt><dd>{stats.rttMs === null ? '—' : `${stats.rttMs} ms`}</dd></div>
          <div><dt>Video traffic</dt><dd>{stats.bitrateMbps === null ? 'Waiting for video' : `${stats.bitrateMbps} Mbps`}</dd></div>
          <div><dt>Packet loss</dt><dd>{stats.packetLoss === null ? '—' : `${stats.packetLoss}%`}</dd></div>
        </dl>
        <div className="connection-tips"><p className="text-xs font-semibold text-slate-200">{quality === 'good' ? 'You’re all set' : 'Try this'}</p><ul>{tips.map((tip) => <li key={tip}>{tip}</li>)}</ul></div>
      </div>
    </details>
  );
}

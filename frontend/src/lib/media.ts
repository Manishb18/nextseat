/**
 * Local media helpers — getUserMedia with the correct audio constraints,
 * and helpers for adding/removing tracks from a peer connection.
 */

export interface LocalMedia {
  stream: MediaStream;
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
}

/** Audio constraints from the PRD: echo cancellation, noise suppression, AGC. */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * Request camera and/or mic access.
 * Returns the stream and individual tracks for easy sender management.
 */
export async function getLocalMedia(
  video: boolean,
  audio: boolean,
): Promise<LocalMedia> {
  if (!video && !audio) {
    return { stream: new MediaStream(), videoTrack: null, audioTrack: null };
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    audio: audio ? AUDIO_CONSTRAINTS : false,
  });

  const videoTrack = stream.getVideoTracks()[0] ?? null;
  const audioTrack = stream.getAudioTracks()[0] ?? null;

  return { stream, videoTrack, audioTrack };
}

/** Stop all tracks and release the camera/mic. */
export function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
}

/** Enable or disable a track in-place (keeps the sender active). */
export function setTrackEnabled(track: MediaStreamTrack | null, enabled: boolean): void {
  if (track) track.enabled = enabled;
}

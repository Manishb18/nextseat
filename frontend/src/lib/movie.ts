/**
 * Movie streaming helpers.
 *
 * Key WebRTC challenge: captureStream() on a <video> element returns a stream
 * that may have NO tracks initially (Chrome) until playback starts. We must
 * listen to stream.onaddtrack and add tracks to the peer connection lazily.
 *
 * Sender tuning: RTCRtpSender.setParameters() is used to cap bitrate and
 * scale resolution. Must call getParameters() first, mutate, then setParameters().
 */

export type Quality = '480p' | '720p' | '1080p';

export interface QualitySettings {
  maxBitrate: number;       // bits per second
  targetHeight: number;     // pixels
}

export const QUALITY_MAP: Record<Quality, QualitySettings> = {
  '480p':  { maxBitrate: 1_200_000, targetHeight: 480 },
  '720p':  { maxBitrate: 3_000_000, targetHeight: 720 },
  '1080p': { maxBitrate: 6_000_000, targetHeight: 1080 },
};

export interface MovieValidationResult {
  ok: boolean;
  error?: string;
  helpMessage?: string;
}

const FFMPEG_HELP = `This file isn't browser-compatible. Convert it with:

  ffmpeg -i input.mkv -c:v libx264 -c:a aac -movflags +faststart output.mp4

If the video is already H.264, this faster version copies the video stream:

  ffmpeg -i input.mkv -c:v copy -c:a aac output.mp4`;

/**
 * Validate a movie file by loading it into a hidden <video>.
 *
 * Checks:
 * 1. Browser can decode the file (loadedmetadata fires without error)
 * 2. Video has non-zero dimensions (confirms video track exists)
 * 3. File has an audio track
 */
export function validateMovieFile(file: File): Promise<MovieValidationResult> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.style.display = 'none';
    document.body.appendChild(video);

    const cleanup = () => {
      video.onerror = null;
      video.onloadedmetadata = null;
      URL.revokeObjectURL(url);
      video.remove();
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve({ ok: false, error: 'Timed out reading file metadata.', helpMessage: FFMPEG_HELP });
    }, 10_000);

    video.onerror = () => {
      window.clearTimeout(timeoutId);
      cleanup();
      resolve({ ok: false, error: 'Browser cannot play this file.', helpMessage: FFMPEG_HELP });
    };

    video.onloadedmetadata = () => {
      window.clearTimeout(timeoutId);

      if (!video.videoWidth || video.videoWidth === 0) {
        cleanup();
        resolve({
          ok: false,
          error: 'No video track detected (or video width is 0).',
          helpMessage: FFMPEG_HELP,
        });
        return;
      }

      // Audio track detection: use AudioTracks API if available, else assume ok
      // (captureStream will include audio if present; absence causes silent stream)
      const audioOk =
        typeof (video as HTMLVideoElement & { audioTracks?: { length: number } }).audioTracks === 'undefined'
        ? true  // API not available — optimistically allow
        : ((video as HTMLVideoElement & { audioTracks: { length: number } }).audioTracks.length > 0);

      cleanup();

      if (!audioOk) {
        resolve({
          ok: false,
          error: 'No audio track detected in this file.',
          helpMessage: FFMPEG_HELP,
        });
        return;
      }

      resolve({ ok: true });
    };

    video.src = url;
    video.load();
  });
}

/**
 * Feature-detect captureStream support.
 * Supported in Chrome/Edge; Firefox has mozCaptureStream; Safari is unreliable.
 */
export function isCaptureStreamSupported(): boolean {
  const proto = HTMLMediaElement.prototype as HTMLMediaElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };
  return typeof proto.captureStream === 'function' ||
    typeof proto.mozCaptureStream === 'function';
}

/**
 * Capture a stream from a playing <video> element.
 * Uses mozCaptureStream as fallback for Firefox.
 */
export function captureVideoStream(videoEl: HTMLVideoElement): MediaStream {
  const el = videoEl as HTMLVideoElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };
  if (typeof el.captureStream === 'function') {
    return el.captureStream();
  }
  if (typeof el.mozCaptureStream === 'function') {
    return el.mozCaptureStream();
  }
  throw new Error('captureStream not supported');
}

/**
 * Apply sender bitrate/resolution parameters for a given quality level.
 *
 * RTCRtpSender.setParameters() must receive the object from getParameters()
 * with only specific fields mutated — do not create a new object.
 */
export async function applyQualityToSender(
  sender: RTCRtpSender,
  quality: Quality,
  sourceHeight: number,
): Promise<void> {
  const { maxBitrate, targetHeight } = QUALITY_MAP[quality];
  const params = sender.getParameters();

  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }

  const enc = params.encodings[0];
  enc.maxBitrate = maxBitrate;
  (params as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference })
    .degradationPreference = 'maintain-framerate';

  // Scale down only if source is larger than target
  if (sourceHeight > targetHeight) {
    enc.scaleResolutionDownBy = sourceHeight / targetHeight;
  } else {
    enc.scaleResolutionDownBy = 1;
  }

  try {
    await sender.setParameters(params);
  } catch (err) {
    console.warn('[movie] setParameters failed (may need active track)', err);
  }
}

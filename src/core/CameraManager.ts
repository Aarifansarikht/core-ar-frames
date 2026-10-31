import type { ARErrorKind } from '../types/ar';

export type Facing = 'environment' | 'user';

export class CameraError extends Error {
  constructor(
    readonly kind: ARErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

export interface CameraListener {
  /** The frame size changed, typically because the phone rotated. */
  resized?(width: number, height: number): void;
  /** The OS or browser took the camera away. */
  interrupted?(): void;
  /** The stream is back after an interruption. */
  resumed?(): void;
}

const mapError = (err: unknown): CameraError => {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return new CameraError('camera-denied', 'Camera permission was denied.');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new CameraError('camera-unavailable', 'No suitable camera was found.');
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('camera-busy', 'The camera is in use by another app.');
    case 'SecurityError':
      return new CameraError('insecure-context', 'Camera access needs a secure connection.');
    default:
      return new CameraError('unknown', err instanceof Error ? err.message : 'Camera failed to start.');
  }
};

/**
 * Owns the one camera stream in the app. Tracking loss never touches it: the stream only stops when
 * the experience does, when the facing direction changes, or when immersive WebXR needs the camera.
 */
export class CameraManager {
  readonly video: HTMLVideoElement;
  facing: Facing = 'environment';

  private stream: MediaStream | null = null;
  private listener: CameraListener = {};
  private lastWidth = 0;
  private lastHeight = 0;
  private restarting = false;

  constructor() {
    const video = document.createElement('video');
    // iOS Safari requires all three for inline playback without a gesture on the video itself.
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.muted = true;
    video.autoplay = true;
    // Must stay in the DOM and technically visible, or iOS stops delivering frames.
    Object.assign(video.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '2px',
      height: '2px',
      opacity: '0',
      pointerEvents: 'none',
      zIndex: '-1',
    });
    this.video = video;
    video.addEventListener('resize', this.onVideoResize);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  setListener(listener: CameraListener) {
    this.listener = listener;
  }

  get active() {
    return this.stream !== null;
  }

  get width() {
    return this.video.videoWidth;
  }

  get height() {
    return this.video.videoHeight;
  }

  static assertSupported() {
    if (!window.isSecureContext) {
      throw new CameraError('insecure-context', 'Camera access needs a secure connection.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('camera-unavailable', 'This browser does not expose the camera.');
    }
  }

  async start(facing: Facing = this.facing) {
    CameraManager.assertSupported();
    this.releaseStream();
    this.facing = facing;

    const stream = await this.acquire(facing);
    this.stream = stream;
    for (const track of stream.getVideoTracks()) track.addEventListener('ended', this.onTrackEnded);

    if (!this.video.isConnected) document.body.appendChild(this.video);
    this.video.srcObject = stream;
    await this.waitForFirstFrame();
    this.lastWidth = this.video.videoWidth;
    this.lastHeight = this.video.videoHeight;
    this.requestContinuousFocus(stream);
  }

  /** Whether a second camera exists. Labels are only readable after permission is granted. */
  async canFlip() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput').length > 1;
    } catch {
      return false;
    }
  }

  flip() {
    return this.start(this.facing === 'environment' ? 'user' : 'environment');
  }

  /** Stops the camera for good, or until the next start(). */
  stop() {
    this.releaseStream();
    this.video.srcObject = null;
    this.video.remove();
    this.lastWidth = 0;
    this.lastHeight = 0;
  }

  dispose() {
    this.stop();
    this.video.removeEventListener('resize', this.onVideoResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.listener = {};
  }

  private async acquire(facing: Facing) {
    // Video constraints are all `ideal` so desktop webcams and odd phones still resolve to something.
    const preferred: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
      },
    };
    try {
      return await navigator.mediaDevices.getUserMedia(preferred);
    } catch (err) {
      const mapped = mapError(err);
      if (mapped.kind !== 'camera-unavailable') throw mapped;
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    } catch (err) {
      throw mapError(err);
    }
  }

  private waitForFirstFrame() {
    const video = this.video;
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new CameraError('camera-unavailable', 'The camera did not deliver any frames.'));
      }, 10000);
      const check = () => {
        if (video.videoWidth > 0 && video.readyState >= video.HAVE_CURRENT_DATA) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        video.removeEventListener('loadeddata', check);
        video.removeEventListener('playing', check);
      };
      video.addEventListener('loadeddata', check);
      video.addEventListener('playing', check);
      video.play().catch(() => {
        // Autoplay of a muted inline stream is allowed; a rejection here is an interrupted play()
        // from a stream swap. The 'playing' event or the timeout settles the outcome.
      });
      check();
    });
  }

  private requestContinuousFocus(stream: MediaStream) {
    const track = stream.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { focusMode?: string[] }) | undefined;
    if (!caps?.focusMode?.includes('continuous')) return;
    // Sharper frames directly improve tracking. Unsupported on many devices, so failure is ignored.
    track
      .applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
      .catch(() => undefined);
  }

  private releaseStream() {
    if (!this.stream) return;
    for (const track of this.stream.getTracks()) {
      track.removeEventListener('ended', this.onTrackEnded);
      track.stop();
    }
    this.stream = null;
  }

  private readonly onVideoResize = () => {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (!w || !h || (w === this.lastWidth && h === this.lastHeight)) return;
    this.lastWidth = w;
    this.lastHeight = h;
    this.listener.resized?.(w, h);
  };

  private readonly onTrackEnded = () => {
    this.listener.interrupted?.();
    if (document.visibilityState === 'visible') void this.recover();
  };

  private readonly onVisibility = () => {
    if (document.visibilityState !== 'visible' || !this.stream) return;
    const live = this.stream.getVideoTracks().some((t) => t.readyState === 'live');
    if (!live) void this.recover();
    else this.video.play().catch(() => undefined);
  };

  /** iOS ends the stream when the page is backgrounded or a call comes in. */
  private async recover() {
    if (this.restarting || !this.stream) return;
    this.restarting = true;
    try {
      await this.start(this.facing);
      this.listener.resumed?.();
    } catch {
      this.listener.interrupted?.();
    } finally {
      this.restarting = false;
    }
  }
}

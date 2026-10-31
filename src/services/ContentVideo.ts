/**
 * One <video> element shared by all video experiences. iOS only lets a video play without a gesture
 * if that element has played during one, so the Start button unlocks this element once and later
 * source changes inherit that permission. Only one poster plays at a time anyway.
 */
export class ContentVideo {
  readonly element: HTMLVideoElement;
  private wantPlaying = false;

  /** Set when the browser refused to autoplay, e.g. iOS Low Power Mode. */
  onBlocked: (() => void) | null = null;

  constructor() {
    const video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.muted = true;
    video.loop = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    // Kept in the DOM (invisibly) because WebKit may otherwise stop decoding frames.
    Object.assign(video.style, { position: 'fixed', top: '0', left: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none', zIndex: '-1' });
    document.body.appendChild(video);
    this.element = video;
  }

  /** Must be called directly from a user gesture. */
  unlock() {
    const video = this.element;
    // WebKit lifts an element's playback restrictions on its first play() inside a gesture. There is
    // no source yet, so the promise rejects; that is expected.
    video.play().catch(() => undefined);
  }

  load(url: string, onProgress?: (fraction: number) => void) {
    const video = this.element;
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener('canplay', onReady);
        video.removeEventListener('error', onError);
        video.removeEventListener('progress', onLoadProgress);
      };
      const onReady = () => {
        cleanup();
        onProgress?.(1);
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Could not load video ${url}`));
      };
      const onLoadProgress = () => {
        if (video.duration > 0 && video.buffered.length) {
          onProgress?.(video.buffered.end(video.buffered.length - 1) / video.duration);
        }
      };
      video.addEventListener('canplay', onReady);
      video.addEventListener('error', onError);
      video.addEventListener('progress', onLoadProgress);
      video.src = url;
      video.load();
    });
  }

  play() {
    this.wantPlaying = true;
    this.element.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'NotAllowedError') this.onBlocked?.();
    });
  }

  /** Retries playback from a fresh gesture. */
  retry() {
    if (this.wantPlaying) this.play();
  }

  pause() {
    this.wantPlaying = false;
    this.element.pause();
  }

  /** Detaches the current source but keeps the element, and its unlocked status, for the next one. */
  release() {
    this.pause();
    this.element.removeAttribute('src');
    this.element.load();
  }
}

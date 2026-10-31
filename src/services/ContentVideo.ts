/** One poster's <video> element. Each poster keeps its own, loaded and ready, so switching is instant. */
export class ContentVideo {
  readonly element: HTMLVideoElement;
  private wantPlaying = false;

  /** Set when the browser refused to autoplay. */
  onBlocked: (() => void) | null = null;

  constructor() {
    const video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.loop = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    // Kept in the DOM (invisibly) so that the browser keeps decoding frames.
    Object.assign(video.style, { position: 'fixed', top: '0', left: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none', zIndex: '-1' });
    document.body.appendChild(video);
    this.element = video;
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

  dispose() {
    this.pause();
    this.element.removeAttribute('src');
    this.element.load();
    this.element.remove();
  }
}

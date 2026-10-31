import type { FrameResult, FromWorker, ToWorker } from './protocol';

/**
 * The page's side of the tracker. The worker lives as long as the page, because loading OpenCV is slow
 * and sessions can be restarted. Only one frame is in the worker at a time: if it falls behind, frames
 * are skipped rather than queued, so results can never fall further and further behind the camera.
 */
export class TrackerClient {
  onResult: ((result: FrameResult) => void) | null = null;
  onFailed: ((detail: string) => void) | null = null;

  // A build bundles the worker into a plain script, but the dev server can only serve it as a module.
  private readonly worker = import.meta.env.DEV
    ? new Worker(new URL('./tracker.worker.ts', import.meta.url), { type: 'module' })
    : new Worker(new URL('./tracker.worker.ts', import.meta.url));
  private readonly ready: Promise<void>;
  private busy = false;

  constructor(opencvUrl: string, targetUrls: string[]) {
    this.ready = new Promise((resolve, reject) => {
      this.worker.onerror = (event) => {
        const detail = event.message || 'The tracker failed to load';
        reject(new Error(detail));
        this.onFailed?.(detail);
      };
      this.worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
        if (data.type === 'ready') {
          resolve();
        } else if (data.type === 'failed') {
          reject(new Error(data.detail));
          this.onFailed?.(data.detail);
        } else {
          this.busy = false;
          if (this.onResult) this.onResult(data);
          else data.frame.close();
        }
      };
    });
    this.send({ type: 'init', opencvUrl, targetUrls });
  }

  /** Resolves when OpenCV and the posters have loaded. */
  whenReady() {
    return this.ready;
  }

  get canTakeFrame() {
    return !this.busy;
  }

  /** Takes ownership of the frame, which comes back with its result. */
  process(frame: ImageBitmap) {
    this.busy = true;
    this.send({ type: 'frame', frame }, [frame]);
  }

  /** Forgets what is being followed, ready for a new session. */
  reset() {
    this.send({ type: 'reset' });
  }

  dispose() {
    this.worker.terminate();
  }

  private send(message: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(message, transfer);
  }
}

/** The rear camera, playing into a video element that isn't added to the page. */
export class CameraSource {
  readonly video = document.createElement('video');
  private stream: MediaStream | null = null;
  private frameRequest = 0;
  private stopped = false;

  /** Rejects with the browser's error if the camera is refused or can't start. */
  async start() {
    this.video.playsInline = true;
    this.video.muted = true;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    if (this.stopped) {
      this.stop();
      return;
    }
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  /** Calls back once for each new camera frame, until stopped. */
  onNewFrame(callback: () => void) {
    const next = () => {
      if (this.stopped) return;
      callback();
      this.frameRequest = this.video.requestVideoFrameCallback(next);
    };
    this.frameRequest = this.video.requestVideoFrameCallback(next);
  }

  /** Turns the camera off. Safe to call more than once. */
  stop() {
    this.stopped = true;
    if (this.frameRequest) this.video.cancelVideoFrameCallback(this.frameRequest);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

/** The parts of the 8th Wall engine this app uses. The engine ships no types. */
export interface ImageTargetData {
  imagePath: string;
  metadata: null;
  name: string;
  type: 'PLANAR';
  properties: {
    left: number;
    top: number;
    width: number;
    height: number;
    isRotated: boolean;
    originalWidth: number;
    originalHeight: number;
  };
}

export interface XR8ImageDetail {
  name: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  /** The size of the target's long side, in world units. */
  scale: number;
}

export interface XR8Reality {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  intrinsics: ArrayLike<number>;
  trackingStatus: 'NORMAL' | 'LIMITED';
}

export interface XR8CameraStatus {
  status: 'requesting' | 'hasStream' | 'hasVideo' | 'failed';
  reason?: string;
}

export interface XR8Module {
  name: string;
  onStart?(args: { GLctx: WebGL2RenderingContext; canvas: HTMLCanvasElement }): void;
  onUpdate?(args: { processCpuResult: { reality?: XR8Reality } }): void;
  onRender?(): void;
  onCameraStatusChange?(status: XR8CameraStatus): void;
  onException?(error: unknown): void;
  listeners?: { event: string; process(args: { name: string; detail: never }): void }[];
}

export interface XR8Engine {
  version(): string;
  run(options: { canvas: HTMLCanvasElement }): void;
  stop(): void;
  addCameraPipelineModules(modules: (XR8Module | object)[]): void;
  clearCameraPipelineModules(): void;
  GlTextureRenderer: { pipelineModule(): object };
  XrController: {
    pipelineModule(): object;
    configure(options: { imageTargetData?: ImageTargetData[]; scale?: 'responsive' | 'absolute' }): void;
    updateCameraProjectionMatrix(options: {
      origin: { x: number; y: number; z: number };
      facing: { x: number; y: number; z: number; w: number };
    }): void;
  };
  XrDevice: {
    isDeviceBrowserCompatible(): boolean;
  };
}

declare global {
  interface Window {
    XR8?: XR8Engine;
  }
}

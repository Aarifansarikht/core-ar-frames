// The parts of MindAR 1.2.5 this project relies on. The package ships untyped source and the version
// is pinned exactly because ImageTrackingAdapter drives the tracker's per-frame steps directly.
declare module 'mind-ar/src/image-target/controller.js' {
  export type ModelViewTransform = number[][];

  export interface TrackedFeatures {
    worldCoords: { x: number; y: number; z: number }[];
    screenCoords: { x: number; y: number }[];
  }

  export interface InputTensor {
    dispose(): void;
  }

  export interface MindARTracker {
    trackingKeyframeList: { points: unknown[]; width: number; height: number; scale: number }[];
    featurePointsListT: InputTensor[];
    imagePixelsListT: InputTensor[];
    imagePropertiesListT: InputTensor[];
    track(input: InputTensor, modelView: ModelViewTransform, targetIndex: number): TrackedFeatures;
  }

  export class Controller {
    constructor(options: { inputWidth: number; inputHeight: number; debugMode?: boolean });
    projectionTransform: number[][];
    markerDimensions: [number, number][] | null;
    worker: Worker;
    inputLoader: { loadInput(input: HTMLVideoElement | HTMLCanvasElement): InputTensor };
    tracker: MindARTracker;
    addImageTargetsFromBuffer(buffer: ArrayBuffer): {
      dimensions: [number, number][];
      matchingDataList: unknown[];
      trackingDataList: unknown[];
    };
    dummyRun(input: HTMLVideoElement | HTMLCanvasElement): void;
    getWorldMatrix(modelView: ModelViewTransform, targetIndex: number): number[];
    dispose(): void;
    _detectAndMatch(
      input: InputTensor,
      targetIndexes: number[],
    ): Promise<{ targetIndex: number; modelViewTransform: ModelViewTransform | null }>;
    _workerTrackUpdate(modelView: ModelViewTransform, features: TrackedFeatures): Promise<ModelViewTransform | null>;
  }
}

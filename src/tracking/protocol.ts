/** Messages between TrackerClient and the worker. */
export interface InitMessage {
  type: 'init';
  /** The OpenCV script. */
  opencvUrl: string;
  /** One compiled poster per URL. Results refer to posters by their place in this list. */
  targetUrls: string[];
}

export interface FrameMessage {
  type: 'frame';
  frame: ImageBitmap;
}

export interface ResetMessage {
  type: 'reset';
}

export type ToWorker = InitMessage | FrameMessage | ResetMessage;

/** A poster found in one frame. */
export interface PosterPose {
  targetIndex: number;
  /** Column-major content frame to camera, in GL axes: +X right, +Y up, looking down -Z. */
  matrix: number[];
  /** The poster's corners in the processed image, for tests: top left, top right, bottom right, bottom left. */
  corners: number[];
  /** Points that agreed with this pose. */
  points: number;
}

export interface FrameResult {
  type: 'result';
  /** The frame this result is for, handed back so that the two are shown together. */
  frame: ImageBitmap;
  pose: PosterPose | null;
  /** The size of the image the tracker processed, which poses are relative to. */
  width: number;
  height: number;
  /** The focal length assumed, in processed pixels. */
  focal: number;
  ms: number;
  mode: 'search' | 'follow' | 'refine';
}

export interface ReadyMessage {
  type: 'ready';
}

export interface FailedMessage {
  type: 'failed';
  detail: string;
}

export type FromWorker = FrameResult | ReadyMessage | FailedMessage;

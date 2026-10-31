export type LocatorRequest =
  | { type: 'init'; targetsUrl: string }
  | {
      type: 'frame';
      id: number;
      /** RGBA, in the row order of the read-back. */
      pixels: ArrayBuffer;
      width: number;
      height: number;
      /** Whether the rows have to be reversed to make the image top-down. */
      flip: boolean;
      /** Lens intrinsics in pixels of this image: fx, fy, cx, cy. */
      k: [number, number, number, number];
      /** Posters to try, in this order. */
      order: number[];
    };

export type LocatorResponse =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | {
      type: 'result';
      id: number;
      /** -1 if no poster was found. */
      targetIndex: number;
      /** Content frame to camera space, column-major, with the poster's width as the unit. */
      matrix: number[] | null;
      /** 0..1, the share of the poster's features confirmed. */
      confidence: number;
      ms: number;
    };

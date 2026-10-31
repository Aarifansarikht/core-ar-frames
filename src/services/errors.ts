import type { ARErrorInfo, ARErrorKind } from '../types/ar';

/** AR couldn't start, for a reason the user may be able to fix. */
export class EngineError extends Error {
  constructor(
    readonly kind: ARErrorKind,
    readonly detail: unknown,
  ) {
    super(`AR: ${kind}`);
  }
}

/** Sorts what getUserMedia rejects with. */
export function errorKindFor(detail: unknown): ARErrorKind {
  if (detail instanceof DOMException && (detail.name === 'NotAllowedError' || detail.name === 'SecurityError')) return 'camera-denied';
  return 'camera-failed';
}

export function describeError(kind: ARErrorKind): ARErrorInfo {
  switch (kind) {
    case 'camera-denied':
      return {
        kind,
        title: 'Camera access is off',
        message: 'Allow the camera for this site in your browser’s settings, then try again.',
        canRetry: true,
      };
    case 'motion-denied':
      return {
        kind,
        title: 'Motion access is off',
        message: 'AR needs motion access to hold content in place. Close this tab, open the link again, and choose Allow.',
        canRetry: true,
      };
    case 'camera-failed':
      return {
        kind,
        title: 'Couldn’t start the camera',
        message: 'Close other apps using the camera, then try again.',
        canRetry: true,
      };
    case 'tracking-init':
      return {
        kind,
        title: 'AR stopped unexpectedly',
        message: 'The device may be short on memory. Close some tabs and try again.',
        canRetry: true,
      };
    case 'asset-load':
      return {
        kind,
        title: 'Content didn’t load',
        message: 'Check your connection and try again.',
        canRetry: true,
      };
    case 'webgl-init':
      return {
        kind,
        title: '3D graphics unavailable',
        message: 'This browser couldn’t start WebGL. Update it, or check that hardware acceleration is on.',
        canRetry: true,
      };
    case 'webgl-lost':
      return {
        kind,
        title: 'Graphics were reset',
        message: 'The device reclaimed graphics memory. Tap retry to restart the experience.',
        canRetry: true,
      };
    case 'unknown':
      return {
        kind,
        title: 'Something went wrong',
        message: 'Please try again.',
        canRetry: true,
      };
  }
}

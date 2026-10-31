import type { ARErrorInfo, ARErrorKind } from '../types/ar';

export function describeError(kind: ARErrorKind): ARErrorInfo {
  switch (kind) {
    case 'camera-denied':
      return {
        kind,
        title: 'Camera access is off',
        message: 'Tap the icon next to the address bar, open Permissions, allow Camera and AR, then try again.',
        canRetry: true,
      };
    case 'xr-image-tracking':
      return {
        kind,
        title: 'Turn on image tracking in Chrome',
        message:
          'Open chrome://flags/#webxr-incubations, set WebXR Incubations to Enabled and relaunch Chrome. Also check that Google Play Services for AR is up to date, then open this page again.',
        canRetry: true,
      };
    case 'xr-session':
      return {
        kind,
        title: 'Couldn’t start ARCore',
        message: 'Check that Google Play Services for AR is up to date, close other apps using the camera, then try again.',
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

import type { ARErrorInfo, ARErrorKind } from '../types/ar';

export function describeError(kind: ARErrorKind, isIOS: boolean): ARErrorInfo {
  switch (kind) {
    case 'camera-denied':
      return {
        kind,
        title: 'Camera access is off',
        message: isIOS
          ? 'In Safari, tap aA in the address bar, open Website Settings, set Camera to Allow, then try again.'
          : 'Tap the icon next to the address bar, open Permissions, allow Camera, then try again.',
        canRetry: true,
      };
    case 'camera-unavailable':
      return {
        kind,
        title: 'No camera found',
        message: 'This experience needs a camera. Try opening this page on your phone.',
        canRetry: true,
      };
    case 'camera-busy':
      return {
        kind,
        title: 'Camera is busy',
        message: 'Another app is using the camera. Close it, then try again.',
        canRetry: true,
      };
    case 'insecure-context':
      return {
        kind,
        title: 'Secure connection needed',
        message: 'Browsers only allow camera access over HTTPS. Open this page using an https:// address.',
        canRetry: false,
      };
    case 'tracking-init':
      return {
        kind,
        title: 'Couldn’t start tracking',
        message: 'The tracker failed to start, usually because the device is short on memory. Close some tabs and try again.',
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
    case 'xr-session':
      return {
        kind,
        title: 'Couldn’t start room AR',
        message: 'Google Play Services for AR may need updating. You can still scan posters using the regular camera view.',
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

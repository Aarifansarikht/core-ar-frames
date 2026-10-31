export type UnsupportedReason = 'insecure' | 'no-webgl' | 'incompatible';

export interface Capabilities {
  /** Null when the device has everything the tracker needs. */
  unsupported: UnsupportedReason | null;
  isInAppBrowser: boolean;
  /** Motion sensors can only be expected on a device held in the hand. */
  hasMotion: boolean;
}

const hasWebGL2 = () => {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
};

export function detectCapabilities(): Capabilities {
  const ua = navigator.userAgent;
  // Facebook, Instagram, etc. webviews commonly don't offer the camera.
  const isInAppBrowser = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|; wv\)/.test(ua);

  let unsupported: UnsupportedReason | null = null;
  if (!window.isSecureContext) unsupported = 'insecure';
  else if (!hasWebGL2()) unsupported = 'no-webgl';
  else if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof WebAssembly === 'undefined' ||
    !('requestVideoFrameCallback' in HTMLVideoElement.prototype)
  ) {
    unsupported = 'incompatible';
  }

  return { unsupported, isInAppBrowser, hasMotion: navigator.maxTouchPoints > 0 };
}

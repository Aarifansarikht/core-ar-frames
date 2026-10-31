export type UnsupportedReason = 'insecure' | 'no-webgl' | 'no-arcore';

export interface Capabilities {
  /** Null when the device can run ARCore through WebXR, as far as can be told before a session starts. */
  unsupported: UnsupportedReason | null;
  isIOS: boolean;
  isInAppBrowser: boolean;
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
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
  // Facebook, Instagram, etc. webviews don't offer WebXR.
  const isInAppBrowser = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|; wv\)/.test(ua);

  let unsupported: UnsupportedReason | null = null;
  if (!window.isSecureContext) unsupported = 'insecure';
  else if (!navigator.xr) unsupported = 'no-arcore';
  else if (!hasWebGL2()) unsupported = 'no-webgl';

  return { unsupported, isIOS, isInAppBrowser };
}

/**
 * Whether this device can run immersive WebXR AR (ARCore on Android). Never true on iOS Safari, which
 * doesn't implement it. A positive answer still doesn't promise that a session request will succeed.
 */
export async function supportsImmersiveAR() {
  try {
    return (await navigator.xr?.isSessionSupported('immersive-ar')) ?? false;
  } catch {
    return false;
  }
}

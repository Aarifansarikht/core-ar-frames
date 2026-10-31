export type UnsupportedReason = 'insecure' | 'no-webgl' | 'incompatible';

export interface Capabilities {
  /** Null when the device can run the engine, as far as can be told. */
  unsupported: UnsupportedReason | null;
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

/** The engine makes the final call on the device once it has loaded. */
export function detectCapabilities(): Capabilities {
  const ua = navigator.userAgent;
  // Facebook, Instagram, etc. webviews commonly don't offer the camera.
  const isInAppBrowser = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|; wv\)/.test(ua);

  let unsupported: UnsupportedReason | null = null;
  if (!window.isSecureContext) unsupported = 'insecure';
  else if (!hasWebGL2()) unsupported = 'no-webgl';

  return { unsupported, isInAppBrowser };
}

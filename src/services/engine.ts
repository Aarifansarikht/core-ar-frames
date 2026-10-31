import type { XR8Engine } from '../types/xr8';

const LOAD_TIMEOUT_MS = 30000;

/** Waits for the engine that index.html loads. Rejects if it can't be downloaded. */
export function loadEngine() {
  return new Promise<XR8Engine>((resolve, reject) => {
    if (window.XR8) {
      resolve(window.XR8);
      return;
    }
    const timer = window.setTimeout(() => reject(new Error('The AR engine did not load')), LOAD_TIMEOUT_MS);
    window.addEventListener(
      'xrloaded',
      () => {
        window.clearTimeout(timer);
        resolve(window.XR8!);
      },
      { once: true },
    );
  });
}

interface MotionPermission {
  requestPermission?(): Promise<'granted' | 'denied'>;
}

/**
 * iOS only reports motion after a prompt, which must come from a tap, so this has to be called before
 * anything in the tap is awaited. Other platforms don't ask.
 */
export async function requestMotionAccess() {
  const requests = [DeviceOrientationEvent as MotionPermission, DeviceMotionEvent as MotionPermission]
    .filter((sensor) => sensor.requestPermission)
    .map((sensor) => sensor.requestPermission!());
  try {
    return (await Promise.all(requests)).every((answer) => answer === 'granted');
  } catch {
    return false;
  }
}

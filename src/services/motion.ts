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

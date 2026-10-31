import { CameraIcon } from '../ui/icons';

/** Shown while the browser's own camera prompt is up, so the user knows what to do with it. */
export function PermissionScreen() {
  return (
    <section className="screen center">
      <div className="glass card">
        <span className="card__icon">
          <CameraIcon />
        </span>
        <h2>Allow camera access</h2>
        <p>Choose Allow when Chrome asks. The camera is only used to find the poster: nothing is recorded or uploaded.</p>
        <div className="dots" aria-label="Waiting for permission">
          <i />
          <i />
          <i />
        </div>
      </div>
    </section>
  );
}

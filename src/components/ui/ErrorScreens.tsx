import type { ARManager } from '../../core/ARManager';
import type { Capabilities } from '../../services/capabilities';
import type { ARErrorInfo } from '../../types/ar';
import { AlertIcon } from './icons';

export function ErrorScreen({ error, manager }: { error: ARErrorInfo; manager: ARManager }) {
  return (
    <section className="screen center">
      <div className="glass card" role="alert">
        <span className="card__icon card__icon--warn">
          <AlertIcon />
        </span>
        <h2>{error.title}</h2>
        <p>{error.message}</p>
        {error.canRetry && (
          <button className="button button--primary" onClick={manager.retry}>
            Try again
          </button>
        )}
        <button className="button button--text" onClick={manager.stop}>
          Back
        </button>
      </div>
    </section>
  );
}

const unsupportedMessage = ({ unsupported, isInAppBrowser }: Capabilities) => {
  if (unsupported === 'insecure') return 'AR needs a secure connection. Open this page using an https:// address.';
  if (isInAppBrowser) return 'This in-app browser can’t run AR. Open this link in Safari or Chrome instead.';
  if (unsupported === 'no-webgl') return 'This browser doesn’t support the 3D graphics this experience needs. Please update it.';
  return 'This browser is too old for AR. Please update it, or open this link in Safari on iPhone or Chrome on Android.';
};

export function UnsupportedScreen({ capabilities }: { capabilities: Capabilities }) {
  return (
    <section className="screen center">
      <div className="glass card" role="alert">
        <span className="card__icon card__icon--warn">
          <AlertIcon />
        </span>
        <h2>This browser isn’t supported</h2>
        <p>{unsupportedMessage(capabilities)}</p>
      </div>
    </section>
  );
}

import { EXPERIENCES } from '../../config/experiences';
import type { ARManager, ARState } from '../../core/ARManager';
import { RoomIcon } from './icons';

export function WelcomeScreen({ state, manager }: { state: ARState; manager: ARManager }) {
  const deepLink = manager.options.deepLink;
  const logo = deepLink?.logo;

  return (
    <section className="screen welcome">
      <div className="welcome__art" aria-hidden="true">
        {deepLink ? (
          <img className="welcome__hero" src={deepLink.hero ?? deepLink.thumb} alt="" />
        ) : (
          <div className="welcome__fan">
            {EXPERIENCES.map((e, i) => (
              <img key={e.id} src={e.thumb} alt="" style={{ '--i': i - (EXPERIENCES.length - 1) / 2 } as React.CSSProperties} />
            ))}
          </div>
        )}
      </div>

      <div className="welcome__copy">
        {logo ? <img className="brand-logo" src={logo} alt={deepLink?.title} /> : <p className="eyebrow">BAY81 Studio</p>}
        <h1>{deepLink ? deepLink.subtitle : 'Posters that come alive'}</h1>
        <p className="lede">
          {deepLink
            ? 'Point your camera at the poster to see it in augmented reality.'
            : 'Point your camera at any of these posters and watch them move.'}
        </p>

        <button className="button button--primary" onClick={manager.start} disabled={!state.ready}>
          {state.ready ? 'Start AR' : 'Preparing…'}
        </button>
        {state.canPlaceInRoom && (
          <button className="button button--ghost" onClick={manager.placeInRoom}>
            <RoomIcon /> Place the tyre in your room
          </button>
        )}
      </div>
    </section>
  );
}

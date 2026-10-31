import type { ARManager, ARState } from '../../core/ARManager';
import type { ARPhase } from '../../types/ar';
import { CloseIcon } from './icons';

const STATUS: Partial<Record<ARPhase, { text: string; tone: string }>> = {
  scanning: { text: 'Searching', tone: 'search' },
  detected: { text: 'Poster found', tone: 'good' },
  active: { text: 'Locked', tone: 'good' },
  lost: { text: 'Lost the poster', tone: 'warn' },
  recovered: { text: 'Back on target', tone: 'good' },
};

const PLACEMENT_PROMPT = {
  searching: 'Move your phone slowly to find a surface',
  ready: 'Tap to place the tyre',
} as const;

export function Hud({ state, manager }: { state: ARState; manager: ARManager }) {
  const { phase, placement, hotspot, experience, videoBlocked } = state;
  const isPlacing = placement === 'searching' || placement === 'ready';
  const status = STATUS[phase];
  const showHint = !isPlacing && placement !== 'placed' && (phase === 'scanning' || phase === 'lost');

  return (
    <div className="hud">
      <header className="hud__top">
        <button className="icon-button glass" onClick={manager.stop} aria-label="Close">
          <CloseIcon />
        </button>
        {status && !isPlacing && (
          <div className={`status glass status--${status.tone}`} role="status" key={status.text}>
            <i />
            {status.text}
          </div>
        )}
        <span className="icon-button icon-button--spacer" />
      </header>

      {showHint && (
        <div className="scan" data-lost={phase === 'lost'}>
          <div className="scan__frame" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
          <p className="scan__hint glass">
            {phase === 'lost'
              ? 'Point back at the poster'
              : experience
                ? `Point at the ${experience.title} poster`
                : 'Point at a poster and hold steady'}
          </p>
        </div>
      )}

      {isPlacing && <p className="hud__prompt glass">{PLACEMENT_PROMPT[placement as 'searching' | 'ready']}</p>}

      {videoBlocked && <p className="hud__prompt glass">Tap anywhere to start the video</p>}

      {hotspot && (
        <aside className="hotspot glass" key={hotspot.id}>
          <h3>{hotspot.title}</h3>
          <p>{hotspot.description}</p>
        </aside>
      )}

      {phase === 'active' && experience?.hotspots && !hotspot && <p className="hud__tip">Tap a red marker to explore the tyre</p>}
    </div>
  );
}

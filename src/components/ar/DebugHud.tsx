import { useEffect, useRef } from 'react';
import type { TrackingStats } from '../../types/ar';

type DebugWindow = Window & { __AR__?: { stats(): (TrackingStats & { renderFps: number }) | null } };

/** `?debug` overlay. Writes to the DOM directly, so it never adds React renders to what it measures. */
export function DebugHud() {
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const s = (window as DebugWindow).__AR__?.stats();
      if (!s || !ref.current) return;
      ref.current.textContent = [
        s.engine,
        `render ${s.renderFps.toFixed(0)} fps`,
        `track  ${s.trackFps.toFixed(0)} fps  ${s.frameMs.toFixed(0)} ms`,
        `mode   ${s.mode}`,
        `image  ${s.imageState}  #${s.target}  ${s.points} pts`,
      ].join('\n');
    }, 300);
    return () => window.clearInterval(timer);
  }, []);

  return <pre ref={ref} className="debug-hud" />;
}

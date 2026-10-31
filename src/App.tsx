import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { DebugHud } from './components/ar/DebugHud';
import { ErrorScreen, UnsupportedScreen } from './components/ui/ErrorScreens';
import { Hud } from './components/ui/Hud';
import { PermissionScreen } from './components/camera/PermissionScreen';
import { Preloader } from './components/ui/Preloader';
import { WelcomeScreen } from './components/ui/WelcomeScreen';
import type { ARManager } from './core/ARManager';

export function App({ manager }: { manager: ARManager }) {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot);

  const stage = useCallback(
    (node: HTMLDivElement | null) => {
      manager.attachContainer(node);
    },
    [manager],
  );

  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 800));
    idle(() => manager.prefetch());
  }, [manager]);

  const { phase } = state;
  const inExperience = phase === 'scanning' || phase === 'detected' || phase === 'active' || phase === 'lost' || phase === 'recovered';

  return (
    <>
      <div ref={stage} className="ar-stage" data-live={inExperience} />
      <div id="ar-overlay" className="overlay">
        {phase === 'welcome' && <WelcomeScreen state={state} manager={manager} />}
        {phase === 'permission' && <PermissionScreen />}
        {phase === 'initializing' && <Preloader state={state} />}
        {inExperience && <Hud state={state} manager={manager} />}
        {phase === 'unsupported' && <UnsupportedScreen capabilities={manager.capabilities} />}
        {phase === 'error' && state.error && <ErrorScreen error={state.error} manager={manager} />}
        {manager.options.debug && inExperience && <DebugHud />}
      </div>
    </>
  );
}

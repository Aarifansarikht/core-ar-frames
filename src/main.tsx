import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/wght.css';
import './styles/app.css';
import { App } from './App';
import { ARManager } from './core/ARManager';

const AdminPanel = lazy(() => import('./admin/AdminPanel').then((module) => ({ default: module.AdminPanel })));

const root = createRoot(document.getElementById('root')!);
if (new URLSearchParams(window.location.search).has('admin')) {
  root.render(
    <StrictMode>
      <Suspense fallback={null}>
        <AdminPanel />
      </Suspense>
    </StrictMode>,
  );
} else {
  // Created once, outside React, so that StrictMode's double effects can't start a second camera.
  const manager = new ARManager();
  root.render(
    <StrictMode>
      <App manager={manager} />
    </StrictMode>,
  );
}

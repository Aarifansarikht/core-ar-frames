import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/wght.css';
import './styles/app.css';
import { App } from './App';
import { ARManager } from './core/ARManager';

// Created once, outside React, so that StrictMode's double effects can't start a second camera.
const manager = new ARManager();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App manager={manager} />
  </StrictMode>,
);

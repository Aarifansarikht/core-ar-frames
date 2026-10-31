// Stands in for the '@tensorflow/tfjs' umbrella package (see the alias in vite.config.ts).
// MindAR only needs core ops and the WebGL backend; layers and converter are dead weight.
export * from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-core/dist/public/chained_ops/register_all_chained_ops';
import '@tensorflow/tfjs-backend-webgl';

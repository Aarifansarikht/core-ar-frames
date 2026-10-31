// MindAR's input loader asks `document` for a canvas, which a worker doesn't have. This module has to be
// imported before MindAR.
const scope = self as unknown as { document?: unknown };
scope.document ??= { createElement: () => new OffscreenCanvas(1, 1) };

export {};

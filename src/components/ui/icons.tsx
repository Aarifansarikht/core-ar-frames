const base = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const CloseIcon = () => (
  <svg {...base} aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const FlipIcon = () => (
  <svg {...base} aria-hidden="true">
    <path d="M4 8.5A8 8 0 0 1 19 7l1 2M20 15.5A8 8 0 0 1 5 17l-1-2" />
    <path d="M20 4v5h-5M4 20v-5h5" />
  </svg>
);

export const CameraIcon = () => (
  <svg {...base} width={30} height={30} strokeWidth={1.5} aria-hidden="true">
    <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.3a1 1 0 0 0 .8-.4l1-1.2a1 1 0 0 1 .8-.4h4.8a1 1 0 0 1 .8.4l1 1.2a1 1 0 0 0 .8.4h2.7A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
    <circle cx="12" cy="13" r="3.6" />
  </svg>
);

export const AlertIcon = () => (
  <svg {...base} width={30} height={30} strokeWidth={1.5} aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5M12 16.4v.1" />
  </svg>
);

export const RoomIcon = () => (
  <svg {...base} aria-hidden="true">
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
  </svg>
);

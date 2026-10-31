export type DeviceTier = 'low' | 'mid' | 'high';

export interface QualityProfile {
  tier: DeviceTier;
  /** Tracker input short side. 368 is the smallest that gets MindAR's 256px detector crop in 16:9. */
  trackerShortSide: number;
  maxPixelRatio: number;
  antialias: boolean;
}

interface NavigatorWithMemory extends Navigator {
  deviceMemory?: number;
}

export function detectTier(nav: NavigatorWithMemory = navigator): DeviceTier {
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory; // Not exposed on iOS Safari.
  const isIOS = /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.userAgent.includes('Mac') && nav.maxTouchPoints > 1);
  if (isIOS) return 'mid'; // Safari reveals no specs; even older supported iPhones handle this tier.
  if ((memory !== undefined && memory < 3) || cores <= 4) return 'low';
  if (memory !== undefined && memory >= 8 && cores >= 8) return 'high';
  return 'mid';
}

export function qualityFor(tier: DeviceTier): QualityProfile {
  switch (tier) {
    case 'low':
      return { tier, trackerShortSide: 368, maxPixelRatio: 1.5, antialias: false };
    case 'mid':
      return { tier, trackerShortSide: 480, maxPixelRatio: 2, antialias: true };
    case 'high':
      return { tier, trackerShortSide: 540, maxPixelRatio: 2, antialias: true };
  }
}

/**
 * Watches render frame time and trades resolution for smoothness. Only the pixel ratio moves: tracker
 * input stays fixed at runtime so that tracking quality never pays for decorative rendering.
 */
export class PerformanceManager {
  fps = 60;
  pixelRatio: number;

  private accumulated = 0;
  private frames = 0;
  private cooldown = 0;

  constructor(
    private readonly quality: QualityProfile,
    private readonly applyPixelRatio: (ratio: number) => void,
  ) {
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio);
  }

  frame(dt: number) {
    if (dt <= 0 || dt > 0.5) return; // Tab switches and stalls say nothing about steady-state cost.
    this.accumulated += dt;
    this.frames += 1;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.accumulated < 1) return;

    this.fps = this.frames / this.accumulated;
    this.accumulated = 0;
    this.frames = 0;
    if (this.cooldown > 0) return;

    const ceiling = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    if (this.fps < 28 && this.pixelRatio > 1) {
      this.setPixelRatio(Math.max(1, this.pixelRatio - 0.25));
    } else if (this.fps > 50 && this.pixelRatio < ceiling) {
      this.setPixelRatio(Math.min(ceiling, this.pixelRatio + 0.25));
    }
  }

  private setPixelRatio(ratio: number) {
    this.pixelRatio = ratio;
    this.cooldown = 4; // Let the new cost show up in the numbers before judging it.
    this.applyPixelRatio(ratio);
  }
}

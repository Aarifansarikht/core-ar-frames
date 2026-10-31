import { CanvasTexture, Group, Sprite, SpriteMaterial, Vector3, type Raycaster } from 'three';
import type { HotspotConfig } from '../config/experiences';

const HIGHLIGHT = '#f0284a';
/** About 3 degrees either side of a marker, which is a comfortable fingertip on a phone. */
const PICK_TANGENT = 0.055;

const makeDotTexture = () => {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.beginPath();
  ctx.arc(c, c, c - 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = HIGHLIGHT;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  return new CanvasTexture(canvas);
};

const makeLabelTexture = (text: string) => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = '700 44px "Inter Variable", -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.font = font;
  const label = text.toUpperCase();
  const padding = 40;
  canvas.width = Math.ceil(ctx.measureText(label).width) + padding * 2;
  canvas.height = 96;
  ctx.font = font;
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, 48);
  ctx.fill();
  ctx.fillStyle = '#10151f';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, canvas.width / 2, canvas.height / 2 + 2);
  const texture = new CanvasTexture(canvas);
  return { texture, aspect: canvas.width / canvas.height };
};

interface Hotspot {
  config: HotspotConfig;
  dot: Sprite;
  label: Sprite;
  labelMaterial: SpriteMaterial;
}

/** The tappable markers on the tyre and the label pill each one shows. Both track with the model. */
export class Hotspots {
  readonly group = new Group();
  selected: HotspotConfig | null = null;

  private readonly dotTexture = makeDotTexture();
  private readonly dotMaterial: SpriteMaterial;
  private readonly items: Hotspot[] = [];
  private readonly world = new Vector3();
  private readonly toPoint = new Vector3();
  private opacity = 0;
  private targetOpacity = 0;

  constructor(configs: HotspotConfig[]) {
    this.dotMaterial = new SpriteMaterial({
      map: this.dotTexture,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
      opacity: 0,
    });
    for (const config of configs) {
      const dot = new Sprite(this.dotMaterial);
      dot.position.fromArray(config.position);
      dot.scale.setScalar(0.17);
      dot.renderOrder = 40;

      const { texture, aspect } = makeLabelTexture(config.title);
      const labelMaterial = new SpriteMaterial({
        map: texture,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        toneMapped: false,
        opacity: 0,
      });
      const label = new Sprite(labelMaterial);
      label.center.set(1, 0.5); // Extends left of the marker, over the dark sidewall.
      label.position.fromArray(config.position).add(new Vector3(-0.13, 0, 0.02));
      const height = 0.2;
      label.scale.set(height * aspect, height, 1);
      label.renderOrder = 41;
      label.visible = false;

      this.group.add(dot, label);
      this.items.push({ config, dot, label, labelMaterial });
    }
  }

  show() {
    this.targetOpacity = 1;
  }

  /** Selects the marker nearest the ray, toggling it if it is already selected, or clears on a miss. */
  pick(raycaster: Raycaster) {
    let best: Hotspot | null = null;
    let bestTangent = PICK_TANGENT;
    for (const item of this.items) {
      item.dot.getWorldPosition(this.world);
      this.toPoint.copy(this.world).sub(raycaster.ray.origin);
      const along = this.toPoint.dot(raycaster.ray.direction);
      if (along <= 0) continue;
      const tangent = raycaster.ray.distanceToPoint(this.world) / along;
      if (tangent < bestTangent) {
        best = item;
        bestTangent = tangent;
      }
    }
    this.selected = best && best.config !== this.selected ? best.config : null;
    return this.selected;
  }

  update(dt: number, time: number) {
    this.opacity += (this.targetOpacity - this.opacity) * Math.min(1, dt * 5);
    this.dotMaterial.opacity = this.opacity;
    const pulse = 0.17 * (1 + 0.1 * Math.sin(time * 3.2));
    for (const item of this.items) {
      const on = item.config === this.selected;
      item.dot.scale.setScalar(on ? 0.2 : pulse);
      item.label.visible = on || item.labelMaterial.opacity > 0.01;
      item.labelMaterial.opacity += ((on ? 1 : 0) - item.labelMaterial.opacity) * Math.min(1, dt * 10);
    }
  }

  dispose() {
    this.dotTexture.dispose();
    this.dotMaterial.dispose();
    for (const item of this.items) {
      item.labelMaterial.map?.dispose();
      item.labelMaterial.dispose();
    }
    this.group.removeFromParent();
  }
}

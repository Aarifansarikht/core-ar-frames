import { Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D, type Raycaster } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { ExperienceConfig, HotspotConfig } from '../config/experiences';
import { AnimationManager } from '../core/AnimationManager';
import type { LightingManager } from '../core/LightingManager';
import { disposeObject, type ModelManager } from '../core/ModelManager';
import { applyTreadHighlight, createTreadHighlightUniforms } from '../shaders/treadHighlight';
import type { Experience, PlacementSpec, SurfaceKind } from './Experience';
import { Hotspots } from './Hotspots';

/** A 205/55 R16 is about 632 mm across, and the model's tyre is 0.312 poster widths across. */
const LIFE_SIZE_SCALE = 0.632 / 0.3123;
// From the GLB: TyreLift's rest position, its scale times the tread radius, and the intro's final lift.
const TYRE_CENTRE: [number, number] = [0.25, -0.0222];
const TYRE_RADIUS = 0.1561;
const TYRE_LIFT = 0.1;

const SEMI_TRANSPARENT_ORDER: Record<string, number> = { CleanPatch: 1, Glow: 2, ContactShadow: 3 };

/**
 * The GLB is authored in the poster's frame, so the tyre at rest lines up with the tyre printed on the
 * poster. `intro` lifts it off the print, `CleanPatch` covers the print behind it, and `loop` spins the
 * wheel and runs the light streaks. Its layout is used as authored.
 */
export class TyreExperience implements Experience {
  readonly placement: PlacementSpec = {
    scale: LIFE_SIZE_SCALE,
    contactPoint: (surface) =>
      surface === 'floor'
        ? [TYRE_CENTRE[0], TYRE_CENTRE[1] - TYRE_RADIUS, TYRE_LIFT]
        : [TYRE_CENTRE[0], TYRE_CENTRE[1], 0],
  };

  root!: Object3D;

  private gltf: GLTF | null = null;
  private animations: AnimationManager | null = null;
  private hotspots: Hotspots | null = null;
  private wheel: Object3D | null = null;
  private readonly highlight = createTreadHighlightUniforms('#f0284a');
  private highlightTarget = 0;
  private introLeft = 0;
  private entered = false;

  constructor(
    private readonly config: ExperienceConfig,
    private readonly models: ModelManager,
    private readonly lighting: LightingManager,
  ) {}

  async load(onProgress?: (fraction: number) => void) {
    this.gltf = await this.models.load(this.config.content, onProgress);
    this.root = this.gltf.scene;
    this.root.visible = false;
    this.lighting.ensureStudioLighting();

    this.wheel = this.require('Wheel');
    for (const name of Object.keys(SEMI_TRANSPARENT_ORDER)) {
      this.require(name).traverse((node) => {
        if ((node as Mesh).isMesh) node.renderOrder = SEMI_TRANSPARENT_ORDER[name];
      });
    }

    this.root.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      if (mesh.material instanceof MeshBasicMaterial) {
        // Unlit layers were painted to sit on the print: ACES would shift them away from it.
        mesh.material.toneMapped = false;
      } else if (mesh.material instanceof MeshStandardMaterial && mesh.material.metalness === 0) {
        // Rubber. The shader also limits itself to the tread radius, so non-rubber is never tinted.
        applyTreadHighlight(mesh.material, this.highlight);
      }
    });

    if (this.config.hotspots?.length) {
      // Labels are drawn to a canvas once, so the web font has to be there first.
      await document.fonts.load('700 44px "Inter Variable"').catch(() => undefined);
      this.hotspots = new Hotspots(this.config.hotspots);
      this.require('Tyre').add(this.hotspots.group);
    }

    this.animations = new AnimationManager(this.root, this.gltf.animations);
  }

  enter() {
    this.root.visible = true;
    if (this.entered) return;
    this.entered = true;
    this.introLeft = this.animations!.play('intro', { once: true });
    this.animations!.play('loop');
  }

  suspend() {
    this.root.visible = false;
    this.animations?.setPaused(true);
  }

  resume() {
    this.root.visible = true;
    this.animations?.setPaused(false);
  }

  update(dt: number, time: number) {
    if (!this.root?.visible) return;
    this.animations?.update(dt);

    if (this.introLeft > 0) {
      this.introLeft -= dt;
      if (this.introLeft <= 0) this.hotspots?.show();
    }
    this.hotspots?.update(dt, time);

    const u = this.highlight;
    u.uWheelInverse.value.copy(this.wheel!.matrixWorld).invert();
    u.uHighlight.value += (this.highlightTarget - u.uHighlight.value) * Math.min(1, dt * 9);
  }

  select(raycaster: Raycaster): HotspotConfig | null {
    const picked = this.hotspots?.pick(raycaster) ?? null;
    if (picked) {
      this.highlight.uBand.value.fromArray(picked.band);
      this.highlightTarget = 1.15;
    } else {
      this.highlightTarget = 0;
    }
    return picked;
  }

  usePlacement(surface: SurfaceKind) {
    // These layers exist to replace and light the print, which isn't there in the room.
    this.require('CleanPatch').visible = false;
    this.require('Glow').visible = false;
    this.root.traverse((node) => {
      if (node.name.startsWith('Streak_')) node.visible = false;
    });
    const shadow = this.require('ContactShadow');
    if (surface === 'floor') {
      // Authored flat against the poster. On the floor it has to lie under the tread instead.
      const source = shadow.getObjectByProperty('isMesh', true) as Mesh;
      const floorShadow = new Mesh(source.geometry, source.material);
      floorShadow.renderOrder = source.renderOrder;
      floorShadow.rotation.x = -Math.PI / 2;
      // Authored to spread across a poster, which at life size would darken most of the room.
      floorShadow.scale.setScalar(0.3);
      floorShadow.position.fromArray(this.placement.contactPoint('floor'));
      floorShadow.position.y += 0.001;
      this.root.add(floorShadow);
      shadow.visible = false;
    }
  }

  dispose() {
    this.animations?.dispose();
    this.hotspots?.dispose();
    if (this.root) {
      disposeObject(this.root);
      this.root.removeFromParent();
    }
    this.gltf = null;
  }

  private require(name: string) {
    const node = this.root.getObjectByName(name);
    if (!node) throw new Error(`Model is missing the "${name}" node`);
    return node;
  }
}

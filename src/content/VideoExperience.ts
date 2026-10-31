import {
  Color,
  DoubleSide,
  LinearFilter,
  Mesh,
  NoColorSpace,
  PlaneGeometry,
  ShaderMaterial,
  VideoTexture,
} from 'three';
import type { ExperienceConfig, HotspotConfig } from '../config/experiences';
import posterVert from '../shaders/livingPoster.vert.glsl?raw';
import posterFrag from '../shaders/livingPoster.frag.glsl?raw';
import type { ContentVideo } from '../services/ContentVideo';
import type { Experience } from './Experience';

const REVEAL_SECONDS = 1.1;
const FADE_SECONDS = 0.2;

/** A looping video registered 1:1 over its printed poster, so the print itself appears to move. */
export class VideoExperience implements Experience {
  readonly root: Mesh;
  readonly placement = null;

  private readonly material: ShaderMaterial;
  private texture: VideoTexture | null = null;
  private reveal = 0;
  private revealing = false;
  private opacity = 0;
  private targetOpacity = 0;

  constructor(
    private readonly config: ExperienceConfig,
    private readonly video: ContentVideo,
  ) {
    const [w, h] = config.targetSize;
    this.material = new ShaderMaterial({
      vertexShader: posterVert,
      fragmentShader: posterFrag,
      transparent: true,
      depthWrite: false,
      toneMapped: false, // Must stay as close as possible to the print underneath it.
      side: DoubleSide,
      uniforms: {
        map: { value: null },
        reveal: { value: 0 },
        opacity: { value: 0 },
        feather: { value: 0.012 },
        aspect: { value: w / h },
        frontColor: { value: new Color(1, 1, 1) },
      },
    });
    this.root = new Mesh(new PlaneGeometry(1, h / w), this.material);
    this.root.visible = false;
  }

  async load(onProgress?: (fraction: number) => void) {
    await this.video.load(this.config.content, onProgress);
    this.texture = new VideoTexture(this.video.element);
    this.texture.colorSpace = NoColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.material.uniforms.map.value = this.texture;
  }

  enter() {
    this.reveal = 0;
    this.revealing = true;
    this.targetOpacity = 1;
    this.root.visible = true;
    this.video.play();
  }

  suspend() {
    this.targetOpacity = 0;
    this.video.pause();
  }

  resume() {
    this.targetOpacity = 1;
    this.root.visible = true;
    this.video.play();
  }

  update(dt: number) {
    if (this.revealing) {
      this.reveal = Math.min(1, this.reveal + dt / REVEAL_SECONDS);
      if (this.reveal === 1) this.revealing = false;
      this.material.uniforms.reveal.value = this.reveal;
    }
    if (this.opacity !== this.targetOpacity) {
      const step = dt / FADE_SECONDS;
      this.opacity =
        this.targetOpacity > this.opacity
          ? Math.min(this.targetOpacity, this.opacity + step)
          : Math.max(this.targetOpacity, this.opacity - step);
      this.material.uniforms.opacity.value = this.opacity;
      if (this.opacity === 0) this.root.visible = false;
    }
  }

  select(): HotspotConfig | null {
    return null;
  }

  usePlacement() {
    // Registered to a print: there is nothing to place in the room.
  }

  dispose() {
    this.video.release();
    this.texture?.dispose();
    this.material.dispose();
    this.root.geometry.dispose();
    this.root.removeFromParent();
  }
}

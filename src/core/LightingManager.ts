import { AmbientLight, DirectionalLight, Group, PMREMGenerator, type Scene, type Texture, type WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * Image-based lighting for PBR content. The project ships no HDRI, so reflections come from a
 * procedural studio room, which keeps the rim and chrome response without another download.
 */
export class LightingManager {
  private readonly rig = new Group();
  private environment: Texture | null = null;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
  ) {}

  /** Generated on demand because video experiences don't need it. */
  ensureStudioLighting() {
    if (this.environment) return;
    const pmrem = new PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();

    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.8;

    // Key from the upper left, matching the shading of the tyre printed on the poster.
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(-1, 1.4, 1.6);
    const fill = new AmbientLight(0x9db8ff, 0.25);
    this.rig.add(key, fill);
    this.scene.add(this.rig);
  }

  dispose() {
    this.scene.remove(this.rig);
    this.scene.environment = null;
    this.environment?.dispose();
    this.environment = null;
  }
}

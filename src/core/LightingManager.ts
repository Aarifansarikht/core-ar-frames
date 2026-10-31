import { AmbientLight, DirectionalLight, Group, PMREMGenerator, type Scene, type Texture, type WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { XREstimatedLight } from 'three/addons/webxr/XREstimatedLight.js';

/**
 * Image-based lighting for PBR content. The project ships no HDRI, so reflections come from a
 * procedural studio room, which keeps the rim and chrome response without another download. In
 * WebXR the environment is replaced with ARCore's light estimate whenever the browser provides it.
 */
export class LightingManager {
  private readonly rig = new Group();
  private environment: Texture | null = null;
  private estimated: XREstimatedLight | null = null;

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

  /** Uses ARCore's estimate of the real room's light, if the session granted light-estimation. */
  enableXREstimation() {
    if (this.estimated) return;
    const estimated = new XREstimatedLight(this.renderer);
    estimated.addEventListener('estimationstart', () => {
      this.scene.add(estimated);
      this.scene.remove(this.rig);
      if (estimated.environment) this.scene.environment = estimated.environment;
    });
    estimated.addEventListener('estimationend', () => {
      this.scene.remove(estimated);
      this.scene.add(this.rig);
      this.scene.environment = this.environment;
    });
    this.estimated = estimated;
  }

  dispose() {
    this.scene.remove(this.rig);
    this.scene.environment = null;
    this.environment?.dispose();
    this.environment = null;
    this.estimated = null;
  }
}

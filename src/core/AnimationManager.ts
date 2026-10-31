import { AnimationClip, AnimationMixer, LoopOnce, LoopRepeat, type Object3D } from 'three';

/** Plays authored GLB clips. Pausing keeps the clip position, so a tracking loss doesn't restart them. */
export class AnimationManager {
  private readonly mixer: AnimationMixer;
  private paused = false;

  constructor(
    private readonly root: Object3D,
    private readonly clips: AnimationClip[],
  ) {
    this.mixer = new AnimationMixer(root);
  }

  /** Plays a clip by name. A `once` clip holds its final pose. Returns the clip's length in seconds. */
  play(name: string, { once = false }: { once?: boolean } = {}) {
    const clip = AnimationClip.findByName(this.clips, name);
    if (!clip) throw new Error(`Animation "${name}" not found in model`);
    const action = this.mixer.clipAction(clip);
    action.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Infinity);
    action.clampWhenFinished = once;
    action.play();
    return clip.duration;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }

  update(dt: number) {
    if (!this.paused) this.mixer.update(dt);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.clips.forEach((clip) => this.mixer.uncacheClip(clip));
    this.mixer.uncacheRoot(this.root);
  }
}

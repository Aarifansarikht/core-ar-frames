import { useEffect, useRef, useState } from 'react';
import { ACESFilmicToneMapping, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Scene, SRGBColorSpace, TextureLoader, Timer, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { applyContentAdjustment, type ContentAdjustment } from '../config/tracking';
import type { ExperienceConfig } from '../config/experiences';
import type { Experience } from '../content/Experience';
import { TyreExperience } from '../content/TyreExperience';
import { VideoExperience } from '../content/VideoExperience';
import { LightingManager } from '../core/LightingManager';
import { ModelManager } from '../core/ModelManager';
import { ContentVideo } from '../services/ContentVideo';

/** The real content, on a picture of its poster, as it would appear when tracked. */
export function ContentPreview({ config, content }: { config: ExperienceConfig; content: ContentAdjustment }) {
  const host = useRef<HTMLDivElement>(null);
  const experience = useRef<Experience | null>(null);
  const latest = useRef(content);
  const [failed, setFailed] = useState(false);

  latest.current = content;
  useEffect(() => {
    if (experience.current) applyContentAdjustment(experience.current.root, content);
  }, [content]);

  useEffect(() => {
    const element = host.current!;
    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    element.appendChild(renderer.domElement);

    const scene = new Scene();
    const camera = new PerspectiveCamera(40, 1, 0.01, 50);
    camera.position.set(0, 0, 1.9);
    const controls = new OrbitControls(camera, renderer.domElement);

    const [w, h] = config.targetSize;
    const texture = new TextureLoader().load(config.target);
    texture.colorSpace = SRGBColorSpace;
    const posterMaterial = new MeshBasicMaterial({ map: texture, toneMapped: false });
    const poster = new Mesh(new PlaneGeometry(1, h / w), posterMaterial);
    poster.position.z = -0.001; // Just behind content, which is authored to sit exactly on the print.
    scene.add(poster);

    const lighting = new LightingManager(renderer, scene);
    const models = new ModelManager(renderer);
    const loaded: Experience = config.kind === 'model' ? new TyreExperience(config, models, lighting) : new VideoExperience(config, new ContentVideo());
    let disposed = false;
    void loaded
      .load()
      .then(() => {
        if (disposed) {
          loaded.dispose();
          return;
        }
        experience.current = loaded;
        applyContentAdjustment(loaded.root, latest.current);
        scene.add(loaded.root);
        loaded.enter();
      })
      .catch((err) => {
        console.error('[Admin] Content did not load:', err);
        setFailed(true);
      });

    const resize = () => {
      const { clientWidth, clientHeight } = element;
      if (!clientWidth || !clientHeight) return;
      renderer.setSize(clientWidth, clientHeight);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();

    const timer = new Timer();
    timer.connect(document);
    renderer.setAnimationLoop(() => {
      timer.update();
      experience.current?.update(Math.min(timer.getDelta(), 0.1), timer.getElapsed());
      controls.update();
      renderer.render(scene, camera);
    });

    return () => {
      disposed = true;
      renderer.setAnimationLoop(null);
      observer.disconnect();
      timer.dispose();
      controls.dispose();
      if (experience.current) experience.current.dispose();
      experience.current = null;
      lighting.dispose();
      models.dispose();
      texture.dispose();
      posterMaterial.dispose();
      poster.geometry.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [config]);

  return (
    <div ref={host} className="admin__preview" data-testid="content-preview">
      {failed && <p className="admin__rating admin__rating--bad">Content didn’t load.</p>}
    </div>
  );
}

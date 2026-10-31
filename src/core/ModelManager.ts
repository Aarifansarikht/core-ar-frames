import { Material, Mesh, Object3D, Texture, type WebGLRenderer } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/**
 * Loads GLB/GLTF content. Meshopt is bundled because the shipped tyre uses it; the Draco and Basis
 * decoders are emitted as separate files by the build and only downloaded if a model needs them.
 */
export class ModelManager {
  private readonly loader: GLTFLoader;
  private readonly draco: DRACOLoader;
  private readonly ktx2: KTX2Loader;

  constructor(renderer: WebGLRenderer) {
    this.draco = new DRACOLoader();
    this.ktx2 = new KTX2Loader().detectSupport(renderer);
    this.loader = new GLTFLoader()
      .setDRACOLoader(this.draco)
      .setKTX2Loader(this.ktx2)
      .setMeshoptDecoder(MeshoptDecoder);
  }

  load(url: string, onProgress?: (fraction: number) => void): Promise<GLTF> {
    return this.loader.loadAsync(url, (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    });
  }

  dispose() {
    this.draco.dispose();
    this.ktx2.dispose();
  }
}

/** Frees every geometry, material and texture under `root`. */
export function disposeObject(root: Object3D) {
  root.traverse((node) => {
    const mesh = node as Mesh;
    mesh.geometry?.dispose();
    const materials = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const material of materials) disposeMaterial(material);
  });
}

function disposeMaterial(material: Material) {
  for (const value of Object.values(material)) {
    if (value instanceof Texture) value.dispose();
  }
  material.dispose();
}

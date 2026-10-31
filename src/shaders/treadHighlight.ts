import { Color, Matrix4, Vector2, type IUniform, type MeshStandardMaterial } from 'three';

export interface TreadHighlightUniforms {
  uWheelInverse: IUniform<Matrix4>;
  uBand: IUniform<Vector2>;
  uHighlight: IUniform<number>;
  uHighlightColor: IUniform<Color>;
}

export const createTreadHighlightUniforms = (color: string): TreadHighlightUniforms => ({
  uWheelInverse: { value: new Matrix4() },
  uBand: { value: new Vector2() },
  uHighlight: { value: 0 },
  uHighlightColor: { value: new Color(color) },
});

/**
 * Lights a band of the tread (the reference's red zone highlight) without touching the authored PBR
 * response. Position is taken in Wheel space, so a band stays put on the rotating tyre whichever
 * sub-mesh a fragment belongs to, and every mesh can share the same uniforms.
 */
export function applyTreadHighlight(material: MeshStandardMaterial, uniforms: TreadHighlightUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform mat4 uWheelInverse;
         varying vec3 vWheelPosition;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWheelPosition = (uWheelInverse * modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec2 uBand;
         uniform float uHighlight;
         uniform vec3 uHighlightColor;
         varying vec3 vWheelPosition;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         float axial = abs(vWheelPosition.z);
         float inBand = smoothstep(uBand.x - 0.006, uBand.x + 0.006, axial)
           * (1.0 - smoothstep(uBand.y - 0.006, uBand.y + 0.006, axial));
         float onTread = smoothstep(0.86, 0.92, length(vWheelPosition.xy));
         totalEmissiveRadiance += uHighlightColor * inBand * onTread * uHighlight;`,
      );
  };
  // The uniforms are shared, so one compiled program per lighting state is all that's needed.
  material.customProgramCacheKey = () => 'tread-highlight';
  material.needsUpdate = true;
}

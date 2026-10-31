// Plays a registered video over its printed poster. The edge feather hides sub-pixel registration
// error at the poster's border; the reveal is a soft radial wipe with a light front.
uniform sampler2D map;
uniform float reveal;
uniform float opacity;
uniform float feather;
uniform float aspect;
uniform vec3 frontColor;
varying vec2 vUv;

void main() {
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  float r = length(p) / (0.5 * length(vec2(aspect, 1.0)));

  float radius = reveal * 1.25;
  float wipe = 1.0 - smoothstep(radius - 0.14, radius, r);
  float front = smoothstep(radius - 0.14, radius - 0.03, r) * (1.0 - smoothstep(radius - 0.03, radius, r));
  front *= 1.0 - smoothstep(0.85, 1.0, reveal);

  vec2 edgeDistance = min(vUv, 1.0 - vUv);
  float edge = smoothstep(0.0, feather, edgeDistance.x) * smoothstep(0.0, feather, edgeDistance.y);

  vec3 color = texture2D(map, vUv).rgb + frontColor * front * 0.55;
  gl_FragColor = vec4(color, wipe * edge * opacity);
}

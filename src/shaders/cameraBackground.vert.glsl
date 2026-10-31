uniform vec2 uvScale;
varying vec2 vUv;

void main() {
  vUv = (uv - 0.5) * uvScale + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}

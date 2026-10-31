// Generates camera footage of a poster with a known camera path, so tracking can be measured against
// ground truth. This drives the real tracker through Chrome's fake camera device: no tracking result
// is simulated, only the scene in front of the camera.
//
//   node scripts/make-test-footage.mjs <experience-id> [--fov 64] [--size 720x1280]
//
// Writes .test-output/<id>.y4m and <id>.truth.json. Timeline, 30 fps:
//   0-2s    no poster in view
//   2-7s    held as steady as a hand can (measures jitter and absolute accuracy)
//   7-13s   slow orbit and dolly (measures accuracy in motion)
//   13-16s  fast pan and tilt (measures robustness and lag)
//   16-18s  poster leaves the frame (measures loss detection)
//   18-22s  poster returns (measures recovery)
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const id = args[0] ?? 'ceat-tyre';
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const fovLong = Number(opt('fov', 64));
const [W, H] = opt('size', '720x1280').split('x').map(Number);
const FPS = 30;
const CODE_BITS = 12;
const CODE_BLOCK = 40;
const CODE_HEIGHT = 24;
const DURATION = 22;

const outDir = join(root, '.test-output');
const outName = opt('name', id);
mkdirSync(outDir, { recursive: true });

const targetFile = join(root, 'public', 'assets', 'experiences', id, 'target.jpg');
const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', targetFile], { encoding: 'utf8' });
const [TW, TH] = probe.trim().split(',').map(Number);
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', targetFile, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
if (raw.length !== TW * TH * 3) throw new Error('Unexpected target buffer size');

const focal = Math.max(W, H) / 2 / Math.tan((fovLong * Math.PI) / 360);
const aspect = TH / TW;

const smooth = (a, b, t) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/** Poster pose over time: rotation (radians) and camera-space position of its centre, in poster widths. */
function poseAt(t) {
  const baseDepth = Number(opt('depth', H > W ? 1.5 : 1.15));
  let yaw = 0.06;
  let pitch = -0.04;
  let roll = 0.015;
  let x = 0;
  let y = 0;
  let z = baseDepth;

  // Slow orbit and dolly.
  const slow = smooth(7, 8, t) * (1 - smooth(12, 13, t));
  yaw += slow * 0.42 * Math.sin((t - 7) * 1.05);
  pitch += slow * 0.26 * Math.sin((t - 7) * 0.7);
  z += slow * 0.45 * Math.sin((t - 7) * 0.8);
  x += slow * 0.09 * Math.sin((t - 7) * 0.9);

  // Fast pan and tilt, at the speed of a hand moving a phone around.
  const fast = smooth(13, 13.3, t) * (1 - smooth(15.7, 16, t));
  x += fast * 0.2 * Math.sin((t - 13) * 3.6);
  y += fast * 0.12 * Math.sin((t - 13) * 4.4);
  roll += fast * 0.1 * Math.sin((t - 13) * 3);

  // Enters at 2s, leaves at 16s, returns at 18s, by sliding well out of frame.
  const offscreen = (1 - smooth(1.6, 2, t)) + smooth(16, 16.4, t) * (1 - smooth(18, 18.4, t));
  x += offscreen * 2.6;

  // Hand tremor, always on: the 8-12 Hz physiological band plus slower sway. Amplitudes correspond to
  // a couple of pixels of motion at this distance, what a phone held carefully actually does.
  const w = (hz, phase) => Math.sin(2 * Math.PI * hz * t + phase);
  x += 0.0016 * w(0.9, 0.3) + 0.0007 * w(4.3, 1.1) + 0.0003 * w(9.1, 2.0);
  y += 0.0014 * w(1.3, 1.7) + 0.0006 * w(5.1, 0.4) + 0.0003 * w(10.3, 0.9);
  z += 0.002 * w(0.6, 2.4);
  yaw += 0.004 * w(1.1, 0.7) + 0.0015 * w(6.2, 1.9);
  pitch += 0.0035 * w(0.8, 2.2) + 0.0015 * w(7.4, 0.2);
  roll += 0.002 * w(1.6, 1.2);

  return { yaw, pitch, roll, x, y, z };
}

function rotation({ yaw, pitch, roll }) {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  // Rz(roll) * Rx(pitch) * Ry(yaw)
  return [
    [cr * cy - sr * sp * sy, -sr * cp, cr * sy + sr * sp * cy],
    [sr * cy + cr * sp * sy, cr * cp, sr * sy - cr * sp * cy],
    [-cp * sy, sp, cp * cy],
  ];
}

/** Projects a poster point (x right, y up, width 1) into camera pixels. */
function projector(pose) {
  const R = rotation(pose);
  return (px, py) => {
    const cx = R[0][0] * px + R[0][1] * py + pose.x;
    const cy = R[1][0] * px + R[1][1] * py + pose.y;
    const cz = R[2][0] * px + R[2][1] * py + pose.z;
    return [W / 2 + (focal * cx) / cz, H / 2 - (focal * cy) / cz];
  };
}

/** Inverse homography from camera pixels to target pixels, for backward warping. */
function inverseHomography(pose) {
  const R = rotation(pose);
  // Camera pixel = K [r1 r2 t] (px, py, 1), with image y flipped.
  const A = [
    [focal * R[0][0] + (W / 2) * R[2][0], focal * R[0][1] + (W / 2) * R[2][1], focal * pose.x + (W / 2) * pose.z],
    [-focal * R[1][0] + (H / 2) * R[2][0], -focal * R[1][1] + (H / 2) * R[2][1], -focal * pose.y + (H / 2) * pose.z],
    [R[2][0], R[2][1], pose.z],
  ];
  const [a, b, c] = A[0];
  const [d, e, f] = A[1];
  const [g, h, i] = A[2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

// A plain wall with a soft gradient, like the reference, plus a dark frame around the poster.
const wall = (x, y) => {
  const v = 196 - 26 * Math.abs(x / W - 0.45) - 18 * (y / H);
  return [v + 3, v, v - 4];
};

const ffmpeg = spawn('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
  // Sensor-like softness and noise. Chrome's fake camera needs uncompressed Y4M (its MJPEG path delivers blank frames).
  '-vf', 'gblur=sigma=0.7,noise=alls=5:allf=t',
  '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', join(outDir, `${outName}.y4m`),
], { stdio: ['pipe', 'inherit', 'inherit'] });

const frame = Buffer.alloc(W * H * 3);
const truth = [];
const total = DURATION * FPS;

for (let n = 0; n < total; n++) {
  const t = n / FPS;
  const pose = poseAt(t);
  const inv = inverseHomography(pose);
  const project = projector(pose);
  truth.push({
    t,
    corners: [project(-0.5, aspect / 2), project(0.5, aspect / 2), project(0.5, -aspect / 2), project(-0.5, -aspect / 2)],
  });

  let o = 0;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const u = inv[0][0] * px + inv[0][1] * py + inv[0][2];
      const v = inv[1][0] * px + inv[1][1] * py + inv[1][2];
      const s = inv[2][0] * px + inv[2][1] * py + inv[2][2];
      const nx = u / s;
      const ny = v / s;
      // Poster coordinates: x in [-0.5, 0.5], y in [-aspect/2, aspect/2].
      const tu = (nx + 0.5) * (TW - 1);
      const tv = (aspect / 2 - ny) / aspect * (TH - 1);
      if (tu >= 0 && tv >= 0 && tu < TW - 1 && tv < TH - 1) {
        const x0 = tu | 0;
        const y0 = tv | 0;
        const fx = tu - x0;
        const fy = tv - y0;
        const i00 = (y0 * TW + x0) * 3;
        const i01 = i00 + 3;
        const i10 = i00 + TW * 3;
        const i11 = i10 + 3;
        for (let c = 0; c < 3; c++) {
          const value =
            raw[i00 + c] * (1 - fx) * (1 - fy) + raw[i01 + c] * fx * (1 - fy) + raw[i10 + c] * (1 - fx) * fy + raw[i11 + c] * fx * fy;
          // Printed paper in a room reflects less light than a screen emits.
          frame[o++] = value * 0.93 + 6;
        }
      } else {
        const [r, g, b] = wall(px, py);
        frame[o++] = r;
        frame[o++] = g;
        frame[o++] = b;
      }
    }
  }
  // Frame number as a barcode along the top edge, so each pose can be scored against its exact frame.
  for (let bit = 0; bit < CODE_BITS; bit++) {
    const on = (n >> bit) & 1;
    for (let py = 0; py < CODE_HEIGHT; py++) {
      for (let px = bit * CODE_BLOCK; px < (bit + 1) * CODE_BLOCK; px++) {
        frame.fill(on ? 245 : 10, (py * W + px) * 3, (py * W + px) * 3 + 3);
      }
    }
  }
  if (!ffmpeg.stdin.write(frame)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
  if (n % 90 === 0) console.log(`${id}: ${(t).toFixed(0)}s / ${DURATION}s`);
}
ffmpeg.stdin.end();
await new Promise((r) => ffmpeg.on('close', r));

writeFileSync(join(outDir, `${outName}.truth.json`), JSON.stringify({ id, W, H, FPS, code: { bits: CODE_BITS, block: CODE_BLOCK, height: CODE_HEIGHT }, fovLong, focal, aspect, duration: DURATION, frames: truth }));
console.log(`wrote .test-output/${id}.y4m`, readdirSync(outDir).length, 'files in dir');

// Measures how well each content video lines up with its printed target, by searching scale and offset
// for the best match between their edge maps. Edges rather than colour, because the videos deliberately
// regrade the artwork. Any misalignment here would be a permanent overlay error that no tracker can fix.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIDTH = 480;

const gray = (args, w, h) => {
  const raw = execFileSync('ffmpeg', ['-v', 'error', ...args, '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  return new Float32Array(raw);
};

const edges = (img, w, h) => {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] = Math.hypot(img[i + 1] - img[i - 1], img[i + w] - img[i - w]);
    }
  }
  return out;
};

/** Normalised cross-correlation of `b`, scaled about the centre and shifted, against `a`. */
function ncc(a, b, w, h, scale, dx, dy) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  const cx = w / 2;
  const cy = h / 2;
  const margin = Math.round(w * 0.04);
  for (let y = margin; y < h - margin; y += 1) {
    for (let x = margin; x < w - margin; x += 1) {
      const u = (x - cx - dx) / scale + cx;
      const v = (y - cy - dy) / scale + cy;
      const x0 = u | 0;
      const y0 = v | 0;
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const f = u - x0;
      const g = v - y0;
      const i = y0 * w + x0;
      const q = b[i] * (1 - f) * (1 - g) + b[i + 1] * f * (1 - g) + b[i + w] * (1 - f) * g + b[i + w + 1] * f * g;
      const p = a[y * w + x];
      sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q; n++;
    }
  }
  return (sab - (sa * sb) / n) / Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n));
}

const report = [];
for (const [id, tw, th] of [['basketball', 1480, 2000], ['flower', 2048, 1618], ['jelly', 1520, 2180], ['love', 2048, 2054]]) {
  const height = Math.round((WIDTH * th) / tw);
  const dir = join(root, 'public', 'assets', 'experiences', id);
  const target = edges(gray(['-i', join(dir, 'target.jpg')], WIDTH, height), WIDTH, height);
  const frame = edges(gray(['-ss', '6', '-i', join(dir, 'content.mp4')], WIDTH, height), WIDTH, height);

  const identity = ncc(target, frame, WIDTH, height, 1, 0, 0);
  let best = { score: -1, scale: 1, dx: 0, dy: 0 };
  for (let scale = 0.97; scale <= 1.0301; scale += 0.005) {
    for (let dy = -6; dy <= 6; dy += 1) {
      for (let dx = -6; dx <= 6; dx += 1) {
        const score = ncc(target, frame, WIDTH, height, scale, dx, dy);
        if (score > best.score) best = { score, scale, dx, dy };
      }
    }
  }
  report.push({
    id,
    'score @ identity': +identity.toFixed(3),
    'best score': +best.score.toFixed(3),
    'best scale': +best.scale.toFixed(3),
    'best dx (% width)': +((best.dx / WIDTH) * 100).toFixed(2),
    'best dy (% width)': +((best.dy / WIDTH) * 100).toFixed(2),
  });
}
console.table(report);

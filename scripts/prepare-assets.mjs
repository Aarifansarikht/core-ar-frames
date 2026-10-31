// Copies the supplied assets into public/assets under stable names, leaving the originals in the
// project root untouched. Optimises only what is lossless or visually verified:
//  - GLB: weld + meshopt + WebP. Node names, clips and scene structure are preserved.
//  - MP4: remuxed with +faststart so playback starts before the whole file downloads.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'assets', 'experiences');

const find = (dir, prefix) => {
  const hit = readdirSync(join(root, dir)).find((f) => f.startsWith(prefix));
  if (!hit) throw new Error(`Missing ${prefix}* in ${dir}/`);
  return join(root, dir, hit);
};
const kb = (p) => `${(statSync(p).size / 1024).toFixed(0)} KB`;

async function optimiseGlb(src, dest) {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.encoder': MeshoptEncoder,
    'meshopt.decoder': MeshoptDecoder,
  });
  const doc = await io.read(src);
  await doc.transform(
    dedup(),
    weld(),
    // 1024 still gives the sidewall lettering about one texel per screen pixel at full-screen size, and
    // the decal drops from 22 MB of GPU memory to 5.6 MB.
    textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 90, effort: 100, resize: [1024, 1024] }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await io.write(dest, doc);
}

function faststart(src, dest) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0', '-c', 'copy', '-movflags', '+faststart', dest]);
}

const experiences = [
  { id: 'ceat-tyre', glb: true, logo: true },
  { id: 'basketball' },
  { id: 'flower' },
  { id: 'jelly' },
  { id: 'love' },
];

for (const exp of experiences) {
  const dir = join(out, exp.id);
  mkdirSync(dir, { recursive: true });

  const target = find(exp.id, 'target-');
  copyFileSync(target, join(dir, 'target.jpg'));
  // Lightweight preview for the welcome screen and preloader; not used for tracking.
  await sharp(target).resize({ width: 480 }).jpeg({ quality: 78, mozjpeg: true }).toFile(join(dir, 'thumb.jpg'));

  const src = find(exp.id, 'content-');
  if (exp.glb) {
    const dest = join(dir, 'content.glb');
    await optimiseGlb(src, dest);
    console.log(`${exp.id}: glb ${kb(src)} -> ${kb(dest)}`);
  } else {
    const dest = join(dir, 'content.mp4');
    faststart(src, dest);
    console.log(`${exp.id}: mp4 ${kb(dest)} (remuxed, not re-encoded)`);
  }
  if (exp.logo) copyFileSync(find(exp.id, 'logo-'), join(dir, 'logo.png'));
}

// Hero for the branded preloader, cropped from the supplied poster (the reference's tyre close-up).
await sharp(find('ceat-tyre', 'target-'))
  .extract({ left: 1080, top: 220, width: 560, height: 640 })
  .jpeg({ quality: 84, mozjpeg: true })
  .toFile(join(out, 'ceat-tyre', 'hero.jpg'));
console.log('assets ready');

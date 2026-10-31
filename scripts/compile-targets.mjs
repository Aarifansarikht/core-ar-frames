// Prepares each poster for the 8th Wall engine, in the same format as @8thwall/image-target-cli, which
// only runs interactively. The engine tracks a 3:4 crop, so landscape posters are turned on their side
// and the largest centred 3:4 area is used.
//   <id>.json             what the engine is given, including the crop
//   <id>_luminance.jpg    the 480 x 640 greyscale image that it extracts features from
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ids = ['ceat-tyre', 'basketball', 'flower', 'jelly', 'love'];
const outDir = join(root, 'public', 'assets', 'targets');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const id of ids) {
  const source = join(root, 'public', 'assets', 'experiences', id, 'target.jpg');
  const { width: w, height: h } = await sharp(source).metadata();
  const isRotated = w > h;
  const [width, height] = isRotated ? [h, w] : [w, h];

  // The same rounding as the CLI's default crop.
  const crop = width / 3 > height / 4 ? { width: Math.round((height * 3) / 4), height } : { width, height: Math.round((width * 4) / 3) };
  const left = Math.round((width - crop.width) / 2);
  const top = Math.round((height - crop.height) / 2);

  const upright = await sharp(source).rotate(isRotated ? 90 : 0).toBuffer();
  const luminance = `${id}_luminance.jpg`;
  await sharp(upright)
    .extract({ left, top, ...crop })
    .resize({ width: 480, height: 640 })
    .grayscale()
    .jpeg({ quality: 90 })
    .toFile(join(outDir, luminance));

  const data = {
    imagePath: `assets/targets/${luminance}`,
    metadata: null,
    name: id,
    type: 'PLANAR',
    properties: { left, top, ...crop, isRotated, originalWidth: width, originalHeight: height },
  };
  writeFileSync(join(outDir, `${id}.json`), `${JSON.stringify(data, null, 2)}\n`);
  const covered = (crop.width * crop.height) / (width * height);
  console.log(`${id}  ${isRotated ? 'rotated, ' : ''}crop covers ${(covered * 100).toFixed(0)}% of the poster`);
}

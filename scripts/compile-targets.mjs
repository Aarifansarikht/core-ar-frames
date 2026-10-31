// Compiles each poster into what the tracker recognises it by: ORB features spread across the whole
// image, taken at several sizes, because ORB only matches features at about the same scale. Positions are in the content frame: poster width 1, centred, +Y up.
//   <id>.target    u32 count, f32 aspect (height / width), u32 image width, u32 image height,
//                  f32 x y per feature, 32 bytes of descriptor per feature, then the grey image, for refining
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ids = ['ceat-tyre', 'basketball', 'flower', 'jelly', 'love'];
const outDir = join(root, 'public', 'assets', 'targets');
const LONG_SIDES = [800, 400, 200];
const FEATURES_PER_SIZE = 350;
const GRID = 10;
const IMAGE_LONG_SIDE = 480;
/** The tracker's own setting, so that dark posters give features to match. */
const FAST_THRESHOLD = 10;
const DESCRIPTOR_BYTES = 32;

const cvModule = require('@techstark/opencv-js');
const cv = cvModule instanceof Promise ? await cvModule : cvModule;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const id of ids) {
  const source = join(root, 'public', 'assets', 'experiences', id, 'target.jpg');
  const { width: w0, height: h0 } = await sharp(source).metadata();
  const points = [];
  const bytes = [];

  for (const longSide of LONG_SIDES) {
    const scale = longSide / Math.max(w0, h0);
    const width = Math.round(w0 * scale);
    const height = Math.round(h0 * scale);
    const { data } = await sharp(source).resize(width, height).grayscale().raw().toBuffer({ resolveWithObject: true });
    const gray = new cv.Mat(height, width, cv.CV_8UC1);
    gray.data.set(data);
    const orb = new cv.ORB(FEATURES_PER_SIZE * 4);
    orb.setFastThreshold(FAST_THRESHOLD);
    const none = new cv.Mat();
    const keypoints = new cv.KeyPointVector();
    const descriptors = new cv.Mat();
    orb.detectAndCompute(gray, none, keypoints, descriptors);

    // The strongest features in each cell in turn, so that one busy area can't take them all.
    const cells = new Map();
    for (let i = 0; i < keypoints.size(); i += 1) {
      const { pt, response } = keypoints.get(i);
      const cell = Math.floor((pt.x / width) * GRID) + GRID * Math.floor((pt.y / height) * GRID);
      if (!cells.has(cell)) cells.set(cell, []);
      cells.get(cell).push({ i, response, x: pt.x, y: pt.y });
    }
    for (const list of cells.values()) list.sort((p, q) => q.response - p.response);
    const chosen = [];
    for (let round = 0; chosen.length < FEATURES_PER_SIZE; round += 1) {
      let added = false;
      for (const list of cells.values()) {
        if (round < list.length && chosen.length < FEATURES_PER_SIZE) {
          chosen.push(list[round]);
          added = true;
        }
      }
      if (!added) break;
    }
    for (const { i, x, y } of chosen) {
      points.push((x - width / 2) / width, (height / 2 - y) / width);
      bytes.push(descriptors.data.slice(i * DESCRIPTOR_BYTES, (i + 1) * DESCRIPTOR_BYTES));
    }
    for (const object of [gray, orb, none, keypoints, descriptors]) object.delete();
  }

  const count = bytes.length;
  const imageScale = IMAGE_LONG_SIDE / Math.max(w0, h0);
  const imageWidth = Math.round(w0 * imageScale);
  const imageHeight = Math.round(h0 * imageScale);
  const { data: image } = await sharp(source).resize(imageWidth, imageHeight).grayscale().raw().toBuffer({ resolveWithObject: true });

  const descriptorsAt = 16 + count * 8;
  const file = Buffer.alloc(descriptorsAt + count * DESCRIPTOR_BYTES + image.length);
  file.writeUInt32LE(count, 0);
  file.writeFloatLE(h0 / w0, 4);
  file.writeUInt32LE(imageWidth, 8);
  file.writeUInt32LE(imageHeight, 12);
  points.forEach((value, i) => file.writeFloatLE(value, 16 + i * 4));
  bytes.forEach((descriptor, n) => file.set(descriptor, descriptorsAt + n * DESCRIPTOR_BYTES));
  file.set(image, descriptorsAt + count * DESCRIPTOR_BYTES);
  writeFileSync(join(outDir, `${id}.target`), file);
  console.log(`${id}  ${count} features, ${(file.length / 1024).toFixed(0)} KB`);
}
process.exit(0);

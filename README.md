# BAY81 WebAR

Point a phone at a printed poster and it comes alive: a 3D CEAT tyre lifts off its print with light streaks and tappable features, and four artworks play registered video over the print. Built from the supplied assets and modelled on `refrence_video.mp4`.

React, TypeScript, Vite and Three.js, with the **8th Wall engine** tracking posters in the browser. It works on iPhone and Android, with no app, no Chrome flags and no ARCore.

> **Read [Test status](#test-status) and [The engine's licence and future](#the-engines-licence-and-future) before relying on this in production.** This version has not yet been run on a physical phone.

## Quick start

```bash
npm install
npm run build
npm run preview     # http://localhost:4173
```

| Task | Command |
| --- | --- |
| Dev server | `npm run dev`, on port 5173 |
| Test on an Android phone over USB | `adb reverse tcp:5173 tcp:5173`, then open `http://localhost:5173` on the phone |
| Test on a phone over Wi-Fi | `npm run dev:https`, then open the `https://<your-ip>` address and accept the certificate warning |

### Using it on a phone

Open the link in Safari on iPhone or Chrome on Android and tap **Start AR**. Allow the camera when asked, and on iPhone also motion access.

To try it without a print, show a target image full screen on a monitor. The images are in `public/assets/experiences/<id>/target.jpg`.

### URLs

| URL | Behaviour |
| --- | --- |
| `/` | Recognises all five posters |
| `/?t=ceat-tyre` | One poster only, showing its brand. Its content is ready before the poster is found |

Ids are `ceat-tyre`, `basketball`, `flower`, `jelly` and `love`. **QR codes on printed posters should use the deep link.** The print's size doesn't need to be given: content fits the print at any size. `?debug` shows live stats.

## Who can use this

| Platform | Result |
| --- | --- |
| iPhone and iPad, Safari | Poster tracking and floor placement. **Not yet run on a device** |
| Android, Chrome | Poster tracking and floor placement. **Not yet run on a device** |
| Desktop | Shows a message asking the user to open the link on a phone |
| In-app browsers (Facebook, Instagram) | The engine decides. If it refuses, a message asks the user to open Safari or Chrome |

## Deployment

`dist/` is a static site that works from any path.

- **HTTPS is mandatory.** The camera doesn't run otherwise.
- The engine is self-hosted: `npm run dev` and `npm run build` copy it from `node_modules` into `public/external/xr`, which isn't committed. Nothing is fetched from 8th Wall at run time.
- **Keep compression on.** The engine is 6.6 MB, about 2.2 MB gzipped.

## The engine's licence and future

8th Wall's hosted service closed in February 2026. Its engine is now distributed as [`@8thwall/engine-binary`](https://www.npmjs.com/package/@8thwall/engine-binary), which this app hosts itself.

- **Allowed:** free, including client work and branded campaigns, as long as the product's value doesn't come entirely or mainly from the engine. Selling the engine or a toolkit built on it isn't allowed. Read the [licence](https://github.com/8thwall/engine/blob/main/LICENSE) and the [FAQ](https://8thwall.org/docs/migration/faq#distributed-engine-binary-license-and-permitted-use).
- **Credit is required:** the welcome screen carries the notice and links the licence. Keep them.
- **Can be withdrawn:** the licence is revocable, and either side can end it on 5 days' notice. The engine comes as is, with no support and no promise of updates.
- **February 28, 2027:** 8th Wall's docs say self-hosted projects work unchanged until this date, and don't say what happens to the binary afterwards. With the clock set to June 2027 in a browser test, it still ran and recognised all five posters, so no expiry check was seen. That doesn't settle the licence question. This is a business decision to review before then.
- **The way out:** posters don't need the binary. [`@8thwall/engine`](https://www.npmjs.com/package/@8thwall/engine) is MIT-licensed and includes image targets but not world tracking, so content would no longer hold its place out of view, and floor placement would go. It is still a pre-release. It has not been tried here.

## How tracking works

```
ARManager (state machine, React store)        <- UI subscribes here
  └─ ARRuntime (lazy loaded; one per session, disposed as a unit)
       ├─ TrackingManager      found / lost / recovered
       │    └─ TrackingAdapter
       │         └─ EightWallAdapter   the engine: camera, image targets, world tracking
       ├─ SceneManager         renderer, drawing over the camera in the engine's GL context
       ├─ LightingManager      PBR environment
       └─ Experience           TyreExperience | VideoExperience
            └─ ModelManager, AnimationManager, Hotspots, GLSL shaders
```

- **Frames:** the engine runs the loop. Each frame it tracks, draws the camera image, then calls the app to draw content on top in the same GL context.
- **Recognition:** the engine's image targets, built from a 480 x 640 greyscale crop of each poster.
- **Turning away and back:** the engine's world tracking holds the poster's place, so content stays put and is already there on return.
- **Moved posters:** a poster seen in a new place moves the content there straight away.
- **Several posters:** each poster's content stays loaded after first use, and the others load in the background, so a switch needs only a recognition.
- **Lost state:** shows only if the poster is out of view and the engine has also lost track of the room.
- **Room placement:** the middle of the view is projected onto a floor assumed to be 1.6 m below the phone's starting position. There's no wall placement, and the tyre sits on that assumed floor rather than a detected surface.
- **Content frame:** the poster is width 1, centred, +Y up, +Z out. The GLB was authored in this frame.

### Performance choices

Render scale by device tier and frame rate, and no blur behind the HUD in AR. There's no estimate of the room's light: content uses a procedural studio environment everywhere.

### Assets

Originals in the project root are untouched. `npm run assets` regenerates `public/assets`:

- **GLB:** 2146 KB to 473 KB with meshopt and WebP. Named nodes and animation clips were checked and preserved.
- **KTX2 is not used.** `ModelManager` supports KTX2 and Draco for future models, and those decoders only download if a model needs them.
- **No HDRI was supplied**, so reflections come from a procedural studio environment.
- **Videos** are remuxed for fast start and not re-encoded. Measured alignment to their prints is within 0.5% scale and 0.2% offset (`npm run test:registration`).

### Adding a poster

1. Add a folder containing `target-*.jpg` and `content-*.mp4` or `.glb`, and list it in `scripts/prepare-assets.mjs`.
2. Add an entry in `src/config/experiences.ts`.
3. Add the id to `scripts/compile-targets.mjs`.
4. Run `npm run assets && npm run targets`.

The engine only tracks a 3:4 area. `npm run targets` uses the largest centred one, turning landscape posters on their side, and prints how much of each poster that covers. The rest can leave the frame without losing tracking, but has no features to be recognised by. Good targets have detail spread across that area, high contrast, and no large repeating texture.

| Poster | Area the engine tracks |
| --- | --- |
| `basketball` | 99% |
| `flower` | 95% |
| `jelly` | 93% |
| `love` | 75% |
| `ceat-tyre` | 74% |

## Test status

### Verified

- `npm run build` passes.
- `npm run test:ui` passes 53 of 53 in desktop Chrome, with **the real engine looking at a simulated camera**: a drawn poster fed through `getUserMedia`, with steady motion sensors. It covers all phases, hotspot taps, room placement, denied permissions, missing assets, closing and retry, plus an iPhone user agent and motion prompt.

| Measured on a desktop GPU, with a sharp, frontal image | Result |
| --- | --- |
| Recognition after a poster appears | 0.15 to 0.6 s |
| Content width against the print, all five posters | Within 0.2% |
| Content centre against the print, including off-centre | Within about 1.3 px on a 412 px wide screen |

**These are best-case figures and not what a phone will show.** The image has no blur, glare or perspective, the camera doesn't move, and the GPU is far faster than a phone's.

### Not verified

- **Anything on a real phone or iPhone:** this version hasn't run on one, so frame rate, recognition in real light, heat and battery are unmeasured. An iPhone user agent in desktop Chrome is not Safari.
- **World tracking on real movement.** The simulated camera doesn't move, so how well content holds its place when turning away is the engine's claim, not something measured here.
- **Floor placement in a real room.** The test points a simulated camera downwards.
- **Real-world size of the placed tyre.** It relies on the assumed 1.6 m floor, so it will look too big or small if the phone is held much higher or lower.
- **The tier settings**, which are estimates until tuned on a phone.

### Running the tests

```bash
npm run build
npm run test:ui                        # desktop, real engine, simulated camera
npm run test:registration              # video-to-print alignment
npm run test:device -- ceat-tyre       # USB Android phone
```

`test:device` is the real test. While it runs, lock the poster, turn away and point back a few times. It reports the time to first lock, engine frame rate and a timeline of states to `.test-output/report-device.json`.

## Known limitations

- **CEAT and Love posters** are tracked on about three-quarters of their area, so a view of only their outer edges won't be recognised.
- **Love poster.** Its dense gold speckle made it the weakest poster with earlier trackers. How it does here is unknown until tested.
- **Download:** about 2.2 MB of gzipped engine before **Start AR** can be tapped on a slow connection.
- **WebGL context loss restarts the experience** through a Retry prompt rather than resuming silently.
- **Engine console warnings.** The engine logs a WebGL `useProgram` warning at startup, with or without this app's scene. It had no visible effect in testing.
- **Real-time shadows are not used.** The GLB's painted contact shadow is cheaper on phones and matches the original art.
- **No audio.** The supplied content videos have no audio tracks.

## Licences

XR Engine © 2026 Niantic Spatial, Inc., under its [XR Engine License Agreement](https://github.com/8thwall/engine/blob/main/LICENSE), provided as is without warranties. Three.js (MIT), React (MIT), Inter (OFL). Check the rights for the supplied artwork and brand assets separately before publishing.

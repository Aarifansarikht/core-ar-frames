# BAY81 WebAR

Point an Android phone at a printed poster and it comes alive: a 3D CEAT tyre lifts off its print with light streaks and tappable features, and four artworks play registered video over the print. Built from the supplied assets and modelled on `refrence_video.mp4`.

React, TypeScript, Vite and Three.js, with **ARCore through WebXR holding posters in the world**. No paid SDKs and no Chrome flags.

> **Read [Test status](#test-status) and [Who can use this](#who-can-use-this) before relying on this in production.** This version has not yet been run on a physical phone.

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

Use an [ARCore-supported Android phone](https://developers.google.com/ar/devices) with Chrome and Google Play Services for AR up to date, open the app and tap **Start AR**. No Chrome settings are needed.

To try it without a print, show a target image full screen on a monitor. The images are in `public/assets/experiences/<id>/target.jpg`.

### URLs

| URL | Behaviour |
| --- | --- |
| `/` | Recognises all five posters |
| `/?t=ceat-tyre` | One poster only, showing its brand. Its content is ready before the session starts |
| `/?t=ceat-tyre&w=0.42` | Also gives the print's real width in metres |

Ids are `ceat-tyre`, `basketball`, `flower`, `jelly` and `love`. **QR codes on printed posters should use the deep link, with `w` set to the real print width.** Without `w`, the app starts from an assumed 0.6 m and measures the real width as the camera moves. `?debug` shows live stats, including recognition time and measured width.

## Who can use this

| Platform | Result |
| --- | --- |
| Android Chrome, ARCore phone | Poster tracking and room placement, with no setup. **Not yet run on a phone** |
| Android, no ARCore | Shows the unsupported screen |
| **iPhone and iPad** | **No AR.** Shows a message saying ARCore isn't available. ARCore does not exist on iOS |
| Desktop | Shows the unsupported screen |
| In-app browsers (Facebook, Instagram) | Shows a message asking the user to open Chrome |

## Deployment

`dist/` is a static site that works from any path.

- **HTTPS is mandatory.** WebXR doesn't run otherwise.
- Serve `.wasm` as `application/wasm`.
- **Compress `.mind` files.** They shrink by roughly half with gzip, and many hosts skip unknown file types by default.

## How tracking works

```
ARManager (state machine, React store)        <- UI subscribes here
  └─ ARRuntime (lazy loaded; one per session, disposed as a unit)
       ├─ TrackingManager      found / lost / recovered
       │    └─ TrackingAdapter
       │         └─ WebXRAdapter    ARCore: image tracking, hit testing, anchors
       ├─ SceneManager         renderer, the one animation loop
       ├─ LightingManager      PBR environment, ARCore light estimation
       └─ Experience           TyreExperience | VideoExperience
            └─ ModelManager, AnimationManager, Hotspots, GLSL shaders
```

Chrome does not let a website switch on `chrome://flags`, and ARCore's own image tracking sits behind one. So the app picks the path automatically, and the user never sees the difference:

| | Recognising a poster | Holding it in place |
| --- | --- | --- |
| **Every ARCore phone** | The app's recogniser, reading ARCore's camera image (WebXR `camera-access`) | ARCore's world tracking |
| **Phones with the flag on** | ARCore's own image tracking | ARCore |

The recogniser reuses MindAR's feature matching and pose solving. **MindAR's frame-by-frame tracker and its camera handling are not used.**

- **Recognition:** runs in a worker, so it can't delay rendering, and the camera image is read back without stalling the GPU. It searches the whole image, where MindAR's default looks at one small square per frame and takes 9 frames to cover the view.
- **Holding:** between sightings a poster is a fixed place in ARCore's world, so camera movement is handled by ARCore at its full frame rate, with no smoothing lag.
- **Sightings:** each one uses the camera pose of its own frame, so recognition time doesn't shift content. Several sightings are combined (`PosterFusion`), which steadies the pose and corrects ARCore's drift.
- **Real width:** one camera image can't tell a small poster up close from a large one far away. ARCore knows how far the camera moved, so a few sightings from different places reveal the true width. `?w=` skips that.
- **Turning away and back:** content keeps its place in the world, so it is already there on return.
- **Moved posters:** two sightings in a row that disagree with the stored place move the content to the new one.
- **Several posters:** each poster's content stays loaded after first use, and the others load in the background, so a switch needs only a recognition.
- **Lost state:** shows only if ARCore loses its own tracking of the world.
- **Content frame:** the poster is width 1, centred, +Y up, +Z out. The GLB was authored in this frame.

### Performance choices

No MSAA, render scale by device tier, no blur behind the HUD in AR, and no ARCore light estimation on posters, since its reflection map is rebuilt repeatedly. Room placement keeps light estimation. Chrome's AR camera commonly runs near 30 fps, which an app can't raise.

### Assets

Originals in the project root are untouched. `npm run assets` regenerates `public/assets`:

- **GLB:** 2146 KB to 473 KB with meshopt and WebP. Named nodes and animation clips were checked and preserved.
- **KTX2 is not used.** `ModelManager` supports KTX2 and Draco for future models, and those decoders only download if a model needs them.
- **No HDRI was supplied**, so reflections come from a procedural studio environment until ARCore's light estimate replaces it.
- **Videos** are remuxed for fast start and not re-encoded. Measured alignment to their prints is within 0.5% scale and 0.2% offset (`npm run test:registration`).

### Adding a poster

1. Add a folder containing `target-*.jpg` and `content-*.mp4` or `.glb`, and list it in `scripts/prepare-assets.mjs`.
2. Add an entry in `src/config/experiences.ts`.
3. Add the id to `scripts/compile-targets.mjs`, in the same order.
4. Run `npm run assets && npm run targets`.

Good targets have detail spread across the whole image, high contrast, and no large repeating texture. After replacing or adding target images, run `npm run targets` to rebuild the recogniser's data in `public/assets/targets`.

## Test status

### Verified

- `npm run build` passes.
- `npm run test:ui` passes 50 of 50 in desktop Chrome, with a **scripted stand-in for ARCore**. It covers all phases, hotspot taps, room placement, failed sessions, missing assets, closing and retry.
- In the same suite, **the real recogniser** runs in its worker on a drawn camera image, with a known camera path and an upright or upside-down texture:

| Measured on a desktop GPU, with a sharp, frontal image | Result |
| --- | --- |
| First lock, including start-up | 0.5 to 1.4 s |
| One recognition | About 22 ms |
| Switch to another poster | 0.3 s |
| Back to a poster already seen | 0.2 s |
| Poster position after moving the camera | Within 0.1 cm |
| Width measured from movement (truly 40 cm, assumed 60 cm) | 40.0 to 40.1 cm |

**These are best-case figures and not what a phone will show.** The image has no blur, glare or perspective, the camera path is exact, and the GPU is far faster than a phone's. Expect recognition to take several times longer on a phone.

### Not verified

- **Anything on a real phone:** this version has not run on one, so lag, recognition speed and accuracy are unmeasured.
- **Chrome's real camera image.** Its orientation is detected at run time, and the test covers both cases. Its alignment with the view follows the WebXR specification, and would show up as content offset from the print.
- **ARCore's real behaviour:** how well it holds position, and how long it takes to start tracking the world when a session opens. It usually needs the phone to move slightly first.
- **Phone heat and battery** with recognition running a few times per second.
- **The tier settings**, which are estimates until tuned on a phone.

### Running the tests

```bash
npm run build
npm run test:ui                        # desktop, with the ARCore stand-in
npm run test:registration              # video-to-print alignment
npm run test:device -- ceat-tyre       # USB Android phone
```

`test:device` is the real test. While it runs, lock the poster, turn away and point back a few times. It reports the time to first lock, recognition time and a timeline of states to `.test-output/report-device.json`.

## Known limitations

- **Needs an ARCore phone and Chrome.** There is no iPhone support.
- **Love poster.** Its dense gold speckle made it the weakest poster before this design. Whether it does better now is unknown until tested.
- **First sight of a poster** can have the wrong size for a moment if `w` isn't set. It looks right from where it was first seen, and settles as the camera moves.
- **Recogniser download:** about 1.2 MB of script plus the poster data (`all.mind`, 4.6 MB, about 2.4 MB gzipped). Deep links load a much smaller file.
- **WebGL context loss restarts the experience** through a Retry prompt rather than resuming silently.
- **Real-time shadows are not used.** The GLB's painted contact shadow is cheaper on phones and matches the original art.
- **No audio.** The supplied content videos have no audio tracks.

## Licences

MindAR (MIT), TensorFlow.js (Apache-2.0), Three.js (MIT), React (MIT), Inter (OFL). Check the rights for the supplied artwork and brand assets separately before publishing.

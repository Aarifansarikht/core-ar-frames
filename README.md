# BAY81 WebAR

Point a phone at a printed poster and it comes alive: a 3D CEAT tyre lifts off its print with light streaks and tappable features, and four artworks play registered video over the print. Built from the supplied assets and modelled on `refrence_video.mp4`.

React, TypeScript, Vite and Three.js on one renderer, with swappable tracking engines. No paid SDKs.

> **Read [Test status](#test-status) before relying on this in production.** Tracking is measured on desktop Chrome with generated footage. It has not yet run on a physical phone or against a printed poster.

## Quick start

```bash
npm install
npm run dev         # http://localhost:5173
```

| Task | Command |
| --- | --- |
| Production build | `npm run build`, output in `dist/` |
| Preview the build | `npm run preview` |
| Test on a phone over Wi-Fi | `npm run dev:https`, then open the `https://<your-ip>` address and accept the certificate warning |
| Test on an Android phone over USB | `adb reverse tcp:5173 tcp:5173`, then open `http://localhost:5173` on the phone |

### Trying it without a print

Show a target image full screen on a monitor and point the phone at it. The images are in `public/assets/experiences/<id>/target.jpg`.

### URLs

| URL | Behaviour |
| --- | --- |
| `/` | Welcome screen. Recognises all five posters, loading a 4.6 MB target file |
| `/?t=ceat-tyre` | Deep link for one poster. Loads a much smaller target file, shows that brand, and starts faster |

Ids are `ceat-tyre`, `basketball`, `flower`, `jelly` and `love`. **QR codes on printed posters should use the deep link.**

Field-testing parameters: `?debug` (live stats), `?fov=68` (camera field of view), `?input=480` (tracker resolution), `?rawpose` (filter off), `?xrimage` (ARCore native image tracking).

## Deployment

`dist/` is a static site that works from any path. Requirements:

- **HTTPS is mandatory.** Browsers block the camera otherwise.
- **HTTP range requests** must be enabled for `.mp4`, or iOS Safari won't play the videos. Most static hosts do this by default.
- **Compress `.mind` files.** They shrink by roughly half with gzip, and many hosts skip unknown file types by default.
- Serve `.wasm` as `application/wasm`.

## Architecture

```
ARManager (state machine, React store)        <- UI subscribes here
  └─ ARRuntime (lazy loaded; one per session, disposed as a unit)
       ├─ CameraManager        the one camera stream
       ├─ TrackingManager      found / lost / recovered, from any adapter
       │    └─ TrackingAdapter
       │         ├─ ImageTrackingAdapter   MindAR: all browsers, poster lock
       │         └─ WebXRAdapter           ARCore: room placement
       ├─ SceneManager         renderer, the one animation loop, CameraBackground
       ├─ LightingManager      PBR environment, ARCore light estimation
       └─ Experience           TyreExperience | VideoExperience
            └─ ModelManager, AnimationManager, Hotspots, GLSL shaders
```

Adapters only deliver poses. Rendering and content can't tell which engine is running.

**Content frame.** Everything sits on one anchor where the poster is width 1, centred, +Y up, +Z out. The GLB was already authored in this frame: at rest, its tyre sits exactly on the printed tyre.

### Which engine runs where

| | Poster lock | Room placement |
| --- | --- | --- |
| **Android Chrome** | MindAR, or ARCore with `?xrimage` and a Chrome flag | WebXR + ARCore hit testing and anchors |
| **iPhone Safari** | MindAR | Not available: Safari has no immersive WebXR |
| **Desktop Chrome** | MindAR (for development) | Not available |

**Android deviates from the original brief here, on purpose.** The brief asked for WebXR/ARCore on Android, but the reference experience locks onto a printed poster, and Chrome's WebXR image tracking is still behind `chrome://flags/#webxr-incubations`, which real users won't have enabled. Using it as the default would break the core experience on every phone. So MindAR locks posters on Android too, and real WebXR with hit testing and anchors powers "Place the tyre in your room".

### What was changed around MindAR, and why

The app drives MindAR's per-frame steps rather than its `processVideo()` loop. Each change below came from measuring failures against ground truth. MindAR is pinned to exactly 1.2.5 because this code uses its internal methods.

| Change | Problem it solves |
| --- | --- |
| Real camera intrinsics | MindAR hardcodes a 45° FOV |
| Frame-locked compositing | The camera frame on screen is the one the pose was solved from, so overlays don't swim against the print |
| Outlier rejection after each solve | MindAR accepts a least-squares fit bent by a few false matches, then tracks from that pose. Measured: a steady 15 px error |
| Several solver passes on a new lock | Stops the pose settling on the first plausible answer |
| Background re-detection while confidence is low | Escapes wrong locks that hold steady. Measured: 100 px off at 37% confidence |
| Pose filter in image-plane terms | MindAR's filter runs on raw matrix values. Tuned to remove sub-pixel noise only, because lag here is direct overlay error |

Also tested and **rejected** for lack of benefit: the finer 256 px tracking keyframe (worse: stable wrong locks and dropped tracking in fast motion), and explicit testing of the mirrored planar-pose solution (no measurable gain).

### Assets

Originals in the project root are untouched. `npm run assets` regenerates `public/assets`:

- **GLB:** 2146 KB to 473 KB with meshopt and WebP. Named nodes and animation clips were checked and preserved. The decal texture went from 2048 to 1024 px, saving about 16 MB of GPU memory.
- **KTX2 is not used.** All but two of the textures are tiny and WebP is smaller on the wire, so the gain doesn't justify another decoder. `ModelManager` already supports KTX2 and Draco for future models, and those decoders only download if a model needs them.
- **No HDRI was supplied**, so reflections come from a procedural studio environment. In WebXR, ARCore's light estimate replaces it when available.
- **Videos** are remuxed for fast start and not re-encoded. Measured alignment to their prints is within 0.5% scale and 0.2% offset (`npm run test:registration`), so no correction offsets are applied.

### Adding a poster

1. Add a folder containing `target-*.jpg` and `content-*.mp4` or `.glb`, and list it in `scripts/prepare-assets.mjs`.
2. Add the id to `scripts/compile-targets.mjs` and an entry in `src/config/experiences.ts`. Both lists must be in the same order.
3. Run `npm run assets && npm run targets`.

Good targets have detail spread across the whole image, high contrast, and no large repeating texture.

## Device compatibility

| Platform | Expected | Status |
| --- | --- | --- |
| Desktop Chrome | Full camera experience | **Tested** |
| Android Chrome, recent phone with ARCore | Poster lock and room placement | **Not yet run on a phone** |
| Android Chrome, no ARCore | Poster lock only | **Not yet run on a phone** |
| iPhone Safari, iOS 15.4+ | Poster lock | **Not tested: no device available** |
| Facebook, Instagram and other in-app browsers | Usually block the camera | Shows a message asking the user to open the real browser. Detection is **not tested on a phone** |
| Browsers without WebGL2 or a camera API | None | Shows the unsupported screen. **Tested** |

Only one Android phone has been inspected: an OPPO CPH2359 on Android 14, with Chrome 154 and ARCore 1.57 installed. It disconnected from USB before the app was run on it.

## Test status

### Measured (desktop Chrome, RTX 4050)

The production build runs with Chrome's fake camera device playing generated footage of each poster, with a known camera path and realistic hand tremor. Every frame carries a barcode, so each pose is scored against its exact ground truth. This is the real tracker running end to end. Only the scene in front of the camera is synthetic.

Median corner error, in pixels of 720×1280 footage. The CEAT poster spans about 683 px at this distance.

| Poster | Steady | Slow move | Fast move | Poses held in fast move |
| --- | --- | --- | --- | --- |
| CEAT tyre | 2.9 | 3.4 | 3.8 | 72 of 72 |
| Basketball | 4.3 | 3.8 | 4.0 | 72 of 72 |
| Flower | 3.3 | 3.1 | 3.7 | 61 of 72 |
| Jelly | 4.0 to 4.2 | 3.9 | 3.9 to 4.1 | 72 of 72 |
| **Love** | **4.0 to 6.4** | **3.7** | **6.1 to 6.2** | **12 to 13 of 72** |

Numbers are from one or two runs of the final build per poster. Across repeated CEAT runs, medians stayed between about 2 and 4 px.

- The CEAT poster at half that size in frame: 1 to 5 px, at all three tracker resolutions.
- About 1 second from the poster appearing to lock (about 2 seconds for Love). Zero poses reported in any run while the poster was out of frame.
- `npm run test:ui` passes 26 of 26: all phases, hotspot selection, permission and asset errors, WebGL context loss and retry, the camera turning off, and the camera feed actually being on screen.

### Not verified

- **Real camera and real print.** Footage has no glare, rolling shutter, autofocus hunting or uneven lighting. Expect lower accuracy in the field.
- **Phone performance.** The 30 fps and 5 ms per frame above are from a desktop GPU. Phones will be much slower, and the tracker input sizes per device tier are not yet tuned on a real phone.
- **Android WebXR.** `WebXRAdapter` (hit testing, anchors, placement, native image tracking) has **never been executed**. Treat it as unproven until `npm run test:device` has run.
- **iOS Safari, entirely.** That includes camera start-up, video autoplay rules and memory limits. `scripts/test-webkit.mjs` runs the tracker in desktop WebKit to catch engine-level incompatibilities, but it **has not been run**: the browser download was too slow on the connection available. To run it: `npx playwright-core install webkit && npm run test:webkit`.
- **Camera FOV.** 64° is a typical value, not a per-device calibration. A wrong value mainly affects how far the tyre appears to lift, and `?fov=` overrides it.

### Running the tests

```bash
npm run build
node scripts/make-test-footage.mjs ceat-tyre   # about 900 MB, in .test-output/
npm run test:tracking -- ceat-tyre --shots     # one run, with screenshots
npm run test:matrix -- ceat-tyre               # compares tracker settings
npm run test:ui                                # needs the ceat-tyre footage
npm run test:registration                      # video-to-print alignment
npm run test:device                            # USB Android phone: unlocked, USB debugging on
```

`test:device` reports what the phone actually grants, tracker speed on its GPU, its real camera, and an immersive WebXR session.

## Known limitations

- **The Love poster tracks noticeably worse** than the others, with frequent lock loss in fast motion. Its dense gold speckle is the likely cause, though that has not been isolated. It is the first candidate for a re-crop or for retesting on a real print.
- **A rare wrong lock can last until the camera moves.** On perfectly frozen footage about 1 session in 8 locked on 13 px off (about 2% of poster width) until tracking was lost and regained. It did not occur in 8 runs with realistic hand motion, so it should be rare in practice.
- **Brief misregistration on fast re-entry.** If a poster sweeps back into frame very quickly, the overlay can be visibly off for up to about half a second.
- **The front camera isn't mirrored**, so that overlays stay aligned. Text reads correctly but the view doesn't act like a mirror.
- **WebGL context loss restarts the experience** through a Retry prompt rather than resuming silently.
- **Real-time shadows are not used.** The GLB's painted contact shadow is used on the poster and on the floor, because that is cheaper on phones and matches the original art.
- **`all.mind` is large** (4.6 MB, about 2.4 MB gzipped), which is why QR codes should use deep links.
- **No audio.** The supplied content videos have no audio tracks.

## Licences

MindAR (MIT), Three.js (MIT), TensorFlow.js (Apache-2.0), React (MIT), Inter (OFL). Check the rights for the supplied artwork and brand assets separately before publishing.

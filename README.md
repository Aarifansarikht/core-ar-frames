# BAY81 WebAR

Point an Android phone at a printed poster and it comes alive: a 3D CEAT tyre lifts off its print with light streaks and tappable features, and four artworks play registered video over the print. Built from the supplied assets and modelled on `refrence_video.mp4`.

React, TypeScript, Vite and Three.js, with **ARCore through WebXR as the only tracker**. No paid SDKs.

> **Read [Test status](#test-status) and [Who can use this](#who-can-use-this) before relying on this in production.** ARCore tracking has not yet been run on a physical phone, and it currently needs a Chrome flag.

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

### Set up the phone

1. Use an [ARCore-supported Android phone](https://developers.google.com/ar/devices) with Chrome and Google Play Services for AR up to date.
2. In Chrome, open `chrome://flags/#webxr-incubations`, set it to **Enabled**, and relaunch Chrome.
3. Open the app and tap **Start AR**.

To try it without a print, show a target image full screen on a monitor. The images are in `public/assets/experiences/<id>/target.jpg`.

### URLs

| URL | Behaviour |
| --- | --- |
| `/` | Recognises all five posters |
| `/?t=ceat-tyre` | One poster only, showing its brand. Its content is ready before the session starts |
| `/?t=ceat-tyre&w=0.42` | Also gives the print's real width in metres |

Ids are `ceat-tyre`, `basketball`, `flower`, `jelly` and `love`. **QR codes on printed posters should use the deep link, with `w` set to the real print width.** Without `w`, ARCore starts from an assumed 0.6 m. `?debug` shows live stats, including ARCore's verdict on each poster.

## Who can use this

| Platform | Result |
| --- | --- |
| Android Chrome, ARCore phone, flag **on** | Poster tracking and room placement. **Not yet run on a phone** |
| Android Chrome, ARCore phone, flag **off** | Room placement only. Start AR shows how to turn on the flag |
| Android, no ARCore | Shows the unsupported screen |
| **iPhone and iPad** | **No AR.** Shows a message saying ARCore isn't available. ARCore does not exist on iOS |
| Desktop | Shows the unsupported screen |
| In-app browsers (Facebook, Instagram) | Shows a message asking the user to open Chrome |

**Members of the public will not have this flag on.** As shipped, this suits demos and controlled devices, where someone can set the flag. Reaching ordinary phones needs Chrome to enable the feature by default, or a native Android app using ARCore directly.

## Deployment

`dist/` is a static site that works from any path.

- **HTTPS is mandatory.** WebXR doesn't run otherwise.
- Serve `.wasm` as `application/wasm`.

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

- **Posters:** decoded when the page loads, because a session request can't wait for anything. They go to ARCore in the session request, which is the moment of the Start AR tap.
- **Camera:** ARCore owns it, and Chrome draws its image behind the renderer. The app opens no camera stream of its own. Ending the session turns the camera off.
- **Pose:** used unsmoothed, every frame, at the width ARCore measures. Content is sized by that measurement.
- **Turning away and back:** ARCore remembers a found poster's place in the room and keeps reporting it as `emulated`. The app keeps showing content there, so it is already in place when the poster comes back into view, without searching again.
- **Lost state:** shows only if ARCore stops reporting the poster altogether.
- **Several posters:** one in view takes over from one that is only remembered, and a remembered one never takes over.
- **Content frame:** the poster is width 1, centred, +Y up, +Z out. The GLB was authored in this frame.

### Side effect of remembered poses

If someone **moves the poster itself** while it is out of view, content stays where the poster used to be until ARCore sees it again. That comes with the instant return, since a remembered place is what makes it instant.

### Assets

Originals in the project root are untouched. `npm run assets` regenerates `public/assets`:

- **GLB:** 2146 KB to 473 KB with meshopt and WebP. Named nodes and animation clips were checked and preserved.
- **KTX2 is not used.** `ModelManager` supports KTX2 and Draco for future models, and those decoders only download if a model needs them.
- **No HDRI was supplied**, so reflections come from a procedural studio environment until ARCore's light estimate replaces it.
- **Videos** are remuxed for fast start and not re-encoded. Measured alignment to their prints is within 0.5% scale and 0.2% offset (`npm run test:registration`).

### Adding a poster

1. Add a folder containing `target-*.jpg` and `content-*.mp4` or `.glb`, and list it in `scripts/prepare-assets.mjs`.
2. Add an entry in `src/config/experiences.ts`.
3. Run `npm run assets`.

Good targets have detail spread across the whole image, high contrast, and no large repeating texture. Check `scores` under `?debug`: an `untrackable` poster will never lock.

## Test status

### Verified

- `npm run build` passes.
- `npm run test:ui` passes 39 of 39 in desktop Chrome. **These use a scripted stand-in for ARCore**, which replays results to check how the app handles them: all phases, poster selection, remembered poses, hotspot taps, room placement, failed sessions, missing assets, closing, and retry. The unsupported-device cases use the browser's real answers, except the iPhone case, which imitates one with its user agent.

**These checks say nothing about tracking quality.** The earlier MindAR accuracy figures no longer apply and were removed.

### Not verified

- **ARCore image tracking on a real phone: speed of lock, accuracy, jitter and the return from looking away.** Nothing here has been measured.
- **ARCore's image axes.** The conversion to the content frame follows ARCore's documented frame, and the test only confirms the app applies it. If content appears rotated on a phone, `IMAGE_TO_CONTENT` in `src/adapters/WebXRAdapter.ts` is the place to look.
- **The Chrome flag's behaviour on your Chrome version.** The app assumes that without the flag, the session request fails with `NotSupportedError`.
- **Room placement and the DOM overlay** on a real device.
- **Print sizes.** The real width of each poster is not known, so `w` must be set per print.

### Running the tests

```bash
npm run build
npm run test:ui                        # desktop, with the ARCore stand-in
npm run test:registration              # video-to-print alignment
npm run test:device -- ceat-tyre       # USB Android phone, with the flag on
```

`test:device` is the real test. While it runs, lock the poster, turn away and point back a few times. It reports the time to first lock and a timeline of ARCore's states to `.test-output/report-device.json`.

## Known limitations

- **Needs a Chrome flag and an ARCore phone.** There is no iPhone support.
- **Love poster.** Its dense gold speckle made it the weakest poster under the old tracker. Whether ARCore does better is unknown until tested.
- **WebGL context loss restarts the experience** through a Retry prompt rather than resuming silently.
- **Real-time shadows are not used.** The GLB's painted contact shadow is cheaper on phones and matches the original art.
- **No audio.** The supplied content videos have no audio tracks.

## Licences

Three.js (MIT), React (MIT), Inter (OFL). Check the rights for the supplied artwork and brand assets separately before publishing.

# BAY81 WebAR

Point a phone at a printed poster and it comes alive: a 3D CEAT tyre lifts off its print with light streaks and tappable features, and four artworks play registered video over the print. Built from the supplied assets and modelled on `refrence_video.mp4`.

React, TypeScript, Vite and Three.js, with **our own poster tracker**, built on [OpenCV](https://opencv.org/) (Apache 2.0). It needs no app, no Chrome flags and no third-party AR platform, and everything is self-hosted.

> **Read [Test status](#test-status) before relying on this in production.** This version has not yet been run on a physical phone.

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

Open the link in Safari on iPhone or Chrome on Android and tap **Start AR**. Allow the camera when asked. Placing the tyre in the room also asks for motion access on iPhone.

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
| iPhone and iPad, Safari 16.4 or later | Poster tracking and floor placement. **Not yet run on a device** |
| Android, Chrome | Poster tracking and floor placement. **Not yet run on a device** |
| Desktop with a webcam | Poster tracking, with no floor placement |
| Older browsers | Shows a message asking the user to update |
| In-app browsers (Facebook, Instagram) | May not offer the camera, in which case the camera error shows |

## Deployment

`dist/` is a static site that works from any path.

- **HTTPS is mandatory.** The camera doesn't run otherwise.
- OpenCV is self-hosted: `npm run dev` and `npm run build` copy it from `node_modules` into `public/external/opencv`, which isn't committed.
- **Keep compression on.** `opencv.js` is 13 MB, about 3.8 MB gzipped. It loads in the background from the welcome screen, so a first visit on a slow connection shows **Preparing…** for a while.

## How tracking works

```
ARManager (state machine, React store)        <- UI subscribes here
  └─ TrackerClient      keeps the tracker's worker alive between sessions
  └─ ARRuntime (lazy loaded; one per session, disposed as a unit)
       ├─ TrackingManager      found / lost / recovered
       │    └─ TrackingAdapter
       │         └─ VisionAdapter    camera, frames to and from the worker, room placement
       ├─ SceneManager         renderer, camera image, the one animation loop
       ├─ LightingManager      PBR environment
       └─ Experience           TyreExperience | VideoExperience
            └─ ModelManager, AnimationManager, Hotspots, GLSL shaders
```

All of the vision runs in a worker (`src/tracking/tracker.worker.ts`), so it can't delay drawing. It has three parts:

1. **Finding.** ORB features in the frame are matched against each poster's compiled features, using our own hash index, which checks a few hundred candidates per feature instead of thousands. Every other search uses a higher resolution, to find posters further away. This is robust, but only roughly locates a poster.
2. **Refining.** The poster's own image is warped to where it should be and compared with the frame at points across the whole poster, using optical flow. This is what makes it accurate, including on posters with few features in some areas. It also shows that it really is the poster: if refining keeps failing and features can't find it either, the lock is dropped, so content can't stick to the wall behind a poster that has gone.
3. **Following.** Those points are carried from frame to frame with optical flow, which is fast. A 1€ filter removes jitter without adding lag.

- **No lag behind the camera:** each camera frame goes to the worker and comes back with its pose, and the two are drawn together, so content can't trail the image. The display runs at the tracker's speed while locked. While searching, the live camera is shown instead.
- **Never queues:** if the worker falls behind, frames are skipped, so results can't fall further and further behind.
- **Several posters:** each poster's content stays loaded after first use, and the others load in the background, so a switch needs only a recognition.
- **Turning away:** content disappears shortly after the poster leaves view, and returns when it is found again. There's no world tracking to hold it in place.
- **Room placement:** uses the phone's motion sensors only, with the floor assumed to be 1.6 m below the phone. **The tyre stays put as the phone turns, but not as the user walks**, and it sits on that assumed floor rather than a detected surface. Walls aren't supported.
- **Content frame:** the poster is width 1, centred, +Y up, +Z out. The GLB was authored in this frame.

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

Good targets have detail spread across the whole image, high contrast, and no large repeating texture. Run `npm run targets` after replacing or adding target images. It writes each poster's features and image to `public/assets/targets/<id>.target`, 160 to 270 KB each.

The extension matters: **don't use `.bin`.** Chrome returned an empty response for `.bin` files in testing here, while the same data with other extensions came through, and the cause wasn't identified.

## Admin panel

Open `/?admin`. Choose a poster, then use either tab:

- **Tracking area:** the dots are the points used to track the poster. Drag a rectangle to **track only there** or **ignore** it, for example to skip an area that will be covered or changed on the print. The panel shows how many points remain, with a rough rating. Check the result with **Test with camera**.
- **Content position:** move, rotate and resize the content against a picture of its poster. This applies when it is tracked on a poster, not when placed in the room.

**Saving:** under `npm run dev`, **Save changes** writes `public/assets/tracking.json`, and only from the same computer. Commit and push it to publish. On any other site, including the live one, the panel can't change anything: saving downloads `tracking.json`, which has to replace that file in the project. So the panel needs no login, although anyone who opens `/?admin` on the live site can see it.

The tracker reads areas when the page loads, so changes need no recompiling. New posters still go through [Adding a poster](#adding-a-poster).

## Test status

### Verified

- `npm run build` passes, including from a clean install.
- `npm run test:ui` passes 56 of 56 in desktop Chrome, with **our real tracker looking at a simulated camera**: a poster drawn in 3D over a cluttered room, fed through `getUserMedia`, with a known pose to compare against. It covers all phases, hotspot taps, room placement, denied permissions, missing assets, closing and retry, plus an iPhone user agent and motion prompt.

| Measured on a desktop, in a simulation | Result |
| --- | --- |
| Recognition after a poster appears, frontal | 0.2 to 0.6 s |
| Worst corner against the print, all five posters, frontal | 0.2 to 1.4 px on a 412 px wide screen |
| Hard conditions recognised (table below) | 69 of 75 |
| Movement of content on a still poster | Below measurement |
| Locked during simulated fast hand movement | 100% of the time |
| Following a poster | 13 ms a frame |
| Refining while locked | 22 ms |
| Searching | 47 to 69 ms a frame |

| Hard condition, each tried on all five posters | Found |
| --- | --- |
| Tilted 30 or 45 degrees, tilted down 45 degrees, rotated, upside down | All |
| 30% of the view, 150% of the view, off to one side | All |
| Blur, dim light, very dim with noise, heavy noise | All |
| Tilted 60 degrees | 2 of 5 |
| 15% of the view | 2 of 5 |

**These are best-case figures and not what a phone will show.** The simulation has no real lens, glare, rolling shutter or motion blur, and a phone's CPU can be expected to be several times slower. Emulated CPU slowdown doesn't reach workers, so phone speed hasn't been estimated by testing.

**Hard conditions are less accurate than the frontal figures.** In the worst cases, content appeared noticeably out of place shortly after locking, by up to about 50 px. This varies between runs, and happened most often on the CEAT poster, the weakest because of its dark, low-detail areas, under heavy blur or very dim light.

### Not verified

- **Anything on a real phone or iPhone:** this version hasn't run on one, so frame rate, recognition in real light, heat, battery and memory are unmeasured. An iPhone user agent in desktop Chrome is not Safari.
- **iPhone memory.** OpenCV is large, and Safari is strict about memory.
- **Floor placement in a real room.** The test feeds in simulated motion sensor readings.
- **The assumed lens.** The tracker assumes a typical phone camera's focal length. A different lens doesn't affect flat alignment much, but makes the tyre's 3D depth slightly off.

### Running the tests

```bash
npm run build
npm run test:ui                        # desktop, real tracker, simulated camera
npm run test:registration              # video-to-print alignment
npm run test:device -- ceat-tyre       # USB Android phone
```

`test:device` is the real test. While it runs, lock the poster, turn away and point back a few times. It reports the time to first lock, tracking frame rate and a timeline of states to `.test-output/report-device.json`.

## Known limitations

- **No world tracking.** Content can't stay in place when the poster leaves view, and room placement can't follow walking. Adding it would mean building SLAM, a much larger project.
- **Steep angles and distance.** Finding a poster beyond about 45 degrees, or smaller than about 30% of the view, is unreliable. A poster that is already locked can be followed further.
- **CEAT poster** is the weakest, as its dark areas have little detail.
- **Download:** about 3.8 MB of gzipped OpenCV. A custom OpenCV build with only what the tracker uses would be much smaller, but needs its own toolchain.
- **WebGL context loss restarts the experience** through a Retry prompt rather than resuming silently.
- **Real-time shadows are not used.** The GLB's painted contact shadow is cheaper on phones and matches the original art.
- **No audio.** The supplied content videos have no audio tracks.

## Licences

OpenCV (Apache-2.0, copied with its licence to `external/opencv/LICENSE.txt`), Three.js (MIT), React (MIT), Inter (OFL). `@techstark/opencv-js` packages the official OpenCV.js build (Apache-2.0). Check the rights for the supplied artwork and brand assets separately before publishing.

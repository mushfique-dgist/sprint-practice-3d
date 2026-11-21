# Sprint practice in 3D

Interactive 3D view of the simulated sprinters of the SAIL lab (DGIST): the practice-schedule test shown at the lab
meeting of 30 October 2026, and the runners of the simulator work of 17 to 21 November 2026.

Open the page: https://mushfique-dgist.github.io/sprint-practice-3d/

- **Main test:** the twelve practice pairs (twin without a device, device in half the runs, brake in half the runs, device always on), raced with the device removed or on.
- **Changed conditions:** pair 1 under the registered test conditions (headwind, pushes, a worn 6 kg device, ankle and hip brakes, changed muscles, model copies).
- **November runners:** the unchanged runner, bodies P and Q and the tests made on them, one recorded start each. No body passes as a sprinter yet; this tab shows how the runners move and is not a result about a fitted body or about the device.
- **23 Oct races:** the three races shown on 23 October, from the same recordings.
- **Results:** the registered numbers of the main test, with links into the 3D views. **Films:** rendered versions of the 23 October races.

Every sprinter is one recording of a trained network in the Bolt simulator (bones and muscle paths, 30 frames per second). The registered numbers come from the same analysis files as the meeting slides.

Preliminary results for discussion in the lab; please do not cite or circulate.

Code review and tests of November 2026: [REVIEW_2026-11.md](REVIEW_2026-11.md); test pages in `test/`.

Rendering uses [three.js](https://threejs.org) (MIT licence, `vendor/three/LICENSE`).

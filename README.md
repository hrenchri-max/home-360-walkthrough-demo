# 360 home walk-through (three.js)

A single-page 360° walk-through of a home built from equirectangular panoramas, with smooth "move-in" transitions between rooms.

**Live:** https://hrenchri-max.github.io/home-360-walkthrough-demo/

- Drag / touch to look around, scroll or pinch to zoom, optional motion look on phones.
- Glowing floor rings point to the next room. Tapping one turns the camera toward it, narrows the field of view and dollies forward while the next panorama (preloaded and already on the GPU) crossfades in from the matching direction. About 1.2 s, eased, no flash.
- Floor-plan minimap with your position and a heading cone; room label.
- **Transition: Sphere / Room depth.** "Room depth" projects each panorama onto a proxy room box instead of a sphere, so floor and walls shift with real parallax during the move. With a project's own FBX model, that proxy is the actual geometry.

Plain HTML + JS, three.js 0.170 pinned through an import map. No build step: serve the folder.

Panoramas: [Poly Haven](https://polyhaven.com), CC0 (lythwood_lounge, kiara_interior, lythwood_room), resized to 4096×2048.

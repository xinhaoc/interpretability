# Promo video

A 50-second motion-graphics trailer, rendered with [Remotion](https://www.remotion.dev/) (no screen recording). The soundtrack is synthesised by `make_music.py`, so it uses no samples.

```bash
cd promo
npm install
npm run music     # writes public/music.wav
npm run render    # writes out/interpretability-promo.mp4 (1920x1080, 30 fps)
npm run studio    # live preview / editing
```

Scenes are in `src/scenes.tsx`. Their lengths are in `src/Promo.tsx`, and the music hits on the same boundaries. The paper pages in the video are made up; no real paper is shown.

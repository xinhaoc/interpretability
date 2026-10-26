import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { Backdrop, Grain } from "./parts";
import { S1Hook, S2Logo, S3Select, S4Memory, S5Grounded, S6Map, S7Platform, S8End } from "./scenes";

// Scene lengths in frames at 30 fps; the music (make_music.py) hits on the same boundaries.
export const SCENES: [React.FC, number][] = [
  [S1Hook, 150], [S2Logo, 90], [S3Select, 240], [S4Memory, 210],
  [S5Grounded, 180], [S6Map, 240], [S7Platform, 180], [S8End, 210],
];
export const TOTAL = SCENES.reduce((a, [, d]) => a + d, 0);

export const Promo: React.FC = () => {
  let at = 0;
  return (
    <AbsoluteFill>
      <Backdrop />
      {SCENES.map(([Comp, dur], i) => {
        const from = at;
        at += dur;
        return <Sequence key={i} from={from} durationInFrames={dur}><Comp /></Sequence>;
      })}
      <Grain />
      <Audio src={staticFile("music.wav")} />
    </AbsoluteFill>
  );
};

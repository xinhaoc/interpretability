import katex from "katex";
import "katex/dist/katex.min.css";
import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

export const C = {
  bg: "#0b0a09",
  ink: "#f6f0e8",
  dim: "#9b9186",
  faint: "#3a3530",
  orange: "#f08a4b",
  deep: "#c2410c",
  green: "#4ade80",
  red: "#f87171",
  blue: "#60a5fa",
  amber: "#fbbf24",
  violet: "#a78bfa",
  teal: "#2dd4bf",
  paper: "#fbf8f3",
};
export const FONT = '-apple-system, "SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif';
export const MONO = '"SF Mono", Menlo, monospace';
export const EASE = Easing.bezier(0.16, 1, 0.3, 1);

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
export const ramp = (f: number, a: number, b: number, from = 0, to = 1) =>
  interpolate(f, [a, b], [from, to], { ...clamp, easing: EASE });

export function useSpring(delay: number, config = { damping: 14, mass: 0.6 }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config });
}

/** Fade a whole scene in and out at its edges. */
export const Scene: React.FC<{ dur: number; children: React.ReactNode; fadeIn?: number; fadeOut?: number }> = ({
  dur, children, fadeIn = 10, fadeOut = 10,
}) => {
  const f = useCurrentFrame();
  const o = Math.min(ramp(f, 0, fadeIn), 1 - ramp(f, dur - fadeOut, dur));
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

/** Dark backdrop with a slow orange glow, a faint grid, grain and a vignette. */
export const Backdrop: React.FC = () => {
  const f = useCurrentFrame();
  const gx = 50 + Math.sin(f / 90) * 18;
  const gy = 45 + Math.cos(f / 120) * 12;
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <AbsoluteFill style={{ background: `radial-gradient(1200px 800px at ${gx}% ${gy}%, rgba(240,138,75,0.13), transparent 60%)` }} />
      <AbsoluteFill style={{
        backgroundImage: "linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)",
        backgroundSize: "80px 80px", backgroundPosition: `${(f * 0.3) % 80}px ${(f * 0.2) % 80}px`,
        maskImage: "radial-gradient(circle at 50% 50%, black 30%, transparent 75%)",
      }} />
      <AbsoluteFill style={{ background: "radial-gradient(circle at 50% 50%, transparent 55%, rgba(0,0,0,0.7) 100%)" }} />
    </AbsoluteFill>
  );
};

export const Grain: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.07, mixBlendMode: "overlay" }}>
      <svg width="100%" height="100%">
        <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={f % 12} /></filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
    </AbsoluteFill>
  );
};

/** Characters rise in with a blur, one after another. */
export const Reveal: React.FC<{ text: string; delay?: number; step?: number; style?: React.CSSProperties }> = ({
  text, delay = 0, step = 2, style,
}) => {
  const f = useCurrentFrame();
  return (
    <span style={{ display: "inline-block", whiteSpace: "pre", ...style }}>
      {[...text].map((ch, i) => {
        const p = ramp(f, delay + i * step, delay + i * step + 14);
        return (
          <span key={i} style={{ display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 24}px)`, filter: `blur(${(1 - p) * 10}px)` }}>
            {ch}
          </span>
        );
      })}
    </span>
  );
};

/** The numbered feature title in the top-left corner of a scene. */
export const Caption: React.FC<{ n: string; title: string; sub: string; delay?: number }> = ({ n, title, sub, delay = 4 }) => {
  const f = useCurrentFrame();
  const p = ramp(f, delay, delay + 22);
  return (
    <div style={{ position: "absolute", left: 120, top: 92, fontFamily: FONT }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18, opacity: p }}>
        <span style={{ fontFamily: MONO, color: C.orange, fontSize: 26, letterSpacing: 2 }}>{n}</span>
        <span style={{ width: 120 * p, height: 2, background: `linear-gradient(90deg, ${C.orange}, transparent)` }} />
      </div>
      <div style={{ marginTop: 14, fontSize: 64, fontWeight: 700, color: C.ink, letterSpacing: 1 }}>
        <Reveal text={title} delay={delay + 4} step={1.6} />
      </div>
      <div style={{ marginTop: 10, fontSize: 28, color: C.dim, opacity: ramp(f, delay + 18, delay + 36), letterSpacing: 0.5 }}>{sub}</div>
    </div>
  );
};

export const TeX: React.FC<{ tex: string; display?: boolean; style?: React.CSSProperties }> = ({ tex, display, style }) => (
  <span style={style} dangerouslySetInnerHTML={{ __html: katex.renderToString(tex, { displayMode: !!display, throwOnError: false }) }} />
);

export const AppIcon: React.FC<{ size: number; style?: React.CSSProperties }> = ({ size, style }) => (
  <Img src={staticFile("icon.png")} style={{ width: size, height: size, ...style }} />
);

// ---- a made-up two-column paper page (no real paper is shown)

const rnd = (seed: number) => {
  let s = seed;
  return () => ((s = (s * 9301 + 49297) % 233280) / 233280);
};

type Line = { col: number; x: number; y: number; w: number };
/** Where everything on the page goes, so scenes can point a cursor at a line. */
export function layoutPaper(w: number, seed = 3, showEq = true, figure = true) {
  const h = w * 1.294;
  const r = rnd(seed);
  const pad = w * 0.09;
  const colW = (w - pad * 2 - w * 0.04) / 2;
  const lineH = w * 0.0175;
  const gap = w * 0.0118;
  const lines: Line[] = [];
  let eq: { x: number; y: number; w: number; h: number } | null = null;
  let fig: { x: number; y: number; w: number; h: number } | null = null;
  for (let c = 0; c < 2; c++) {
    const x = pad + c * (colW + w * 0.04);
    let y = pad + w * (c === 0 ? 0.13 : 0.05);
    while (y < h - pad) {
      if (c === 0 && showEq && !eq && y > h * 0.5) {
        eq = { x, y, w: colW, h: lineH * 4.2 };
        y += lineH * 4.6;
        continue;
      }
      if (c === 1 && figure && !fig && y > h * 0.28) {
        fig = { x, y, w: colW, h: colW * 0.62 };
        y += colW * 0.62 + lineH * 2.6;
        continue;
      }
      const para = r() < 0.12;
      lines.push({ col: c, x, y, w: para ? colW * (0.35 + r() * 0.4) : colW * (0.92 + r() * 0.08) });
      y += lineH + gap + (para ? lineH * 0.8 : 0);
    }
  }
  return { h, pad, colW, lineH, lines, eq, fig };
}

/** Index of the first line in column `col` at or below fraction `at` of the page height. */
export function lineAt(L: ReturnType<typeof layoutPaper>, col: number, at: number) {
  return L.lines.findIndex((l) => l.col === col && l.y >= at * L.h);
}

export const PaperPage: React.FC<{
  w: number; seed?: number; showEq?: boolean; eqGlow?: number; figure?: boolean;
  highlight?: { line: number; progress: number; color?: string; pin?: number };
}> = ({ w, seed = 3, showEq = true, eqGlow = 0, highlight, figure = true }) => {
  const L = layoutPaper(w, seed, showEq, figure);
  const { h, pad, lineH } = L;
  const hl = highlight && L.lines[highlight.line];
  return (
    <div style={{ position: "relative", width: w, height: h, background: C.paper, borderRadius: 6, boxShadow: "0 30px 80px rgba(0,0,0,0.55)" }}>
      <div style={{ position: "absolute", left: w * 0.2, top: pad, width: w * 0.6, height: lineH * 1.3, background: "#2b2723", borderRadius: 3 }} />
      <div style={{ position: "absolute", left: w * 0.3, top: pad + lineH * 2.3, width: w * 0.4, height: lineH * 0.6, background: "#a69c90", borderRadius: 2 }} />
      {L.lines.map((l, i) => (
        <div key={i} style={{ position: "absolute", left: l.x, top: l.y, width: l.w, height: lineH * 0.62, background: "#d5cdc3", borderRadius: 2 }} />
      ))}
      {hl && (
        <div style={{ position: "absolute", left: hl.x - 3, top: hl.y - lineH * 0.25, height: lineH * 1.1, width: (hl.w + 6) * highlight!.progress,
          background: highlight!.color || "rgba(60,120,255,0.35)", borderRadius: 3 }} />
      )}
      {hl && highlight!.pin ? (
        <div style={{ position: "absolute", left: w - pad * 0.8, top: hl.y - lineH * 1.0, width: lineH * 2.6, height: lineH * 2.6, borderRadius: "50% 50% 50% 12%",
          background: C.deep, color: "#fff", fontFamily: FONT, fontWeight: 700, fontSize: lineH * 1.5, boxShadow: "0 4px 12px rgba(194,65,12,0.5)", display: "flex", alignItems: "center", justifyContent: "center",
          transform: `scale(${highlight!.pin})` }}>1</div>
      ) : null}
      {L.eq && (
        <div style={{ position: "absolute", left: L.eq.x, top: L.eq.y - lineH, width: L.eq.w, height: L.eq.h, display: "flex", alignItems: "center", justifyContent: "center",
          borderRadius: 6, boxShadow: eqGlow ? `0 0 ${40 * eqGlow}px rgba(240,138,75,${0.8 * eqGlow}), inset 0 0 0 ${2 * eqGlow}px rgba(240,138,75,${eqGlow})` : "none",
          background: eqGlow ? `rgba(240,138,75,${0.08 * eqGlow})` : "transparent" }}>
          <TeX tex={"\\mathrm{softmax}\\Big(\\frac{QK^{\\top}}{\\sqrt{d_k}}\\Big)V"} style={{ fontSize: w * 0.025, color: "#222", whiteSpace: "nowrap" }} />
          <span style={{ position: "absolute", right: 4, fontSize: w * 0.016, color: "#444", fontFamily: "Times, serif" }}>(1)</span>
        </div>
      )}
      {L.fig && (
        <svg style={{ position: "absolute", left: L.fig.x, top: L.fig.y }} width={L.fig.w} height={L.fig.h + lineH * 2}>
          <rect x={0} y={0} width={L.fig.w} height={L.fig.h} fill="#f4efe7" rx={4} />
          {[0.42, 0.61, 0.55, 0.78, 0.92].map((v, i) => (
            <rect key={i} x={L.fig!.w * (0.1 + i * 0.17)} y={L.fig!.h * (0.9 - v * 0.75)} width={L.fig!.w * 0.11} height={L.fig!.h * v * 0.75} fill={i === 4 ? C.deep : "#b9ada0"} rx={2} />
          ))}
          <line x1={L.fig.w * 0.06} x2={L.fig.w * 0.94} y1={L.fig.h * 0.9} y2={L.fig.h * 0.9} stroke="#998" strokeWidth={1} />
          <rect x={L.fig.w * 0.12} y={L.fig.h + lineH * 0.5} width={L.fig.w * 0.76} height={lineH * 0.7} fill="#c9c1b7" rx={2} />
        </svg>
      )}
    </div>
  );
};

/** A macOS-ish pointer. */
export const Cursor: React.FC<{ x: number; y: number; pressed?: boolean; opacity?: number }> = ({ x, y, pressed, opacity = 1 }) => (
  <svg style={{ position: "absolute", left: x, top: y, opacity, transform: `scale(${pressed ? 0.88 : 1})`, filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.5))" }} width={34} height={44} viewBox="0 0 17 22">
    <path d="M1 1 L1 17 L5 13.5 L8 20 L10.5 19 L7.6 12.6 L13 12.6 Z" fill="#fff" stroke="#111" strokeWidth={1.1} strokeLinejoin="round" />
  </svg>
);

export const Chip: React.FC<{ children: React.ReactNode; color?: string; bg?: string; style?: React.CSSProperties }> = ({ children, color = C.orange, bg = "rgba(240,138,75,0.14)", style }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 12px", borderRadius: 8, color, background: bg, fontSize: 22, fontFamily: FONT, fontWeight: 600, ...style }}>{children}</span>
);

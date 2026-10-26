import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { AppIcon, C, Caption, Chip, clamp, Cursor, FONT, layoutPaper, lineAt, MONO, PaperPage, ramp, Reveal, Scene, TeX, useSpring } from "./parts";

// ============================================================ 1. Hook: pages drift in, camera pushes into an equation
export const S1Hook: React.FC = () => {
  const f = useCurrentFrame();
  const push = ramp(f, 88, 150);
  const pages = [
    { x: -520, y: 40, rz: -8, ry: 22, d: 0, seed: 7 },
    { x: 520, y: 20, rz: 6, ry: -22, d: 8, seed: 11 },
    { x: 0, y: 0, rz: 0, ry: 0, d: 16, seed: 3 },
  ];
  return (
    <Scene dur={150} fadeIn={14}>
      <AbsoluteFill style={{ perspective: 2200, alignItems: "center", justifyContent: "center" }}>
        {pages.map((p, i) => {
          const t = ramp(f, p.d, p.d + 60);
          const z = interpolate(t, [0, 1], [-2600, 0]);
          const center = i === 2;
          const s = center ? 1 + push * 2.4 : 1;
          const away = center ? 0 : push;
          return (
            <div key={i} style={{
              position: "absolute",
              transform: `translate3d(${p.x * (1 + away * 1.4)}px, ${p.y + (center ? -push * 120 : 0)}px, ${z}px) rotateZ(${p.rz * (1 - push)}deg) rotateY(${p.ry + Math.sin((f + i * 30) / 40) * 3}deg) scale(${s})`,
              opacity: t * (1 - away),
            }}>
              <PaperPage w={560} seed={p.seed} eqGlow={center ? ramp(f, 104, 130) : 0} />
            </div>
          );
        })}
      </AbsoluteFill>
      {/* dark band so the captions read over a bright page */}
      <AbsoluteFill style={{ background: "linear-gradient(to top, rgba(11,10,9,0.95) 0%, rgba(11,10,9,0.75) 22%, transparent 45%)" }} />
      <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 120, fontFamily: FONT }}>
        <div style={{ fontSize: 58, fontWeight: 600, color: C.ink, opacity: 1 - ramp(f, 70, 82), textShadow: "0 4px 30px rgba(0,0,0,0.8)" }}>
          <Reveal text="又一篇论文。" delay={18} step={3} />
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 110, fontFamily: FONT }}>
        <div style={{ fontSize: 64, fontWeight: 700, color: C.ink, textShadow: "0 6px 40px rgba(0,0,0,0.9)", display: "flex", gap: 30 }}>
          <Reveal text="读完不难。" delay={84} step={2.5} style={{ color: C.dim }} />
          <Reveal text="读懂每一行，才难。" delay={100} step={2.2} style={{ color: C.ink }} />
        </div>
      </AbsoluteFill>
    </Scene>
  );
};

// ============================================================ 2. Logo
export const S2Logo: React.FC = () => {
  const f = useCurrentFrame();
  const pop = useSpring(4, { damping: 11, mass: 0.7 });
  const flash = 1 - ramp(f, 0, 18);
  const ring = ramp(f, 2, 40);
  return (
    <Scene dur={90} fadeIn={2}>
      <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 46%, rgba(255,190,140,${0.55 * flash}), transparent ${30 + 50 * (1 - flash)}%)` }} />
      {Array.from({ length: 18 }).map((_, i) => {
        const a = (i / 18) * Math.PI * 2;
        const len = ramp(f, 0, 30) * 900;
        return (
          <div key={i} style={{ position: "absolute", left: 960, top: 470, width: len, height: 2, transformOrigin: "0 50%",
            transform: `rotate(${a}rad) translateX(${120 + ramp(f, 0, 40) * 300}px)`, opacity: 0.5 * (1 - ramp(f, 14, 40)),
            background: `linear-gradient(90deg, ${C.orange}, transparent)` }} />
        );
      })}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily: FONT }}>
        <div style={{ position: "relative", marginTop: -90 }}>
          <div style={{ position: "absolute", inset: -60 * ring, borderRadius: "50%", border: `2px solid rgba(240,138,75,${0.6 * (1 - ring)})` }} />
          <AppIcon size={230} style={{ transform: `scale(${0.4 + pop * 0.6}) rotate(${(1 - pop) * -14}deg)`, filter: "drop-shadow(0 20px 60px rgba(240,138,75,0.45))" }} />
        </div>
        <div style={{ marginTop: 34, fontSize: 104, fontWeight: 800, color: C.ink, letterSpacing: -1 }}>
          <Reveal text="interpretability" delay={14} step={1.6} />
        </div>
        <div style={{ marginTop: 14, fontSize: 36, color: C.orange, fontWeight: 600, letterSpacing: 6, opacity: ramp(f, 40, 60) }}>读懂每一篇论文</div>
        <div style={{ marginTop: 8, fontSize: 24, color: C.dim, letterSpacing: 2, opacity: ramp(f, 48, 68) }}>Read every line. Understand every step.</div>
      </AbsoluteFill>
    </Scene>
  );
};

// ============================================================ 3. Select anything, ask
const ACTS = ["解释", "推导", "通俗讲", "联系全文", "挑毛病"];

export const S3Select: React.FC = () => {
  const f = useCurrentFrame();
  const pageIn = useSpring(6);
  const PX = 200, PY = 318, PW = 560;
  // The cursor, the highlight and the pin all use the page's own layout.
  const layout = layoutPaper(PW, 5, true, true);
  const selIdx = lineAt(layout, 0, 0.66);
  const sel = layout.lines[selIdx];
  const selX = PX + sel.x, selY = PY + sel.y;
  const drag = ramp(f, 62, 92);
  const btnX = selX + 40 + 14 + 96, btnY = selY + 46 + 52 + 20; // the 推导 button in the popup
  const cur = f < 62
    ? { x: interpolate(f, [20, 60], [PX + 460, selX - 2], clamp), y: interpolate(f, [20, 60], [PY + 640, selY - 4], clamp) }
    : f < 92 ? { x: selX + drag * sel.w, y: selY - 4 }
    : { x: interpolate(f, [100, 116], [selX + sel.w, btnX], clamp), y: interpolate(f, [100, 116], [selY - 4, btnY], clamp) };
  const pop = useSpring(94);
  const pin = useSpring(122);
  const tick = useSpring(222, { damping: 8, mass: 0.5 });
  const press = f >= 118 && f < 124;
  const chosen = f >= 120;
  const panel = useSpring(126, { damping: 16, mass: 0.8 });
  const lines = [
    { t: "式 (1) 逐步拆解", d: 140, bold: true },
    { t: "① 每个查询与所有键算相容分数", d: 152 },
    { tex: "S = QK^{\\top} \\in \\mathbb{R}^{n\\times n}", d: 162 },
    { t: "② 除以 √d_k，把方差拉回 1，softmax 不再饱和", d: 174 },
    { tex: "\\tilde S = S/\\sqrt{d_k}", d: 184 },
    { t: "③ softmax 后对 V 加权求和", d: 196 },
    { tex: "\\mathrm{Attn}(Q,K,V)=\\mathrm{softmax}(\\tilde S)\\,V", d: 206 },
  ];
  return (
    <Scene dur={240}>
      <Caption n="01" title="选中任意一行、公式或图表" sub="Select anything. Ask anything." />
      <div style={{ position: "absolute", left: PX, top: PY, transform: `translateY(${(1 - pageIn) * 80}px) rotate(${(1 - pageIn) * -3}deg)`, opacity: pageIn }}>
        <PaperPage w={PW} seed={5} figure highlight={{ line: selIdx, progress: f < 62 ? 0 : drag, color: chosen ? "rgba(240,138,75,0.42)" : "rgba(60,120,255,0.38)", pin: chosen ? pin : 0 }} />
      </div>
      {/* selection popup */}
      <div style={{ position: "absolute", left: selX + 40, top: selY + 46, opacity: pop * (1 - ramp(f, 132, 144)), transform: `translateY(${(1 - pop) * 16}px) scale(${0.94 + pop * 0.06})`,
        background: "#1d1b18", border: `1px solid ${C.faint}`, borderRadius: 16, padding: 14, boxShadow: "0 24px 60px rgba(0,0,0,0.6)", fontFamily: FONT }}>
        <div style={{ color: C.dim, fontSize: 18, marginBottom: 10 }}>选中 52 字 · p.4</div>
        <div style={{ display: "flex", gap: 8 }}>
          {ACTS.map((a, i) => (
            <span key={a} style={{ padding: "8px 16px", borderRadius: 10, fontSize: 22, fontWeight: 600,
              background: i === 1 && f >= 118 ? C.deep : "#2a2723", color: i === 1 && f >= 118 ? "#fff" : C.ink,
              transform: i === 1 && press ? "scale(0.9)" : "none" }}>{a}</span>
          ))}
          <span style={{ padding: "8px 14px", borderRadius: 10, fontSize: 22, background: "rgba(250,204,21,0.15)", color: C.amber, fontWeight: 600 }}>✎ 记笔记</span>
        </div>
      </div>
      <Cursor x={cur.x} y={cur.y} pressed={press || (f > 62 && f < 92)} opacity={1 - ramp(f, 128, 142)} />
      {/* answer panel */}
      <div style={{ position: "absolute", left: 900, top: 318, width: 880, height: 660, transform: `translateX(${(1 - panel) * 300}px)`, opacity: panel,
        background: "linear-gradient(180deg, #1b1916, #141210)", border: `1px solid ${C.faint}`, borderRadius: 22, padding: "30px 40px", fontFamily: FONT,
        boxShadow: "0 40px 100px rgba(0,0,0,0.6)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 22 }}>
          <span style={{ fontFamily: MONO, color: C.orange, fontSize: 22 }}>#1</span>
          <Chip>p.4</Chip>
          <span style={{ color: C.ink, fontSize: 24, fontWeight: 600 }}>推导</span>
          <span style={{ marginLeft: "auto", color: C.dim, fontSize: 18 }}>Claude · 记忆模式</span>
        </div>
        {lines.map((l, i) => {
          const p = ramp(f, l.d, l.d + 14);
          return (
            <div key={i} style={{ opacity: p, transform: `translateY(${(1 - p) * 12}px)`, margin: l.tex ? "6px 0 14px 34px" : "8px 0", color: l.bold ? C.ink : "#d9d1c6",
              fontSize: l.bold ? 30 : 26, fontWeight: l.bold ? 700 : 400 }}>
              {l.tex ? <TeX tex={l.tex} style={{ fontSize: 30, color: C.ink }} /> : l.t}
            </div>
          );
        })}
        <div style={{ marginTop: 20, opacity: ramp(f, 214, 226), fontSize: 22, color: "#d9d1c6" }}>
          <span style={{ borderBottom: `2px solid ${C.green}` }}>“scaling keeps the logits at unit variance”</span>
          <span style={{ color: C.orange }}> [p.4]</span>
          <span style={{ color: C.green, display: "inline-block", marginLeft: 8, transform: `scale(${tick})` }}>✓</span>
        </div>
      </div>
    </Scene>
  );
};

// ============================================================ 4. Memory shared by every model
const CARDS = [
  { t: "通读笔记", g: "▤" }, { t: "符号表", g: "∑" }, { t: "图表描述", g: "▦" }, { t: "问答沉淀", g: "◆" }, { t: "你的批注", g: "✎" },
];
const MODELS = ["Claude Code", "Anthropic API", "Codex", "本地模型 · Ollama"];

export const S4Memory: React.FC = () => {
  const f = useCurrentFrame();
  const cx = 960, cy = 610;
  const core = useSpring(8);
  const pulse = 1 + Math.sin(f / 7) * 0.03;
  const paperT = ramp(f, 14, 52);
  return (
    <Scene dur={210}>
      <Caption n="02" title="读一遍，所有模型共用一份记忆" sub="Read once. Every model remembers." />
      <svg width={1920} height={1080} style={{ position: "absolute" }}>
        {MODELS.map((m, i) => {
          const pos = modelPos(i, cx, cy);
          const draw = ramp(f, 100 + i * 10, 130 + i * 10);
          const len = Math.hypot(pos.x - cx, pos.y - cy);
          return (
            <g key={m}>
              <line x1={pos.x} y1={pos.y} x2={cx} y2={cy} stroke={C.orange} strokeOpacity={0.5} strokeWidth={2}
                strokeDasharray={len} strokeDashoffset={len * (1 - draw)} />
              {draw >= 1 && [0, 1].map((k) => {
                const t = ((f - 130 - i * 10) / 26 + k * 0.5) % 1;
                return <circle key={k} cx={pos.x + (cx - pos.x) * t} cy={pos.y + (cy - pos.y) * t} r={5} fill={C.orange} opacity={0.9} />;
              })}
            </g>
          );
        })}
      </svg>
      {/* paper flying into the core */}
      <div style={{ position: "absolute", left: interpolate(paperT, [0, 1], [180, cx - 60]), top: interpolate(paperT, [0, 1], [500, cy - 75]),
        transform: `scale(${1 - paperT * 0.7}) rotate(${paperT * 30}deg)`, opacity: 1 - ramp(f, 46, 56) }}>
        <PaperPage w={120} seed={9} showEq={false} figure={false} />
      </div>
      <div style={{ position: "absolute", left: 180, top: 690, color: C.dim, fontFamily: FONT, fontSize: 24, opacity: ramp(f, 14, 24) * (1 - ramp(f, 44, 54)) }}>通读一遍 →</div>
      {/* core */}
      <div style={{ position: "absolute", left: cx - 130, top: cy - 130, width: 260, height: 260, borderRadius: "50%", transform: `scale(${core * pulse})`,
        background: "radial-gradient(circle at 40% 35%, #ffd2b0, #f08a4b 35%, #c2410c 70%, #5a1d06)", boxShadow: `0 0 ${80 + 40 * ramp(f, 46, 60)}px rgba(240,138,75,0.65)`,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: FONT }}>
        <div style={{ fontSize: 46, fontWeight: 800, color: "#fff" }}>记忆</div>
        <div style={{ fontSize: 20, color: "rgba(255,255,255,0.8)", letterSpacing: 3 }}>MEMORY</div>
      </div>
      {/* memory cards in an arc above */}
      {CARDS.map((c, i) => {
        const s = useSpring(54 + i * 8);
        const a = Math.PI * (1.12 + i * 0.19);
        const x = cx + Math.cos(a) * 360, y = cy + Math.sin(a) * 300 - 30;
        return (
          <div key={c.t} style={{ position: "absolute", left: x - 100, top: y - 36, width: 200, height: 72, borderRadius: 16, transform: `scale(${s})`, opacity: s,
            background: "#1c1a17", border: `1px solid ${C.faint}`, display: "flex", alignItems: "center", gap: 14, padding: "0 20px", fontFamily: FONT,
            boxShadow: "0 16px 40px rgba(0,0,0,0.5)" }}>
            <span style={{ fontSize: 28, color: C.orange }}>{c.g}</span>
            <span style={{ fontSize: 26, color: C.ink, fontWeight: 600 }}>{c.t}</span>
          </div>
        );
      })}
      {/* model chips */}
      {MODELS.map((m, i) => {
        const p = modelPos(i, cx, cy);
        const s = useSpring(96 + i * 10);
        return (
          <div key={m} style={{ position: "absolute", left: p.x - 150, top: p.y - 32, width: 300, height: 64, borderRadius: 32, transform: `scale(${s})`, opacity: s,
            background: "#141210", border: `1.5px solid ${C.orange}`, color: C.ink, fontFamily: FONT, fontSize: 26, fontWeight: 600,
            display: "flex", alignItems: "center", justifyContent: "center" }}>{m}</div>
        );
      })}
      <div style={{ position: "absolute", width: "100%", top: 980, textAlign: "center", fontFamily: FONT, fontSize: 30, color: C.dim, opacity: ramp(f, 160, 180) }}>
        换哪个模型，都不用重读 —— 记忆存在你的电脑里
      </div>
    </Scene>
  );
};

function modelPos(i: number, cx: number, cy: number) {
  const pts = [{ x: cx - 620, y: cy + 120 }, { x: cx - 420, y: cy + 300 }, { x: cx + 420, y: cy + 300 }, { x: cx + 620, y: cy + 120 }];
  return pts[i];
}

// ============================================================ 5. Every quote is checked against the PDF
export const S5Grounded: React.FC = () => {
  const f = useCurrentFrame();
  const scan = ramp(f, 34, 70);
  const ok = useSpring(72, { damping: 8, mass: 0.5 });
  const bad = useSpring(104, { damping: 8, mass: 0.5 });
  const PX = 1200, PY = 230;
  const chips = [
    { t: "Figure 3", d: 128, body: <MiniChart /> },
    { t: "Eq. (1)", d: 140, body: <TeX tex={"\\mathrm{softmax}\\big(\\tfrac{QK^{\\top}}{\\sqrt{d_k}}\\big)V"} style={{ fontSize: 26, color: C.ink }} /> },
    { t: "§3.2", d: 152, body: <span style={{ color: C.ink, fontSize: 22 }}>3.2 Scaled Attention</span> },
    { t: "[17]", d: 164, body: <span style={{ color: "#d9d1c6", fontSize: 18 }}>[17] A. Author et al. On fast sequence models, 2016.</span> },
  ];
  return (
    <Scene dur={180}>
      <Caption n="03" title="每句引用，都回原文核对" sub="Every quote is checked against the PDF." />
      <div style={{ position: "absolute", left: PX, top: PY, transform: "rotate(2deg)" }}>
        <PaperPage w={520} seed={13} highlight={{ line: 9, progress: scan >= 1 ? 1 : 0, color: "rgba(74,222,128,0.45)" }} />
      </div>
      <div style={{ position: "absolute", left: 120, top: 330, width: 920, fontFamily: FONT, fontSize: 30, lineHeight: 1.9, color: "#d9d1c6" }}>
        <div>作者把缩放的原因写得很直接：</div>
        <div>
          <span style={{ color: C.ink, borderBottom: `3px solid ${ok > 0.1 ? C.green : C.faint}` }}>“scaling keeps the logits at unit variance”</span>
          <span style={{ color: C.orange }}> [p.4]</span>
          <span style={{ display: "inline-block", marginLeft: 10, color: C.green, fontWeight: 800, transform: `scale(${ok})` }}>✓</span>
        </div>
        <div style={{ opacity: ramp(f, 84, 96) }}>
          而“缩放让训练快 3 倍”这句，
          <span style={{ color: C.ink, borderBottom: `3px dashed ${bad > 0.1 ? C.red : C.faint}` }}>“trains three times faster”</span>
          <span style={{ color: C.orange }}> [p.6]</span>
          <span style={{ display: "inline-block", marginLeft: 10, color: C.red, fontWeight: 800, transform: `scale(${bad})` }}>⚠</span>
        </div>
        <div style={{ fontSize: 22, color: C.red, opacity: ramp(f, 108, 120) }}>原文里找不到 —— 模型改写或记错了，直接标出来</div>
      </div>
      {/* scan beam from the quote to the page */}
      <svg width={1920} height={1080} style={{ position: "absolute", pointerEvents: "none" }}>
        <defs>
          <linearGradient id="beam" x1="0" x2="1"><stop offset="0" stopColor={C.green} stopOpacity={0} /><stop offset="1" stopColor={C.green} stopOpacity={0.9} /></linearGradient>
        </defs>
        {f > 34 && f < 84 && (
          <path d={`M 700 412 C 900 300, 1050 330, ${PX + 60} ${PY + 290}`} fill="none" stroke="url(#beam)" strokeWidth={4}
            strokeDasharray={900} strokeDashoffset={900 * (1 - scan)} opacity={1 - ramp(f, 72, 84)} />
        )}
      </svg>
      {/* reference chips with previews */}
      <div style={{ position: "absolute", left: 120, top: 640, display: "flex", gap: 22, fontFamily: FONT }}>
        {chips.map((c) => {
          const s = useSpring(c.d);
          return (
            <div key={c.t} style={{ transform: `translateY(${(1 - s) * 40}px)`, opacity: s }}>
              <Chip style={{ fontSize: 26, borderBottom: `2px dashed ${C.orange}` }}>{c.t}</Chip>
              <div style={{ marginTop: 14, width: 230, minHeight: 120, background: "#1c1a17", border: `1px solid ${C.faint}`, borderRadius: 14, padding: 14,
                display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 16px 40px rgba(0,0,0,0.5)" }}>{c.body}</div>
            </div>
          );
        })}
      </div>
    </Scene>
  );
};

const MiniChart: React.FC = () => (
  <svg width={190} height={100}>
    {[0.4, 0.62, 0.55, 0.8, 0.95].map((v, i) => (
      <rect key={i} x={12 + i * 36} y={92 - v * 80} width={24} height={v * 80} rx={3} fill={i === 4 ? C.orange : "#6f665c"} />
    ))}
    <line x1={4} x2={186} y1={92} y2={92} stroke="#6f665c" />
  </svg>
);

// ============================================================ 6. Derivation map grows from the core claim
type N = { id: string; x: number; y: number; text: string; color: string; d: number; tex?: string; fig?: boolean; tags?: string[] };

export const S6Map: React.FC = () => {
  const f = useCurrentFrame();
  const cx = 960, cy = 610;
  const B: N[] = [
    { id: "p", x: cx - 400, y: cy - 250, text: "问题与动机", color: C.red, d: 20 },
    { id: "i", x: cx - 400, y: cy + 20, text: "关键想法", color: C.amber, d: 26 },
    { id: "m", x: cx - 400, y: cy + 250, text: "方法推导", color: C.blue, d: 32 },
    { id: "e", x: cx + 400, y: cy - 160, text: "实验证据", color: C.green, d: 38 },
    { id: "l", x: cx + 400, y: cy + 210, text: "局限", color: "#9ca3af", d: 44 },
  ];
  const L: (N & { parent: string })[] = [
    { id: "p1", parent: "p", x: cx - 700, y: cy - 310, text: "循环结构无法并行", color: C.red, d: 60, tags: ["p.2", "✓ 原文"] },
    { id: "p2", parent: "p", x: cx - 700, y: cy - 200, text: "长距离依赖难学", color: C.red, d: 66, tags: ["§1"] },
    { id: "i1", parent: "i", x: cx - 700, y: cy + 20, text: "每个位置直接看全局", color: C.amber, d: 72, tags: ["§3"] },
    { id: "m1", parent: "m", x: cx - 720, y: cy + 195, text: "", tex: "\\mathrm{softmax}\\big(\\tfrac{QK^{\\top}}{\\sqrt{d_k}}\\big)V", color: C.blue, d: 80, tags: ["Eq. (1)"] },
    { id: "m2", parent: "m", x: cx - 700, y: cy + 305, text: "多头并行投影", color: C.blue, d: 86, tags: ["§3.2"] },
    { id: "e1", parent: "e", x: cx + 690, y: cy - 280, text: "BLEU +2.0", color: C.green, d: 94, fig: true, tags: ["Table 2"] },
    { id: "e2", parent: "e", x: cx + 700, y: cy - 30, text: "消融：单头更差", color: C.green, d: 100, tags: ["Table 3"] },
    { id: "l1", parent: "l", x: cx + 700, y: cy + 210, text: "复杂度 O(n²d)", color: "#9ca3af", d: 106, tags: ["§4"] },
  ];
  const all: Record<string, N> = Object.fromEntries([...B, ...L].map((n) => [n.id, n]));
  const curve = (x1: number, y1: number, x2: number, y2: number) => `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
  const root = useSpring(6);
  const dep = ramp(f, 140, 172);
  const zoom = 0.9 + ramp(f, 0, 240) * 0.05;
  return (
    <Scene dur={240}>
      <Caption n="04" title="一键生成可编辑的推导图" sub="One click to a living map of the argument." />
      <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: `${cx}px ${cy}px` }}>
        <svg width={1920} height={1080} style={{ position: "absolute" }}>
          {B.map((b) => {
            const p = ramp(f, b.d - 10, b.d + 10);
            return <path key={b.id} d={curve(cx, cy, b.x, b.y)} fill="none" stroke={b.color} strokeWidth={4} strokeDasharray={800} strokeDashoffset={800 * (1 - p)} strokeLinecap="round" />;
          })}
          {L.map((l) => {
            const pa = all[l.parent];
            const p = ramp(f, l.d - 8, l.d + 8);
            return <path key={l.id} d={curve(pa.x, pa.y, l.x, l.y)} fill="none" stroke={l.color} strokeWidth={2.5} strokeOpacity={0.8} strokeDasharray={600} strokeDashoffset={600 * (1 - p)} />;
          })}
          {/* dependency: the equation supports the evidence */}
          <path d={`M ${cx - 555} ${cy + 175} C ${cx - 200} ${cy - 60}, ${cx + 250} ${cy - 420}, ${cx + 565} ${cy - 300}`} fill="none" stroke={C.orange}
            strokeWidth={2.5} strokeDasharray="10 8" opacity={dep} />
        </svg>
        <div style={{ position: "absolute", left: cx - 30, top: cy - 236, opacity: ramp(f, 160, 175), fontFamily: FONT, fontSize: 24, color: C.orange, fontWeight: 700,
          background: "rgba(11,10,9,0.8)", padding: "2px 10px", borderRadius: 6 }}>支撑</div>
        {/* root */}
        <div style={{ position: "absolute", left: cx - 210, top: cy - 52, width: 420, height: 104, borderRadius: 52, transform: `scale(${root})`,
          background: `linear-gradient(135deg, ${C.orange}, ${C.deep})`, boxShadow: "0 0 60px rgba(240,138,75,0.5)", color: "#fff", fontFamily: FONT,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontSize: 30, fontWeight: 800 }}>只用注意力建模序列</div>
          <div style={{ fontSize: 18, opacity: 0.85 }}>核心主张</div>
        </div>
        {B.map((b) => <MapNode key={b.id} n={b} branch />)}
        {L.map((l) => <MapNode key={l.id} n={l} />)}
      </AbsoluteFill>
    </Scene>
  );
};

const MapNode: React.FC<{ n: N; branch?: boolean }> = ({ n, branch }) => {
  const f = useCurrentFrame();
  const s = useSpring(n.d, { damping: 12, mass: 0.5 });
  const w = branch ? 210 : n.fig ? 250 : n.tex ? 330 : 290;
  return (
    <div style={{ position: "absolute", left: n.x - w / 2, top: n.y - (n.fig ? 80 : 34), width: w, transform: `scale(${s})`, opacity: s,
      background: branch ? "#1c1a17" : "#151311", border: `2px solid ${n.color}`, borderRadius: branch ? 40 : 14, padding: branch ? "14px 0" : "10px 14px",
      textAlign: branch ? "center" : "left", fontFamily: FONT, boxShadow: "0 14px 34px rgba(0,0,0,0.5)" }}>
      {n.fig && <div style={{ background: "#f4efe7", borderRadius: 8, marginBottom: 8, display: "flex", justifyContent: "center" }}><MiniChart /></div>}
      <div style={{ color: C.ink, fontSize: branch ? 28 : 24, fontWeight: branch ? 700 : 500 }}>
        {n.tex ? <TeX tex={n.tex} style={{ fontSize: 26 }} /> : n.text}
      </div>
      {!branch && n.tags && (
        <div style={{ marginTop: 6, display: "flex", gap: 6, opacity: ramp(f, n.d + 60, n.d + 76) }}>
          {n.tags.map((t) => (
            <span key={t} style={{ fontSize: 15, padding: "1px 8px", borderRadius: 5, background: t.startsWith("✓") ? "rgba(74,222,128,0.16)" : "rgba(240,138,75,0.16)",
              color: t.startsWith("✓") ? C.green : C.orange, fontWeight: 600 }}>{t}</span>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================ 7. Native, every model, open source
export const S7Platform: React.FC = () => {
  const f = useCurrentFrame();
  const rows = [
    { big: "macOS 原生 App", small: "双击打开 · 拖入 PDF · 数据都在本地", d: 10 },
    { big: "Claude Code · Anthropic API · Codex · 本地模型", small: "用你已有的订阅，或者完全离线", d: 40 },
    { big: "开源 · AGPL-3.0", small: "github.com/xinhaoc/interpretability", d: 70 },
  ];
  const dock = useSpring(16);
  const bounce = Math.abs(Math.sin(Math.max(0, f - 30) / 6)) * Math.max(0, 1 - (f - 30) / 50) * 50;
  return (
    <Scene dur={180}>
      <div style={{ position: "absolute", left: 160, top: 210, fontFamily: FONT }}>
        {rows.map((r) => {
          const p = ramp(f, r.d, r.d + 22);
          return (
            <div key={r.big} style={{ marginBottom: 64, opacity: p, transform: `translateX(${(1 - p) * -60}px)` }}>
              <div style={{ fontSize: 60, fontWeight: 800, color: C.ink }}>{r.big}</div>
              <div style={{ fontSize: 28, color: r.small.startsWith("github") ? C.orange : C.dim, marginTop: 10, fontFamily: r.small.startsWith("github") ? MONO : FONT }}>{r.small}</div>
            </div>
          );
        })}
      </div>
      {/* a stylised dock */}
      <div style={{ position: "absolute", left: 1290, top: 820, width: 470, height: 120, borderRadius: 34, transform: `translateY(${(1 - dock) * 200}px)`,
        background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)", backdropFilter: "blur(10px)", display: "flex", alignItems: "center", justifyContent: "space-evenly" }}>
        {[0, 1, 2].map((i) => (
          i === 1
            ? <AppIcon key={i} size={96} style={{ transform: `translateY(${-bounce}px)` }} />
            : <div key={i} style={{ width: 86, height: 86, borderRadius: 22, background: i === 0 ? "#2a2a33" : "#2d3a33", opacity: 0.8 }} />
        ))}
      </div>
      <div style={{ position: "absolute", left: 1525 - 4, top: 948, width: 8, height: 8, borderRadius: 4, background: C.ink, opacity: ramp(f, 60, 70) }} />
    </Scene>
  );
};

// ============================================================ 8. End card
export const S8End: React.FC = () => {
  const f = useCurrentFrame();
  const s = useSpring(4, { damping: 12, mass: 0.7 });
  const url = "github.com/xinhaoc/interpretability";
  const typed = url.slice(0, Math.floor(ramp(f, 40, 90) * url.length));
  return (
    <Scene dur={210} fadeOut={30}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily: FONT }}>
        <AppIcon size={200} style={{ transform: `scale(${s})`, filter: "drop-shadow(0 20px 60px rgba(240,138,75,0.45))" }} />
        <div style={{ marginTop: 30, fontSize: 96, fontWeight: 800, color: C.ink, letterSpacing: -1 }}>
          <Reveal text="interpretability" delay={10} step={1.4} />
        </div>
        <div style={{ marginTop: 12, fontSize: 34, color: C.orange, letterSpacing: 6, fontWeight: 600, opacity: ramp(f, 30, 50) }}>读懂每一篇论文</div>
        <div style={{ marginTop: 50, fontFamily: MONO, fontSize: 32, color: C.ink, padding: "14px 28px", borderRadius: 14,
          border: `1px solid ${C.faint}`, background: "rgba(255,255,255,0.04)", opacity: ramp(f, 36, 46), minWidth: 720, textAlign: "center" }}>
          {typed}<span style={{ opacity: Math.floor(f / 8) % 2 ? 1 : 0, color: C.orange }}>▍</span>
        </div>
      </AbsoluteFill>
    </Scene>
  );
};

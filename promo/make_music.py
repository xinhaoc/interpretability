"""Synthesises the promo soundtrack (no samples, nothing copyrighted).

120 BPM in A minor. Scene boundaries (seconds) line up with the video:
0 hook · 5 logo · 8 select · 16 memory · 23 grounded · 29 map · 37 platform · 43 end · 50

Usage: python make_music.py out.wav
"""
import sys
import wave

import numpy as np

SR = 44100
LEN = 50.0
N = int(SR * LEN)
BEAT = 0.5
rng = np.random.default_rng(7)
L = np.zeros(N)
R = np.zeros(N)


def t_(dur):
    return np.arange(int(dur * SR)) / SR


def put(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    L[i:i + len(sig)] += sig * gain * (1 - max(0, pan))
    R[i:i + len(sig)] += sig * gain * (1 + min(0, pan))


def saw(freq, dur, harm=14, roll=0.82, detune=0.0):
    t = t_(dur)
    f = freq * (1 + detune)
    out = np.zeros_like(t)
    for k in range(1, harm + 1):
        if f * k > 9000:
            break
        out += np.sin(2 * np.pi * f * k * t) * (roll ** k) / k
    return out


def env(n, a, r, sustain_end=None):
    """Linear attack, hold, exponential-ish release over n samples."""
    e = np.ones(n)
    na = max(1, int(a * SR))
    e[:na] = np.linspace(0, 1, na)
    nr = max(1, int(r * SR))
    if nr < n:
        e[-nr:] *= np.linspace(1, 0, nr) ** 2
    return e


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


# ---------------------------------------------------------------- instruments

def kick(gain=1.0):
    t = t_(0.5)
    f = 45 + 75 * np.exp(-t / 0.035)
    phase = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(phase) * np.exp(-t / 0.22)
    click = rng.standard_normal(len(t)) * np.exp(-t / 0.004) * 0.25
    return (body + click) * gain


def hat(gain=1.0, dur=0.08):
    t = t_(dur)
    x = rng.standard_normal(len(t))
    x = np.diff(np.diff(x, prepend=0), prepend=0)  # crude high-pass
    return x * np.exp(-t / 0.018) * 0.18 * gain


def snare(gain=1.0):
    t = t_(0.3)
    x = rng.standard_normal(len(t))
    x = np.diff(x, prepend=0)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05)
    return (x * np.exp(-t / 0.09) * 0.35 + tone * 0.3) * gain


def pluck(m, dur=0.35, gain=1.0):
    t = t_(dur)
    s = saw(midi(m), dur, harm=8, roll=0.7) * np.exp(-t / 0.09)
    s += np.sin(2 * np.pi * midi(m + 12) * t) * np.exp(-t / 0.05) * 0.3
    return s * gain


def pad(notes, dur, gain=1.0, a=0.8, r=1.2):
    n = int(dur * SR)
    outL, outR = np.zeros(n), np.zeros(n)
    for m in notes:
        for d, side in ((-0.004, 0), (0.0035, 1), (0.0, 2)):
            s = saw(midi(m), dur, harm=10, roll=0.7, detune=d)[:n]
            if side == 0:
                outL += s
            elif side == 1:
                outR += s
            else:
                outL += s * 0.6
                outR += s * 0.6
    e = env(n, a, r)
    return outL * e * gain, outR * e * gain


def put_stereo(lr, at, gain=1.0):
    l, r = lr
    i = int(at * SR)
    if i >= N:
        return
    l, r = l[: N - i], r[: N - i]
    L[i:i + len(l)] += l * gain
    R[i:i + len(r)] += r * gain


def bass(m, dur, gain=1.0):
    t = t_(dur)
    s = saw(midi(m), dur, harm=6, roll=0.6) + np.sin(2 * np.pi * midi(m) * t) * 0.8
    return s * env(len(t), 0.005, 0.08) * gain


def riser(dur, gain=1.0):
    t = t_(dur)
    x = rng.standard_normal(len(t))
    # band-limited noise whose brightness rises, via a moving average that shrinks
    out = np.zeros_like(x)
    for k, w in enumerate(np.linspace(40, 2, 8)):
        seg = slice(int(len(x) * k / 8), int(len(x) * (k + 1) / 8))
        out[seg] = np.convolve(x, np.ones(int(w)) / int(w), mode="same")[seg]
    sweep = np.sin(2 * np.pi * np.cumsum(200 + 1800 * (t / dur) ** 2) / SR) * 0.15
    return (out * 0.6 + sweep) * (t / dur) ** 2.2 * gain


def impact(gain=1.0):
    t = t_(3.0)
    boom = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-t / 0.08)) / SR) * np.exp(-t / 0.9)
    noise = np.diff(rng.standard_normal(len(t)), prepend=0) * np.exp(-t / 0.35) * 0.25
    return (boom + noise) * gain


# ---------------------------------------------------------------- arrangement
CHORDS = [  # (pad notes, bass root) — Am, F, C, G
    ([57, 60, 64, 71], 33), ([53, 57, 60, 67], 29), ([55, 60, 64, 67], 36), ([55, 59, 62, 67], 31),
]
ARP = [0, 2, 1, 3, 2, 1, 3, 2]

# intro 0–5: pad, heartbeat, riser into the logo
put_stereo(pad([45, 57, 60, 64, 71], 5.6, a=2.5, r=1.0), 0.0, 0.05)
for k in range(1, 5):
    put(kick(0.35), float(k), 0.8)
put(riser(2.4), 2.6, 0.5)

# logo hit at 5, a breath until 8
put(impact(), 5.0, 0.9)
put_stereo(pad([57, 64, 69, 72, 76], 3.2, a=0.01, r=2.5), 5.0, 0.06)
for i, m in enumerate([69, 72, 76, 79, 81, 79, 76, 72, 76, 79, 81, 84]):
    put(pluck(m, gain=0.5), 5.4 + i * 0.22, 0.35, pan=0.3 if i % 2 else -0.3)
put(riser(1.5), 6.5, 0.35)

# groove 8–43
GROOVE_END = 43.0
bar = 0
t0 = 8.0
while t0 < GROOVE_END - 1e-6:
    notes, root = CHORDS[bar % 4]
    put_stereo(pad(notes, 2.1, a=0.15, r=0.4), t0, 0.045)
    for b in range(4):
        tb = t0 + b * BEAT
        if tb >= GROOVE_END:
            break
        put(kick(), tb, 0.9)
        put(hat(), tb + BEAT / 2, 0.9, pan=0.25)
        if b in (1, 3):
            put(snare(), tb, 0.55)
        for e in range(2):
            put(bass(root + (12 if e else 0), BEAT / 2 * 0.9), tb + e * BEAT / 2, 0.28)
    # quiet arpeggio on the chord tones, from the memory scene on
    if t0 >= 16:
        for s in range(8):
            put(pluck(notes[ARP[s]] + 12, dur=0.25, gain=0.35), t0 + s * BEAT / 2, 0.5, pan=0.4 if s % 2 else -0.4)
    bar += 1
    t0 += 4 * BEAT

# transitions on scene boundaries: a short snare fill and a swell
for tb in (16.0, 23.0, 29.0, 37.0):
    for k in range(4):
        put(snare(0.5 + k * 0.15), tb - BEAT + k * BEAT / 4, 0.4)
    put(riser(1.0), tb - 1.0, 0.25)
put(riser(2.0), 41.0, 0.45)

# end 43–50
put(impact(1.1), 43.0, 0.9)
put_stereo(pad([45, 57, 64, 69, 72, 76], 7.0, a=0.02, r=5.0), 43.0, 0.06)
for i, m in enumerate([81, 76, 72, 69, 72, 76, 81, 84]):
    put(pluck(m, dur=0.6, gain=0.5), 43.6 + i * 0.4, 0.3 * (1 - i / 10), pan=0.3 if i % 2 else -0.3)


# ---------------------------------------------------------------- reverb, master
def reverb(x, seconds=1.8, mix=0.18, seed=1):
    g = np.random.default_rng(seed)
    n = int(seconds * SR)
    ir = g.standard_normal(n) * np.exp(-np.arange(n) / (SR * seconds / 6))
    ir /= np.sqrt(np.sum(ir ** 2))
    size = 1 << int(np.ceil(np.log2(len(x) + n)))
    wet = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[: len(x)]
    return x * (1 - mix) + wet * mix


L = reverb(L, seed=1)
R = reverb(R, seed=2)
fade = np.ones(N)
fn = int(2.5 * SR)
fade[-fn:] = np.linspace(1, 0, fn) ** 1.5
L *= fade
R *= fade
peak = max(np.abs(L).max(), np.abs(R).max())
L, R = np.tanh(L / peak * 1.4) / np.tanh(1.4) * 0.89, np.tanh(R / peak * 1.4) / np.tanh(1.4) * 0.89

out = np.stack([L, R], axis=1)
pcm = (out * 32767).astype(np.int16)
with wave.open(sys.argv[1] if len(sys.argv) > 1 else "music.wav", "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print("wrote", LEN, "s")

"""Compose and render the original 32-second lake cue, including wrapped reverb tails."""
from pathlib import Path
import subprocess
import wave

import imageio_ffmpeg
import numpy as np


HERE = Path(__file__).resolve().parent
RATE = 44100
SECONDS = 32
COUNT = RATE * SECONDS
mix = np.zeros((COUNT, 2), dtype=np.float64)


def hz(note):
    return 440 * 2 ** ((note - 69) / 12)


def place(stereo, start):
    pos = round(start * RATE) % COUNT
    split = min(len(stereo), COUNT - pos)
    mix[pos:pos + split] += stereo[:split]
    mix[:len(stereo) - split] += stereo[split:]


def pan(notes, at):
    return np.stack((notes * np.cos(at), notes * np.sin(at)), axis=1)


def harp(note, start, velocity, angle):
    t = np.arange(round(4.65 * RATE)) / RATE
    freq = hz(note)
    attack = 1 - np.exp(-t / .012)
    tone = sum(strength * np.exp(-t / decay) * np.sin(2 * np.pi * freq * mult * t)
               for mult, strength, decay in [(1, 1, 1.15), (2.001, .34, .67), (3.003, .21, .47), (4.004, .085, .28)])
    tail = np.clip((t[-1] - t) / .28, 0, 1)
    dry = pan(velocity * attack * tone * tail, angle)
    for delay, strength in [(0, 1), (.147, .13), (.316, .085), (.527, .048), (.791, .022)]:
        place(dry if delay == 0 else dry[:, ::-1] * strength, start + delay)


def bowed(note, start, intensity, angle):
    t = np.arange(round(5.8 * RATE)) / RATE
    env = np.sin(.5 * np.pi * np.clip(t / 1.32, 0, 1)) ** 2
    env *= np.sin(.5 * np.pi * np.clip((5.8 - t) / 1.90, 0, 1)) ** 2
    f = hz(note)
    sound = (np.sin(2 * np.pi * f * t) + .29 * np.sin(2 * np.pi * f * 1.0024 * t + .43)
             + .18 * np.sin(2 * np.pi * 2 * f * t + .12 * np.sin(t * 2.1)))
    place(pan(intensity * env * sound, angle), start - .65)


chords = [(50,57,61,66),(47,54,62,66),(43,55,59,66),(45,57,62,64),
          (42,54,61,64),(43,55,59,62),(45,52,59,62),(50,57,62,66)]
melodies = [
    [(0.38,69), (1.82,74), (2.63,78)], [(0.12,78), (1.46,76), (3.05,73)],
    [(0.28,71), (1.75,74)], [(0.65,69), (2.20,76), (3.42,74)],
    [(0.46,73), (1.90,69)], [(0.18,71), (1.58,74), (2.83,78)],
    [(0.52,76), (2.48,69)], [(0.08,74), (2.40,66), (3.35,69)]
]
for bar, chord in enumerate(chords):
    at = 4 * bar
    for j, note in enumerate(chord):
        bowed(note, at + .035 * j, (.080, .041, .033, .025)[j], (.74, .56, .96, .80)[j])
    for k, (offset, note) in enumerate(melodies[bar]):
        harp(note, at + offset, (.130, .112, .089)[k], (.70, .99, .56)[(k + bar) % 3])
    harp(chord[1], at + .04, .057, .61)
    if bar in [1, 3, 6]:
        harp(chord[2] + 12, at + 3.73, .039, 1.01)

mix *= .63 / np.max(np.abs(mix))
out = HERE / 'music'
out.mkdir(exist_ok=True)
wav = out / '湖畔夜曲.wav'
samples = np.rint(np.clip(mix, -1, 1) * 32767).astype('<i2')
with wave.open(str(wav), 'wb') as stream:
    stream.setparams((2, 2, RATE, COUNT, 'NONE', 'not compressed'))
    stream.writeframes(samples.tobytes())
subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-y', '-i', str(wav),
                '-c:a', 'libopus', '-b:a', '96k', '-metadata', 'title=湖畔夜曲', str(out / 'lake.opus')], check=True)
print('32 seconds, RMS %.2f dBFS, endpoint delta %.5f' %
      (20 * np.log10(np.sqrt(np.mean(mix ** 2))), np.abs(mix[-1] - mix[0]).max()))


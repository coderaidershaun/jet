# Test sounds for the voice detector

Both files are 16 kHz, mono, 16-bit WAV with a 44-byte header, the sound Jet's voice detector is given. `vad.test.mjs` is the only test that reads them.

`noise.wav` was made by a one-off Rust program kept outside the repository (it is not part of the build), with no network:

    make-fixtures <output folder> --noise-only       # made 2026-10-29

## noise.wav

1.5 s of quiet white noise (samples within +-300) from a fixed seed, with a 0.3 s louder burst (+-4000) in the middle, like a cough or a knock. It must look like no speech to the detector. Same generator as the noise in `crates/agent/tests/hear_live.rs`.

## hello.wav

2.96 s (94,800 bytes) of eSpeak NG saying "Hello Jet, what time is it?". It is synthetic formant speech, not a human voice and not Gemini's voice, and it is used only as a speech-shaped input for the voice detector.

Why not Gemini: Jet's own speech call (`agent::voice::speak`) was tried three times on 2026-10-29 and answered 429 (rate limited) each time, so no Google audio was made.

How it was made, on 2026-10-29:

- eSpeak NG 1.51 (Ubuntu noble package `1.51+dfsg-12build1`), unpacked into a temporary folder with `dpkg -x`, not installed on the machine.
- Voice `en-us`, speed 120 words a minute, the words exactly "Hello Jet, what time is it?", written once with:

      espeak-ng -v en-us -s 120 -w hello-22khz.wav "Hello Jet, what time is it?"

- eSpeak writes 22,050 Hz mono 16-bit. A small script then lowered that to 16 kHz by linear interpolation and wrote the 44-byte header. No low-pass filter was applied first; that is good enough for a test input of the voice detector, which is not a speech recogniser.

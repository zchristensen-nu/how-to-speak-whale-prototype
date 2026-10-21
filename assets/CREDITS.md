# Credits

All audio: **Project CETI** (press kit, used for coverage with credit). Source dir: `~/Downloads/CETI Media/04. Audio/`. Re-encoded to mono AAC (`afconvert`); no other processing. Birth recordings at 40 kbps, the rest at 64 kbps. The press kit's 120 kHz originals play back at 48 kHz in the m4a (resampled; duration unchanged).

| File | Source filename | Credit |
|---|---|---|
| assets/audio/pinchy-conversation.m4a | Vowel and Dipthong like Spectral Patterns/Conversation by Pinchy in real time (Credit Project CETI).wav | Audio: Project CETI |
| assets/audio/pinchy-no-timing.m4a | …/Example of whale named Pinchy conversation with timing removed (Credit Project CETI).wav | Audio: Project CETI |
| assets/audio/pinchy-a.m4a | …/An example of whale named Pinchy _a_ vowel (Credit Project CETI).wav | Audio: Project CETI |
| assets/audio/pinchy-i.m4a | …/Example of whale named Pinchy _i_ vowel (Credit Project CETI).wav (the other near-duplicate, "Credit_ Project CETI", differs by bytes but not duration; not used) | Audio: Project CETI |
| assets/audio/pinchy-a-fast.m4a | …/Example 2 of sped up _a_ vowel from whale named Pinchy (Project CETI).wav | Audio: Project CETI |
| assets/audio/fork-vowels.m4a | …/Example of sped up whale whale vowels from whale named Fork (Audio Project CETI).wav | Audio: Project CETI |
| assets/audio/birth-01.m4a … birth-04.m4a | Whale Birth Audio/Audio 01_cr © Project CETI.wav … Audio 04_cr © Project CETI.wav | Audio: Project CETI |

## Derived data

- `data/pinchy-clicks.json`: waveform peaks, detected clicks and coda grouping computed from `pinchy-conversation` (Audio: Project CETI). Automatic detection, not hand-annotated.
- `data/codas.json`:
  - Coda types and rhythms: Dominica sperm whale coda dataset (`DominicaCodas.csv`).
  - Exchange: record `sw085a003_20645` of `sperm-whale-dialogues.csv`; whale ids are as given in the data.
  - Data citation: Zenodo 10.5281/zenodo.10817697, CC BY 4.0 (Sharma et al., Nature Communications 2024).

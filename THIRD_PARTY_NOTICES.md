# Component notices

The MIT license at the repository root covers the project's original code. Third-party code, binaries, voices, weights and related documentation retain their accompanying licenses. DeepSeek Harness is installed separately.

- SenseVoiceSmall is by Alibaba's FunAudioLLM and FunASR teams. The complete installer includes the int8 ONNX conversion by csukuangfj and the original token list. The model license is supplied in `licenses/SenseVoice-MODEL-LICENSE.txt`. [Original model](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) · [ONNX conversion](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17)
- Silero VAD is by the Silero Team and contributors, licensed under MIT. The accompanying license is in `licenses/Silero-LICENSE.txt`. The immutable asset revisions and hashes used by the speech installer are in `speech.lock.json`. [Silero VAD](https://github.com/snakers4/silero-vad)
- BGE-M3 is by BAAI, with ONNX weights from Xenova. The model's MIT notice, tokenizer and runtime inventory are under `packages/desktop/components/memory`. [Model](https://huggingface.co/BAAI/bge-m3) · [ONNX weights](https://huggingface.co/Xenova/bge-m3)
- The packaged desktop component contains individual notices for the Harness client protocol, ONNX Runtime, tokenizers, Silero, ws, dsh-codex-peer and eSpeak NG. The eSpeak NG distribution includes its license, copyright and corresponding source under `THIRD_PARTY_LICENSES/espeak-ng`. [Desktop notices](packages/desktop/THIRD_PARTY_NOTICES.md)
- The original public soundtrack is 《湖畔夜曲》. The source score lives in `art/score.py`. The lake illustrations and rendered scenery accompany this release. Names, trademarks and underlying character rights belong to their respective owners.


# Third-party notices
DeepSeek Harness SDK @deepseek-ai/* 0.2.1-rc.2 and Cordis 4.0.5 remain in the installed runtime. Package manifests declare MIT.
Generated browser bundles embed dsh-typert-protocol/lib/types/remote-info.js from that SDK. React, ReactDOM and Zod come from the Harness browser loader, not duplicate copies.
Source: https://github.com/deepseek-ai/deepseek-harness . The copied SDK code is covered by THIRD_PARTY_LICENSES/DeepSeek-Harness-MIT.txt, included in each tarball. The desktop SDK itself is not redistributed here. The full Windows installer supplies separate SenseVoice model files. See the release licenses for the model and VAD.

## ws 8.22.0

WebSocket transport vendored unmodified from the installed host dependency. Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>; Copyright (c) 2013 Arnout Kazemier and contributors. MIT license: packages/voice/vendor/ws/LICENSE (included in voice package).

## Silero VAD 6.2.3 / ONNX Runtime Web 1.27.0

The voice plugin includes the Silero VAD model and ONNX Runtime Web WASM files for offline speech detection. Versions, SHA256 hashes and upstream verification are recorded in assets/vad/manifest.json. Upstream sources: https://github.com/snakers4/silero-vad and https://github.com/microsoft/onnxruntime. Their original MIT license notices are included in assets/vad/. No original assistant executable or server is required.

## BGE-M3 / ONNX Runtime Node and Common 1.27.0 / Hugging Face Tokenizers 0.2.0

The memory plugin includes public BAAI/bge-m3 int8 weights from Xenova/bge-m3 revision 4de13258303883538bd53b696b452bf8099f0858, its tokenizer and MIT notice (assets/bge-m3/LICENSE). Sources: https://huggingface.co/Xenova/bge-m3 and https://github.com/FlagOpen/FlagEmbedding . These resources match the publicly distributed model hashes; no original assistant server, executable or account is included or required.

Microsoft ONNX Runtime Node/Common 1.27.0 (MIT), Windows x64 runtime binaries and third-party notices are in vendor/onnxruntime-node and vendor/onnxruntime-common. Official npm packages are integrity-checked; the only source modification relocates require("onnxruntime-common") to the adjacent vendored runtime. Hugging Face @huggingface/tokenizers 0.2.0 is unmodified (Apache-2.0; vendor/tokenizers/LICENSE). Versions, exact npm integrity strings, source locations and per-file SHA256 are in assets/embedding-manifest.json. Native DLLs retain upstream accompanying notices. No package install scripts execute during model preparation.

## eSpeak NG 1.52.0

GPL-3.0-or-later。使用官方 Windows CLI 独立进程；二进制未修改。许可证、版权和完整对应源码随包位于 THIRD_PARTY_LICENSES/espeak-ng。项目：https://github.com/espeak-ng/espeak-ng/tree/1.52.0 。

## dsh-codex-peer 0.3.4

固定提交 462785afdd5f8d33ddd56006ecb8a498d6ba84e4，Anthony Wu，MIT。源码及 LICENSE 位于 components/coding/vendor/dsh-codex-peer/。

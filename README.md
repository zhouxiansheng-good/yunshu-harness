# 云舒 · DeepSeek Harness

云舒把长期记忆和任务派单接到 DeepSeek Harness 的主聊天。你可以先和 DeepSeek 商量目标，确定验收标准，再让它派单。打开任务台，就能看到这次派单写了什么、交给谁、有没有交回结果。

**[下载 Windows x64 完整安装包](https://github.com/zhouxiansheng-good/yunshu-harness/releases/download/r39/Yunshu-R39-Windows-x64.zip)** · [版本和校验值](https://github.com/zhouxiansheng-good/yunshu-harness/releases/tag/r39)

## 安装 R39

1. 在 Windows x64 上安装并至少打开一次 DeepSeek Harness。此版已验证的宿主 CLI 版本为 `0.2.2-rc.1`。
2. 完整退出 Harness，将下载的 ZIP 解压到普通文件夹。
3. 双击 `Install-Yunshu.cmd`，核对显示的桌面程序和数据目录，输入 `YES`。安装程序会升级同名的两个插件。再次打开你平时使用的 Harness。
4. 主输入框旁边有「云舒」和总开关。总开关开启后，直接使用宿主主聊天即可。点击「云舒」可以看任务、记忆和各模块设置。模型登录沿用 Harness 的账号或供应商配置。

完整包包含离线记忆向量模型、中文语音识别模型、桌面插件和联合体。安装目录需要额外空间存储本地模型和插件缓存。Codex、Claude Code 与其他外部执行器需要各自的可用安装与授权。音乐按钮播放云舒的原创配乐《湖畔夜曲》。

## 日常使用

| 想做什么 | 操作 |
| --- | --- |
| 从想法派单 | 在主聊天说明需求，和 DeepSeek 澄清目标、验收标准与可选交付文件。要求开始执行后，在任务台查看同一会话的任务和回执。 |
| 查看或修订记忆 | 打开「记忆」查看事实和存档位置。自动记忆默认开启，模块开关可以调整。 |
| 调整协作方式 | 在「人格」里编辑个人规则、标准和情感回应。 |
| 使用语音与音乐 | 使用云舒右上角的麦克风、耳机和音乐按钮。「语音」里可配置识别和朗读方式。 |
| 接入其他能力 | 桌面插件登记能力和开关，联合体处理任务、派单和回执。外部适配器需报告可用状态及交付凭证。 |

## 仓库结构

- `packages/desktop` 包含主聊天接入、系统和分项开关、记忆、语音、人格、媒体、扩展接口和面板。
- `packages/united` 包含会话任务、澄清派单、执行记录、任务台和交付核验。
- `installer` 使用 Harness 自带的插件管理命令，在所选桌面配置内安装。`scripts/build.py` 从本仓库源码生成公开发行包。
- `art/score.py` 是《湖畔夜曲》的合成源文件。阿瓦隆开场和湖畔循环素材位于 `packages/desktop/components/avalon/media`。

## 从源码构建

使用 Python 3.11 或以上版本。在仓库根目录运行下列命令。脚本从固定的上游版本获取 BGE 和 SenseVoice 模型，逐项比对 SHA-256，可在后续构建中复用缓存。

```powershell
python scripts/build.py
```

生成文件为 `dist/Yunshu-R39-Windows-x64.zip`。已有模型时可传 `--bge-model` 和 `--speech-models` 进行离线构建。使用 `Install-Yunshu.ps1 -Action Check` 可在安装前验证宿主、两个插件包和语音模型。卸载使用 `Install-Yunshu.ps1 -Action Remove`，卸载后可继续使用原有 Harness 会话。

云舒自有代码以 MIT 许可证开放。模型、语音工具及其他第三方组件的来源和许可见 [第三方说明](THIRD_PARTY_NOTICES.md)。


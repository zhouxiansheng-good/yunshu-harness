# 云舒 · DeepSeek Harness

云舒把长期记忆和任务派单接到 DeepSeek Harness 的主聊天。你可以先和 DeepSeek 商量目标，确定验收标准，再让它派单。工单由 DeepSeek 建立并派发，Claude Code 规划，GPT 经 Codex 执行，再由独立的 Claude Code 会话审核。审核退回时，DeepSeek 带上原标准和整改意见重开关联工单。通过后，DeepSeek 在主聊天交付结果。

[下载最新公开安装包和校验值](https://github.com/zhouxiansheng-good/yunshu-harness/releases/latest)

## 安装

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
| 查看渠道 | 展开任务台的「能力与渠道」，查看协作成员、职责、可用数量和故障处理办法。仅完成配置的渠道显示「待验证」。 |
| 添加模块 | 选择「新建模块」，填写用途，然后添加渠道并绑定已安装的扩展。图像生成和视频生成已预留模块。 |

已安装的适配器使用 `yunshuControl.registerCapability` 登记渠道标识、工具参数及执行函数。适配器可用 `moduleId` 指定 `image`、`video`、`agents` 或自定义模块。任务台可重新绑定所属模块。Claude 规划需要的渠道，GPT 提交工具参数，云舒核对返回文件的路径和摘要，再交给 Claude 审核。

## 仓库结构

- `packages/desktop` 包含主聊天接入、系统和分项开关、记忆、语音、人格、媒体、扩展接口和面板。
- `packages/united` 包含会话任务、澄清派单、执行记录、任务台和交付核验。
- `installer` 使用 Harness 自带的插件管理命令，在所选桌面配置内安装。`scripts/build.py` 从本仓库源码生成公开发行包。
- `art/score.py` 是《湖畔夜曲》的合成源文件。阿瓦隆开场和湖畔循环素材位于 `packages/desktop/components/avalon/media`。

## 从源码构建

构建需要 Python 3.11+ 和 Node.js 20+。在仓库根目录运行下列命令。脚本按 Harness 的桌面加载方式检查两个插件的前端入口，从固定的上游版本获取 BGE 和 SenseVoice 模型，并逐项比对 SHA-256。模型可在后续构建中复用。

```powershell
python scripts/build.py
```

生成文件为 `dist/Yunshu-R41-Windows-x64.zip`。已有模型时可传 `--bge-model` 和 `--speech-models` 进行离线构建。使用 `Install-Yunshu.ps1 -Action Check` 可在安装前验证宿主、两个插件包和语音模型。卸载使用 `Install-Yunshu.ps1 -Action Remove`，卸载后可继续使用原有 Harness 会话。

云舒自有代码以 MIT 许可证开放。模型、语音工具及其他第三方组件的来源和许可见 [第三方说明](THIRD_PARTY_NOTICES.md)。

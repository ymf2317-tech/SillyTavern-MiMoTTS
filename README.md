# SillyTavern-MiMoTTS

把**小米 MiMo 语音合成**（`mimo-v2.5-tts`）接入 SillyTavern 的一个 TTS 供应商扩展。
安装后，酒馆 TTS 面板的 Provider 下拉框里会多出 **MiMo** 一项。

> 状态：**v0.1 / 实验性**。作者时间有限，不保证及时响应 issue 或跟进 MiMo API 变动。
> 欢迎 fork、PR、或者直接把这当成一份「踩坑记录」拿去改。见下方[开发者说明](#开发者说明踩坑记录)。

---

## ⚠️ 先读这里：已知限制

**这三条是酒馆播放器架构 + MiMo 合成速度共同决定的，扩展层解决不了。请先确认你能接受再装。**

| 限制 | 说明 |
|---|---|
| **1. 整段播放要等 5~10 秒** | 小米的合成速度约 **50 毫秒/字**，200 字的消息要约 10 秒才出声（声音完整连贯，不能提前出声） |
| **2. 分块播放会有间断** | 酒馆全程只用一个 `<audio>` 播放器，每换一次音源要重新解码等待 **0.3~0.5 秒**。所以只要能分块，就必然一顿一顿——"分块播放"无法做到连贯 |
| **3. 点「停止」按钮可能残留一条语音** | 酒馆停播时**不会通知**供应商取消已发出的请求。扩展只能做到"新请求覆盖旧请求"。想中断请**改点另一条消息**，而不是按停止 |

**背景**：MiMo 是"整段合成完才返回"，而酒馆的播放器每次换音源都有硬开销。
**想要"零卡顿 + 低延迟"两者兼得，需要修改酒馆核心的播放器**（改用 Web Audio / MediaSource 无缝拼接），不是这个扩展能做的。这也是本仓库发出来的主要目的之一。

---

## 功能

- 酒馆原生供应商（下拉框直接选），支持酒馆的 **Voice Map**（角色→音色映射）
- **整段播放**（默认）：完全连贯，零卡顿
- **分块播放**（实验性）：首音约 2 秒，但块间有间断
- 支持**风格指令**（如 `用轻快上扬的语调，语速稍快`），会作为 `user` 消息传给模型
- **取消在途请求**：切换消息时自动中止上一个还在合成的请求，避免"迟到的语音乱入"
- 浏览器直连小米 API，**不需要服务器中转、不需要装服务端插件**

---

## 前置要求

1. 一个**小米 MiMo 开放平台**账号，并创建 API Key
   （在 MiMo 开放平台的 API Keys 页面获取；TTS 模型目前限时免费）
2. SillyTavern **较新版本**（在 `1.18.0` 上测试通过）。扩展 API `registerTtsProvider` 需要较新版本才支持。

---

## 安装

### 方法一：酒馆内一键安装（推荐）

1. 打开 SillyTavern → 左侧 **Extensions**（扩展面板）
2. 找到 **Install extension** 输入框
3. 粘贴本仓库地址，例如：
   ```
   https://github.com/ymf2317-tech/SillyTavern-MiMoTTS
   ```
4. 点 **Install**，安装完成后**刷新页面**（重要，见下方排障）

> 酒馆是用 `git clone` 安装的，所以仓库里**根目录必须有 `manifest.json`**（本仓库已满足）。
> 想更新时，在扩展面板点该扩展的**更新按钮**即可。

### 方法二：手动安装（git）

```bash
# 进入酒馆目录后二选一：
# A) 仅当前用户可用（推荐）
cd data/default-user/extensions
git clone https://github.com/ymf2317-tech/SillyTavern-MiMoTTS

# B) 全服务器可用（需要管理员）
cd public/scripts/extensions/third-party
git clone https://github.com/ymf2317-tech/SillyTavern-MiMoTTS
```

### 方法三：下载 ZIP

在 GitHub 页面点 **Code → Download ZIP**，解压后把整个文件夹放到：

```
data/default-user/extensions/SillyTavern-MiMoTTS/
```

（放 `public/scripts/extensions/third-party/` 也可以，两种位置都支持。）

**装完必须刷新浏览器页面**，否则下拉框里不会出现 MiMo。

---

## 配置与使用

1. 进入 **Extensions → TTS**，**Provider** 选 **MiMo**
2. 在下方填写 **API Key**
3. 其余保持默认即可：

   | 选项 | 默认 | 说明 |
   |---|---|---|
   | 模型 | `mimo-v2.5-tts` | 也可填 `mimo-v2.5-tts-voicedesign` / `mimo-v2.5-tts-voiceclone`（未测试） |
   | 音色列表 | 茉莉,冰糖,苏打,白桦,Mia,Chloe,Milo,Dean | 逗号分隔；Voice Map 从这里选 |
   | 风格指令 | 空 | 可选，例：`用轻快上扬的语调，语速稍快` |
   | 播放方式 | **整段播放** | 推荐。改"分块播放"可降低首音延迟但会有间断 |
   | 攒包阈值 | 8 秒 | 仅"分块播放"有效 |

4. **给角色指定音色**：在 TTS 面板的 **Voice Map** 里，为每个角色选择音色（例如把默认音色设成"冰糖"）
5. 点某条消息旁的**喇叭图标**即可朗读

### 建议的配套设置

- **关掉** `Narrate by paragraphs`，**关掉** `Multi-voice`：否则酒馆会按换行/引号把你的消息**切成多段**，段与段之间是串行排队的，等待会成倍增加
- 想过滤掉思维链/旁白，用酒馆自带的 **`Apply regex`** 填写正则即可（它在切段**之前**对整段文本执行，顺序天然正确）
- 关掉 `Auto-generation`（改为手动点喇叭）可以获得最干净的播放队列

---

## 排障

| 现象 | 处理 |
|---|---|
| 下拉框里**没有 MiMo** | ES module 缓存很顽固，**硬刷新**（Ctrl+Shift+R）。F12 控制台应出现 `[MiMo TTS] v0.1.0 供应商已注册` |
| 声音**一卡一卡/突突** | 确认"播放方式"= **整段播放**。若仍异常，见下方开发者说明的"Xing 坑" |
| 点了另一条消息**没反应/两条一起读** | 已内置取消机制，确认装的是最新版；并建议关掉 `Auto-generation` |
| 报 `请先填写 API Key` | 在供应商设置里填 Key |
| 报 `MiMo HTTP 4xx` | Key 无效 / 额度或权限问题 / 模型名写错 |
| 等了很久才出声 | 正常现象，见"已知限制 1"。把角色回复长度限制调小可显著改善 |
| 直连不通（部分地区网络） | 需要能直连 `api.xiaomimimo.com`；若你的代理是全局模式，请给它加**直连**分流 |

---

## 开发者说明（踩坑记录）

这部分是本仓库最有价值的内容。如果你想改进它，请先看这三个坑：

### 坑一：MiMo 流式 mp3 **每块都自带一个 Xing 头帧**

`stream:true` + `format:"mp3"` 时，**每个 SSE 数据块都带一个 MP3 元数据帧**（ASCII `Xing`）。
把多块拼起来 = 在音频中间插入几十个空帧（实测同一段文本出现 **50 处**），播放时每 ~0.3 秒"突"一下。

- **诊断**：在音频字节里搜 `58696e67`（`"Xing"`），干净文件应只有 **1 处**
- **结论**：整段播放**必须**走 `stream:false`（返回单个完整 MP3，只含 1 个 Xing 帧）；
  分块播放改用 `pcm16`（原始 PCM 无帧结构，可安全切割）+ 本地封 WAV 头

### 坑二：酒馆播放器"每块都要换音源"

`public/scripts/extensions/tts/index.js` 里**全程只用一个 `new Audio()`**，每次播放都要
`getBase64Async(blob)` → 换 `.src` → 等 `canplay`，手机上约 **0.3~0.5 秒**开销。
**分成 N 块就必然卡 N-1 次，"攒包阈值"只能减少次数、永远消不掉。**
→ 想要完全连贯，唯一办法是**整段只播一次**。

### 坑三：过期请求会"迟到落地"

酒馆的 `resetTtsPlayback()` 只清空队列，**不会通知供应商取消已发出的请求**
（事件系统只有 `TTS_JOB_STARTED / TTS_AUDIO_READY / TTS_JOB_COMPLETE`，**没有 stop/cancel**）。
MiMo 整段合成要 5~10 秒，窗口被放大几十倍，症状：点了另一条没反应 / 两条一起读 / 播起来没完。
→ 本扩展用 `AbortController` 实现"新请求覆盖旧请求"（见 `generateTts`）。

### MiMo TTS API 速查

```
POST https://api.xiaomimimo.com/v1/chat/completions
headers: { 'api-key': '<KEY>' }
body: {
  "model": "mimo-v2.5-tts",
  "messages": [
    { "role": "user",      "content": "<风格指令，可空>" },
    { "role": "assistant", "content": "<要朗读的文本>" }   // 注意：文本放 assistant
  ],
  "audio": { "format": "mp3", "voice": "茉莉" }
}
```
- `stream:false` → JSON，音频在 `choices[0].message.audio.data`（base64）
- `stream:true`  → SSE，音频在每帧 `choices[0].delta.audio.data`（base64）
- CORS 已开放（`access-control-allow-origin: *`），浏览器可直连
- 服务端在**阿里云新加坡**（`api.xiaomimimo.com` → `mimo-pri-alisgp.alb.xiaomi.com`）

### 想帮忙的话，最有价值的方向

1. **推动酒馆核心支持无缝播放**（Web Audio / MediaSource），这是"零卡顿 + 低延迟"的唯一正解
2. 支持 `mimo-v2.5-tts-voicedesign` / `voiceclone`（音色设计 / 克隆）
3. 中文文本预处理（数字、多音字、语气词标签）

---

## 贡献

- 欢迎 **Issue / PR**
- 作者时间有限，本仓库按 **"尽力而为"** 维护，不承诺响应时效
- 提交 PR 前请自行测试一遍：至少验证「整段播放能正常出声」+「切换消息时旧语音不会乱入」

## 许可证

[MIT](LICENSE)

---

---

# English

**MiMo TTS provider for SillyTavern** — use Xiaomi MiMo speech synthesis (`mimo-v2.5-tts`) as a native TTS provider. After install, a **MiMo** entry appears in the TTS Provider dropdown.

**Status: v0.1, experimental.** Limited maintenance. PRs welcome.

## Known limitations (please read first)

1. **Whole-utterance mode waits 5–10 s.** MiMo generates at roughly 50 ms/character, so a 200-char reply takes ~10 s before any sound.
2. **Chunked mode stutters.** SillyTavern uses a single `<audio>` element and re-decodes + waits for `canplay` on every chunk (0.3–0.5 s on mobile). More chunks = more gaps. Perfectly seamless playback would require changing the SillyTavern core player (Web Audio / MediaSource).
3. **Pressing Stop may leave one stale utterance playing.** SillyTavern does not notify providers to cancel in-flight requests. This extension implements "newest request wins"; to interrupt, click another message instead of Stop.

## Install

1. SillyTavern → **Extensions → Install extension**
2. Paste: `https://github.com/ymf2317-tech/SillyTavern-MiMoTTS`
3. Click **Install**, then **reload the page**

Manual install: clone into `data/default-user/extensions/` or `public/scripts/extensions/third-party/`.

## Usage

Extensions → TTS → Provider: **MiMo** → paste your MiMo API key. Pick voices per character in the Voice Map.
Recommended: turn **off** `Narrate by paragraphs` and `Multi-voice`.

## API note

MiMo TTS is **not** OpenAI-compatible: it is served from `/v1/chat/completions`, the text goes in the **`assistant`** message, and the audio comes back as base64 inside `choices[0].message.audio.data`.

⚠️ With `stream:true` and `format:"mp3"`, **every SSE chunk carries its own Xing metadata frame** — concatenating them inserts dozens of silent gaps. Use `stream:false` for a single clean MP3, or `pcm16` (+ local WAV header) when chunking.

## License

MIT

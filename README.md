# SillyTavern-MiMoTTS

把**小米 MiMo 语音合成**（`mimo-v2.5-tts`）接入 SillyTavern 的一个 TTS 供应商扩展。
安装后，酒馆 TTS 面板的 Provider 下拉框里会多出 **MiMo** 一项。

> 状态：**v0.2.0 / 实验性**。作者时间有限，不保证及时响应 issue 或跟进 MiMo API 变动。
> 欢迎 fork、PR，或者直接把这当成一份「踩坑记录」拿去改。见[开发者说明](#开发者说明踩坑记录)。

---

## 更新日志

### v0.2.0
- ✨ 新增**分段流水线**：长文本自动按句切分、逐批请求、边到边播，**首音从 5~10 秒降到约 2 秒**
- 📝 补充**文本清洗机制**说明（一个极易踩的坑，见下）

### v0.1.0
- 首个版本：整段播放 / 分块播放 / 取消在途请求

---

## ⚠️ 先读这里

### 一、必须这样配置 TTS 面板，否则标签会被朗读出来

酒馆的文本清洗发生在「按段朗读」切段**之后**，而且是**逐行执行**的。
所以只要开着「按段朗读」，**跨行正则必然静默失效** —— 标签块、元数据会被一字一句念出来。

**必须这样设**：

| 设置项 | 值 | 为什么 |
|---|---|---|
| **按段朗读** | **关** | 开着会让清洗逐行执行，跨行正则失效 |
| **跳过标签块内容** | **关** | 它自带的正则太粗糙，整段模式下会把正文一起吃光 |
| **应用正则过滤** | **开** | 填你需要的过滤规则（可过滤思维链、`<tag>` 块等） |
| **分段流水线**（本扩展） | **开** | 补回关掉按段朗读后损失的延迟 |

关掉「按段朗读」后的延迟，由扩展的**分段流水线**补回（把长文本按句切分、逐批请求、边到边播）。

### 二、已知限制

| 限制 | 说明 |
|---|---|
| **1. 首音约 2~3 秒** | 配合流水线。若关掉流水线，则首音 = 整段合成时间（MiMo 约 **50 毫秒/字**，200 字约 10 秒） |
| **2. 批与批之间有 0.3~0.5 秒换源开销** | 酒馆全程只用一个 `<audio>`，每换一次音源要重新解码。开销落在**句子边界**上，听感自然 |
| **3. 点「停止」按钮可能残留一条语音** | 酒馆停播时**不会通知**供应商取消已发出的请求。想中断请**改点另一条消息** |
| **4. 分块播放会有明显间断** | 酒馆播放器架构决定的，分块必然一顿一顿，不推荐 |

> 想做到「零卡顿 + 低延迟」两者兼得，**需要修改酒馆核心的播放器**（改用 Web Audio / MediaSource
> 无缝拼接），不是这个扩展能做的。这也是本仓库发出来的主要目的之一。

---

## 功能

- 酒馆原生供应商（下拉框直接选），支持酒馆的 **Voice Map**（角色→音色映射）
- **分段流水线**（默认开）：长文本按句切分批请求，首音约 2 秒，批边界落在句末
- **整段播放**（默认）：每批都是完整音频，不会"突突"；完全连贯
- **分块播放**（实验）：首音更早，但块间有间断
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
3. 粘贴本仓库地址：
   ```
   https://github.com/ymf2317-tech/SillyTavern-MiMoTTS
   ```
4. 点 **Install**，安装完成后**刷新页面**

> 酒馆是用 `git clone` 安装的，所以仓库**根目录必须有 `manifest.json`**（本仓库已满足）。
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

在 GitHub 页面点 **Code → Download ZIP**，解压后把整个文件夹放到
`data/default-user/extensions/SillyTavern-MiMoTTS/`。

**装完必须刷新浏览器页面**，否则下拉框里不会出现 MiMo。

---

## 配置与使用

1. 进入 **Extensions → TTS**，**Provider** 选 **MiMo**
2. 在下方填写 **API Key**
3. 建议的参数：

   | 选项 | 默认 | 说明 |
   |---|---|---|
   | 模型 | `mimo-v2.5-tts` | 也可填 `mimo-v2.5-tts-voicedesign` / `-voiceclone`（未测试） |
   | 音色列表 | 茉莉,冰糖,苏打,白桦,Mia,Chloe,Milo,Dean | 逗号分隔；Voice Map 从这里选 |
   | 播放方式 | **整段播放** | 推荐 |
   | **分段流水线** | **开** | 首音约 2 秒 |
   | 首批字数 / 每批上限 | 20 / 120 | 越小首音越快；每批上限越大卡顿越少 |
   | 风格指令 | 空 | 可选，例：`用轻快上扬的语调，语速稍快` |

4. **给角色指定音色**：在 TTS 面板的 **Voice Map** 里为每个角色选音色
5. 点某条消息旁的**喇叭图标**即可朗读

> 文本短于"首批字数"时不会切分，自动退化为整段 —— 所以对短消息零副作用。

---

## 排障

| 现象 | 处理 |
|---|---|
| 下拉框里**没有 MiMo** | ES module 缓存很顽固，**硬刷新**（Ctrl+Shift+R）。F12 控制台应出现 `[MiMo TTS] v0.2.0 供应商已注册` |
| **念出了标签/元数据** | 见上文「必须这样配置」：关掉按段朗读 + 关掉跳过标签块 + 用跨行正则 |
| 声音**一卡一卡/突突** | 确认"播放方式"= **整段播放**。若仍异常，见开发者说明的"Xing 坑" |
| 点了另一条消息**没反应/两条一起读** | 已内置取消机制，确认装的是最新版；建议关掉 `Auto-generation` |
| 报 `请先在 MiMo 供应商设置里填写 API Key` | 在供应商设置里填 Key |
| 报 `MiMo HTTP 4xx` | Key 无效 / 额度或权限问题 / 模型名写错 |
| 等了很久才出声 | 打开「分段流水线」；或把角色回复长度限制调小（等待与字数成正比） |
| 直连不通（部分地区网络） | 需要能直连 `api.xiaomimimo.com`；若代理是全局模式，请给它加**直连**分流 |

---

## 开发者说明（踩坑记录）

这部分是本仓库最有价值的内容。想改进它，请先看这四个坑。

### 坑一：MiMo 流式 mp3 **每块都自带一个 Xing 头帧**

`stream:true` + `format:"mp3"` 时，**每个 SSE 数据块都带一个 MP3 元数据帧**（ASCII `Xing`）。
把多块拼起来 = 在音频中间插入几十个空帧（实测同一段文本出现 **50 处**），播放时每 ~0.3 秒"突"一下。

- **诊断**：在音频字节里搜 `58696e67`（`"Xing"`），干净文件应只有 **1 处**
- **结论**：整段播放**必须**走 `stream:false`；分块播放改用 `pcm16`（无帧结构）+ 本地封 WAV 头

### 坑二：酒馆播放器"每块都要换音源"

`public/scripts/extensions/tts/index.js` 里**全程只用一个 `new Audio()`**，每次播放都要
`getBase64Async(blob)` → 换 `.src` → 等 `canplay`，手机上约 **0.3~0.5 秒**开销。
**分成 N 块就必然卡 N-1 次**，攒包阈值只能减少次数、永远消不掉。
→ 想要连贯，就要让**每批都是完整音频**（本扩展的做法），把开销集中在批边界。

### 坑三：过期请求会"迟到落地"

酒馆的 `resetTtsPlayback()` 只清空队列，**不通知供应商取消已发出的请求**
（事件系统只有 `TTS_JOB_STARTED / TTS_AUDIO_READY / TTS_JOB_COMPLETE`，**没有 stop/cancel**）。
MiMo 合成慢，窗口被放大，症状：点了另一条没反应 / 两条一起读 / 播起来没完。
→ 本扩展用 `AbortController` 实现"新请求覆盖旧请求"。

### 坑四：文本清洗是**逐行**的（最容易踩）

执行顺序（`tts/index.js`）：

```
processAndQueueTtsMessage()   ← 【切段在这里】按 \n 切成 N 个 job
  └─ 清洗：skip_codeblocks → skip_tags → 去星号 → apply_regex
       ← 【注意】以上清洗是对"每一行"分别执行的
```

所以 `narrate_by_paragraphs = true` 时，**跨行正则静默失效**（不报错，只是匹配不到）：

| 配置 | 送入 TTS 的片段数 |
|---|---|
| 按段朗读 ON + 默认 skip_tags | **42 段**（标签、元数据全被念） |
| 按段朗读 ON + 逐行正则 | 11~20 段（块内文字仍漏） |
| **按段朗读 OFF + 跨行正则** | **1 段**（只剩正文） |

另外两个细节：
- **`skip_tags` 自带的正则 `<.*?>[\s\S]*?<\/.*?>` 很粗糙**，在整段模式下可能**把正文一起吃光**（实测片段数变 0）→ 自己写了正则就把它关掉
- **`regexFromString()` 要求 `/pattern/flags` 格式**，只写裸模式会**没有 `g` 标志 → 只替换第一处**

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
- 语速：**合成约 54ms/字，播放约 135ms/字**（约 2.5 倍）——流水线的批大小就是按这个比例设计的

### 想帮忙的话，最有价值的方向

1. **推动酒馆核心支持无缝播放**（Web Audio / MediaSource）——"零卡顿 + 低延迟"的唯一正解
2. 支持 `mimo-v2.5-tts-voicedesign` / `voiceclone`（音色设计 / 克隆）
3. 中文文本预处理（数字、多音字、语气词标签）

---

## 贡献

- 欢迎 **Issue / PR**
- 作者时间有限，本仓库按 **"尽力而为"** 维护，不承诺响应时效
- 提交 PR 前请自测：至少验证「整段播放能出声」+「切换消息时旧语音不会乱入」

## 许可证

[MIT](LICENSE)

---

---

# English

**MiMo TTS provider for SillyTavern** — use Xiaomi MiMo speech synthesis (`mimo-v2.5-tts`) as a native TTS provider.

**Status: v0.2.0, experimental.** Limited maintenance. PRs welcome.

## Important: required settings

SillyTavern's TTS text cleaning runs **per-line**, *after* the "narrate by paragraphs" split.
So while `Narrate by paragraphs` is ON, **multi-line regex silently fails** and tags/metadata get read aloud.

| Setting | Value |
|---|---|
| Narrate by paragraphs | **OFF** |
| Skip tags (标签块) | **OFF** (its built-in regex can eat the whole body) |
| Apply regex | **ON** (use multi-line patterns) |
| Segmented pipeline (this extension) | **ON** (restores low latency) |

## Features

- Async **segmented pipeline**: splits long text by sentence, requests in batches, streams out as it goes → **first audio in ~2 s**
- Whole-utterance playback (no stutter), experimental chunked mode
- Cancels in-flight requests when you switch messages
- Direct browser → Xiaomi API; no server proxy, no server plugin

## Known limitations

1. First audio ~2–3 s with the pipeline; without it, = full synthesis time (~50 ms/char, so ~10 s for 200 chars)
2. 0.3–0.5 s source-swap gap between batches (lands on sentence boundaries)
3. Pressing **Stop** may leave one stale utterance playing (SillyTavern does not notify providers to cancel); click another message instead
4. Chunked mode stutters (SillyTavern uses a single `<audio>` element and re-decodes on every chunk)

Seamless playback would require changing the SillyTavern core player (Web Audio / MediaSource).

## API note

MiMo TTS is **not** OpenAI-compatible: it is served from `/v1/chat/completions`, the text goes in the **`assistant`** message, and audio comes back as base64 inside `choices[0].message.audio.data`.

⚠️ With `stream:true` + `format:"mp3"`, **every SSE chunk carries its own Xing metadata frame** — concatenating them inserts dozens of silent gaps. Use `stream:false` for a single clean MP3, or `pcm16` (+ local WAV header) when chunking.

## License

MIT

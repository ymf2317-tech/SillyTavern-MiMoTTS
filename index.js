/**
 * MiMo TTS for SillyTavern
 * 小米 MiMo 语音合成（mimo-v2.5-tts）供应商扩展
 *
 * 安装后酒馆的 TTS Provider 下拉框里会多出 "MiMo" 一项。
 *
 * ---------------------------------------------------------------------------
 * 设计说明（供愿意帮忙改进的人参考）
 *
 * 1) MiMo 的 TTS 不走 OpenAI 的 /v1/audio/speech，而是塞在聊天接口里：
 *      POST https://api.xiaomimimo.com/v1/chat/completions
 *      headers: { 'api-key': '<KEY>' }
 *      body: {
 *        model: 'mimo-v2.5-tts',
 *        messages: [ {role:'user', content:'<风格指令，可空>'},   // 风格/导演指令
 *                    {role:'assistant', content:'<要朗读的文本>'} ],  // 文本放 assistant，这点很特殊
 *        audio: { format: 'mp3' | 'wav' | 'pcm16', voice: '茉莉' }
 *      }
 *      stream:false → 返回 JSON，音频在 choices[0].message.audio.data（base64）
 *      stream:true  → SSE，音频在每帧 choices[0].delta.audio.data（base64）
 *
 * 2) ⚠️ 坑一：stream:true + format:mp3 时，**每个 SSE 数据块都自带一个 MP3 元数据帧
 *    （Xing 头帧，ASCII "Xing"）**。把多块拼起来 = 音频中间插入几十个空帧，
 *    播放时每 ~0.3 秒"突"一下。
 *      → 因此"整段播放"必须走 stream:false（单个完整 MP3，只含 1 个 Xing 帧）；
 *         "分块播放"改用 pcm16（无帧结构，可安全切割）并自行封装 WAV 头。
 *    诊断方法：在音频字节里搜 58696e67（"Xing"），干净文件应只有 1 处。
 *
 * 3) ⚠️ 坑二：酒馆的播放器全程只用一个 <audio> 元素，每播一块都要
 *    getBase64Async → 换 .src → 等 canplay，手机上约 0.3~0.5 秒开销。
 *      → 分成 N 块就必然卡 N-1 次，"攒包阈值"只能减少次数、永远消不掉。
 *        想要完全连贯，唯一办法是整段只播一次。
 *      → 真正的根治需要在酒馆核心把播放器改成 Web Audio / MediaSource 无缝拼接。
 *
 * 4) ⚠️ 坑三：酒馆的 resetTtsPlayback() 只清空队列，**不会通知供应商取消已发出的请求**
 *    （事件系统只有 TTS_JOB_STARTED / TTS_AUDIO_READY / TTS_JOB_COMPLETE）。
 *    MiMo 整段合成要 5~10 秒，若不取消，过期音频会在用户切换消息之后才落地播放
 *    → 表现为"点了另一条没反应 / 两条一起读 / 播起来没完"。
 *      → 本扩展用 AbortController 实现"新请求覆盖旧请求"。
 *      → 残留限制：点酒馆「停止」按钮不触发新的 generateTts，无法取消。
 *
 * License: MIT
 * ---------------------------------------------------------------------------
 */

import { eventSource, event_types } from '../../../../script.js';
import { registerTtsProvider, saveTtsProviderSettings } from '../../tts/index.js';

const VERSION = '0.1.0';
const PROVIDER_NAME = 'MiMo';
const MIMO_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';
const BYTES_PER_SECOND = 48000; // pcm16 24kHz/16bit 单声道 = 48000 B/s
const PCM_SAMPLE_RATE = 24000;
const PREVIEW_TEXT = '你好，我是小米 MiMo 的语音合成，这是一段试听。';

/** base64 → Uint8Array */
function base64ToBytes(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

/** 把若干 Uint8Array 拼成一个 */
function concatBytes(list) {
    let total = 0;
    for (const c of list) {
        total += c.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of list) {
        out.set(c, off);
        off += c.length;
    }
    return out;
}

/** 给裸 PCM16 加上 WAV 头（24kHz / 16bit / 单声道） */
function pcm16ToWav(pcm) {
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const writeStr = (off, s) => {
        for (let i = 0; i < s.length; i++) {
            view.setUint8(off + i, s.charCodeAt(i));
        }
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + pcm.length, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // 单声道
    view.setUint32(24, PCM_SAMPLE_RATE, true);
    view.setUint32(28, PCM_SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, pcm.length, true);

    const out = new Uint8Array(44 + pcm.length);
    out.set(new Uint8Array(header), 0);
    out.set(pcm, 44);
    return out;
}

// ---------------------------------------------------------------------------
//  在途请求的取消（见上文"坑三"）
// ---------------------------------------------------------------------------

/** @type {AbortController|null} */
let activeController = null;

function isAbortError(error) {
    return !!error && (error.name === 'AbortError' || /aborted|abort/i.test(String(error.message || '')));
}

function beginGeneration() {
    abortActiveGeneration();
    activeController = new AbortController();
    return activeController.signal;
}

function abortActiveGeneration() {
    if (activeController) {
        try {
            activeController.abort();
        } catch {
            /* ignore */
        }
        activeController = null;
    }
}

export class MiMoTtsProvider {
    settings;
    voices = [];
    separator = '。';

    audioElement = document.createElement('audio');

    defaultSettings = {
        voiceMap: {},
        // 注意：密钥保存在本机酒馆的 settings.json 里（你自己服务器的 data 目录内），
        // 不会上传到任何地方；只有发往小米 API 的那一次请求会带上它。
        api_key: '',
        model: 'mimo-v2.5-tts',
        // whole = 整段播放（默认，推荐）；chunked = 分块播放（实验性）
        play_mode: 'whole',
        chunk_seconds: 8,
        style: '',
        voices: ['茉莉', '冰糖', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'],
    };

    get settingsHtml() {
        return `
        <div class="mimo-tts-settings">
            <label for="mimo_api_key">API Key：</label>
            <input id="mimo_api_key" type="password" class="text_pole" maxlength="200" placeholder="sk-..." autocomplete="off"/>

            <label for="mimo_model">模型：</label>
            <input id="mimo_model" type="text" class="text_pole" maxlength="100"/>

            <label for="mimo_voices">音色列表（逗号分隔）：</label>
            <input id="mimo_voices" type="text" class="text_pole" maxlength="500"/>

            <label for="mimo_style">风格指令（可留空，会作为 user 消息传给模型）：</label>
            <input id="mimo_style" type="text" class="text_pole" maxlength="500" placeholder="例如：用轻快上扬的语调，语速稍快"/>

            <label for="mimo_play_mode">播放方式：</label>
            <select id="mimo_play_mode" class="text_pole">
                <option value="whole">整段播放（推荐：声音完整连贯，等待稍长）</option>
                <option value="chunked">分块播放（实验性：首音快，但块间会有间断）</option>
            </select>
            <small>
                酒馆全程只用一个播放器，每换一次音频源就要重新解码等待 0.3~0.5 秒，
                所以分成几块就会卡几次，"分块播放"无法做到连贯。<br>
                整段播放走非流式接口拿完整音频、只播一次，因此完全顺滑；
                代价是首音要等 MiMo 把整段合成完（约 50 毫秒/字，200 字约 10 秒）。
            </small>

            <label for="mimo_chunk_seconds">攒包阈值（秒，仅"分块播放"有效）：</label>
            <input id="mimo_chunk_seconds" type="number" class="text_pole" min="1" max="60" step="1"/>
        </div>`;
    }

    constructor() {
        // 本扩展不使用酒馆的密钥管理器（浏览器直连场景下前端必须拿到明文密钥），
        // 密钥直接保存在供应商设置里。
    }

    dispose() {
        abortActiveGeneration();
    }

    async loadSettings(settings) {
        this.settings = Object.assign({}, this.defaultSettings);
        this.settings.voiceMap = Object.assign({}, (settings && settings.voiceMap) || {});

        for (const key in settings) {
            if (key in this.defaultSettings && key !== 'voiceMap') {
                this.settings[key] = settings[key];
            } else if (!(key in this.defaultSettings)) {
                console.warn(`[MiMo TTS] 忽略未知设置项: ${key}`);
            }
        }

        if (!Array.isArray(this.settings.voices)) {
            this.settings.voices = [...this.defaultSettings.voices];
        }

        $('#mimo_api_key').val(this.settings.api_key);
        $('#mimo_model').val(this.settings.model);
        $('#mimo_voices').val(this.settings.voices.join(','));
        $('#mimo_style').val(this.settings.style);
        $('#mimo_play_mode').val(this.settings.play_mode);
        $('#mimo_chunk_seconds').val(this.settings.chunk_seconds);

        const bind = (selector, handler) => {
            $(selector).off('input change').on('input change', handler);
        };

        bind('#mimo_api_key', () => this.onSettingsChange());
        bind('#mimo_model', () => this.onSettingsChange());
        bind('#mimo_voices', () => this.onSettingsChange());
        bind('#mimo_style', () => this.onSettingsChange());
        bind('#mimo_play_mode', () => this.onSettingsChange());
        bind('#mimo_chunk_seconds', () => this.onSettingsChange());

        await this.checkReady();

        console.info(`[MiMo TTS] v${VERSION} 设置已加载`);
    }

    onSettingsChange() {
        this.settings.api_key = String($('#mimo_api_key').val() || '');
        this.settings.model = String($('#mimo_model').val() || 'mimo-v2.5-tts');
        this.settings.voices = String($('#mimo_voices').val() || '')
            .split(',')
            .map(v => v.trim())
            .filter(v => v.length > 0);
        this.settings.style = String($('#mimo_style').val() || '');
        this.settings.play_mode = String($('#mimo_play_mode').val() || 'whole');
        const chunkSeconds = Number($('#mimo_chunk_seconds').val());
        this.settings.chunk_seconds = Number.isFinite(chunkSeconds) ? Math.min(60, Math.max(1, chunkSeconds)) : 8;
        saveTtsProviderSettings();
    }

    async checkReady() {
        this.voices = await this.fetchTtsVoiceObjects();
    }

    async onRefreshClick() {
        this.voices = await this.fetchTtsVoiceObjects();
    }

    async getVoice(voiceName) {
        if (this.voices.length === 0) {
            this.voices = await this.fetchTtsVoiceObjects();
        }
        const match = this.voices.find(v => v.name === voiceName || v.voice_id === voiceName);
        if (!match) {
            throw `TTS Voice name ${voiceName} not found`;
        }
        return match;
    }

    async fetchTtsVoiceObjects() {
        return this.settings.voices.map(v => ({ name: v, voice_id: v, lang: 'zh-CN' }));
    }

    // ------------------------------------------------------------------
    //  合成入口
    // ------------------------------------------------------------------

    generateTts(text, voiceId) {
        const signal = beginGeneration();
        if (this.settings.play_mode === 'chunked') {
            return this.chunkedTts(text, voiceId, signal);
        }
        return this.wholeTts(text, voiceId, signal);
    }

    /** 整段播放：非流式接口拿完整 MP3，只交给播放器一次 */
    async *wholeTts(text, voiceId, signal) {
        let bytes;
        try {
            bytes = await this.fetchWholeBytes(text, voiceId, signal);
        } catch (error) {
            if (signal?.aborted || isAbortError(error)) {
                console.info('[MiMo TTS] 生成已取消');
                return;
            }
            throw error;
        }
        yield new Response(bytes, {
            status: 200,
            headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes.length) },
        });
    }

    /** 直连非流式接口，取完整音频字节 */
    async fetchWholeBytes(text, voiceId, signal) {
        const response = await this.postDirect(text, voiceId, false, 'mp3', signal);
        if (!response.ok) {
            throw new Error(`MiMo HTTP ${response.status}: ${await response.text()}`);
        }
        const json = await response.json();
        const b64 = json?.choices?.[0]?.message?.audio?.data;
        if (!b64) {
            const detail = json?.base_resp?.status_msg || json?.error?.message || '返回体里没有音频数据';
            throw new Error(`MiMo 未返回音频：${detail}`);
        }
        const bytes = base64ToBytes(b64);
        if (bytes.length === 0) {
            throw new Error('MiMo 返回的音频数据为空，请检查模型名与音色是否正确');
        }
        return bytes;
    }

    /**
     * 分块播放（实验性）：用 pcm16 传输（无帧结构，可安全切割）并自行封装 WAV，
     * 以避开流式 mp3 每块自带 Xing 头帧造成的杂音。
     * 但块与块之间仍会有 0.3~0.5 秒间断 —— 这是酒馆播放器架构决定的。
     */
    async *chunkedTts(text, voiceId, signal) {
        let response;
        try {
            response = await this.postDirect(text, voiceId, true, 'pcm16', signal);
        } catch (error) {
            if (signal?.aborted || isAbortError(error)) {
                console.info('[MiMo TTS] 生成已取消');
                return;
            }
            throw error;
        }
        if (!response.ok) {
            throw new Error(`MiMo HTTP ${response.status}: ${await response.text()}`);
        }

        const threshold = Math.max(48000, Number(this.settings.chunk_seconds || 8) * BYTES_PER_SECOND);
        let pending = [];
        let pendingBytes = 0;

        try {
            for await (const bytes of this.readSseAudio(response)) {
                pending.push(bytes);
                pendingBytes += bytes.length;
                if (pendingBytes >= threshold) {
                    const wav = this.takeWavChunk(pending);
                    pending = [];
                    pendingBytes = 0;
                    yield wav;
                }
            }
        } catch (error) {
            if (signal?.aborted || isAbortError(error)) {
                console.info('[MiMo TTS] 生成已取消');
                return;
            }
            throw error;
        }

        if (pendingBytes > 0) {
            yield this.takeWavChunk(pending);
        }
    }

    takeWavChunk(parts) {
        let pcm = concatBytes(parts);
        if (pcm.length % 2 !== 0) {
            pcm = pcm.subarray(0, pcm.length - 1);
        }
        const wav = pcm16ToWav(pcm);
        return new Response(wav, {
            status: 200,
            headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length) },
        });
    }

    /** 解析 MiMo 的 SSE 流，逐段吐出原始音频字节（网络分片可能切断一行，故留残余缓冲） */
    async *readSseAudio(response) {
        if (!response.body) {
            throw new Error('当前环境不支持流式读取（response.body 为空）');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let lineBuffer = '';

        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                lineBuffer += decoder.decode(value, { stream: true });

                let nl;
                while ((nl = lineBuffer.indexOf('\n')) !== -1) {
                    const line = lineBuffer.slice(0, nl).replace(/\r$/, '');
                    lineBuffer = lineBuffer.slice(nl + 1);

                    if (!line.startsWith('data:')) {
                        continue;
                    }
                    const payload = line.slice(5).trim();
                    if (!payload || payload === '[DONE]') {
                        continue;
                    }

                    let json;
                    try {
                        json = JSON.parse(payload);
                    } catch {
                        continue;
                    }

                    const b64 = json?.choices?.[0]?.delta?.audio?.data;
                    if (!b64) {
                        continue;
                    }
                    const bytes = base64ToBytes(b64);
                    if (bytes.length > 0) {
                        yield bytes;
                    }
                }
            }
        } finally {
            try {
                reader.releaseLock();
            } catch {
                /* ignore */
            }
        }
    }

    postDirect(text, voiceId, stream, format, signal) {
        const key = String(this.settings.api_key || '').trim();
        if (!key) {
            throw new Error('请先在 MiMo 供应商设置里填写 API Key');
        }

        const style = String(this.settings.style || '').trim();
        const payload = {
            model: this.settings.model || 'mimo-v2.5-tts',
            messages: [
                { role: 'user', content: style },
                { role: 'assistant', content: text },
            ],
            audio: { format: format || 'mp3', voice: voiceId },
        };
        if (stream) {
            payload.stream = true;
        }

        return fetch(MIMO_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': key,
            },
            signal,
            body: JSON.stringify(payload),
        });
    }

    async previewTtsVoice(voiceId) {
        this.audioElement.pause();
        this.audioElement.currentTime = 0;

        const response = await this.postDirect(PREVIEW_TEXT, voiceId, false, 'mp3', null);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const json = await response.json();
        const b64 = json?.choices?.[0]?.message?.audio?.data;
        if (!b64) {
            throw new Error('试听失败：MiMo 未返回音频');
        }
        const audio = new Blob([base64ToBytes(b64)], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(audio);
        this.audioElement.src = url;
        this.audioElement.play();
        this.audioElement.onended = () => URL.revokeObjectURL(url);
    }
}

// ----------------------------------------------------------------------
//  注册供应商（下拉框里多一项 MiMo）
// ----------------------------------------------------------------------

let registered = false;

function ensureOption() {
    const select = document.getElementById('tts_provider');
    if (!select) {
        return;
    }
    const existing = select.querySelectorAll(`option[value="${PROVIDER_NAME}"]`);
    if (existing.length === 0) {
        const option = document.createElement('option');
        option.value = PROVIDER_NAME;
        option.textContent = PROVIDER_NAME;
        select.appendChild(option);
    } else {
        for (let i = 1; i < existing.length; i++) {
            existing[i].remove();
        }
    }
}

export function init() {
    register();
}

function register() {
    scheduleUi();
    if (registered) {
        return;
    }
    try {
        registerTtsProvider(PROVIDER_NAME, MiMoTtsProvider);
        registered = true;
        console.info(`[MiMo TTS] v${VERSION} 供应商已注册`);
    } catch (error) {
        console.warn('[MiMo TTS] 注册失败（可能已注册）', error);
    }
}

function scheduleUi() {
    ensureOption();
    for (const ms of [0, 500, 1500, 3000]) {
        setTimeout(ensureOption, ms);
    }
    try {
        if (eventSource && event_types && event_types.APP_READY) {
            eventSource.on(event_types.APP_READY, ensureOption);
        }
    } catch {
        /* ignore */
    }
}

register();

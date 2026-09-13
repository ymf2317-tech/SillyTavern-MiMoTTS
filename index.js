/**
 * MiMo TTS — 小米 MiMo 语音合成供应商（SillyTavern 第三方扩展）
 *
 * 关于音频质量的要点（重要，勿轻易改动）：
 *   MiMo 的 /v1/chat/completions 在 stream:true 时，**每个 SSE 数据块都会自带一个
 *   MP3 元数据帧（Xing 头帧，以 "Xing" 标记）**。把多块拼起来就等于在音频中间插入
 *   了几十个空帧，播放时会每 ~0.3 秒"突"一下。
 *   因此：整段播放必须走 stream:false（返回单个完整 MP3，仅含 1 个 Xing 帧）。
 *   分块播放则改用 pcm16（无帧结构、可任意切割）并自行封装 WAV，避开该问题。
 *
 * 播放方式（play_mode）：
 *   whole   整段播放（默认，推荐）—— 非流式接口拿完整音频，只播一次，完全连贯。
 *   chunked 分块流式 —— 首音快，但酒馆每块都要"换音源+等 canplay"（0.3~0.5s），
 *                        块间必然有间断，仅作尝鲜。
 *
 * 传输方式：浏览器直连新加坡（无需服务器中转，不需要装任何服务端插件）。
 *
 * 安装位置：data/<user>/extensions/mimo-tts/（在 git 之外，升级酒馆不受影响）
 */

import { eventSource, event_types } from '../../../../script.js';
import { registerTtsProvider, saveTtsProviderSettings } from '../../tts/index.js';

const VERSION = '0.2.0';
const PROVIDER_NAME = 'MiMo';
const MIMO_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';
const BYTES_PER_SECOND = 48000; // pcm16 24kHz/16bit 单声道 = 48000 B/s
const PCM_SAMPLE_RATE = 24000;
const PREVIEW_TEXT = '你好，我是小米 MiMo 的语音合成，这是一段试听。';

// ----------------------------------------------------------------------
//  在途请求的取消（重要）
//  酒馆的 resetTtsPlayback() 只会清空队列，**不会通知供应商取消已发出的请求**。
//  而 MiMo 整段合成要 5~10 秒，若不取消，"过期"的音频会在用户切换消息之后才
//  落地播放 —— 表现为：点了另一条没反应 / 两条一起读 / 播起来没完。
//  这里采用「新的覆盖旧的」策略：新请求一来就中止上一个。
// ----------------------------------------------------------------------

/** @type {AbortController|null} */
let activeController = null;

function isAbortError(error) {
    return !!error && (error.name === 'AbortError' || /aborted|abort/i.test(String(error.message || '')));
}

/** 开始一次生成：中止上一个在途请求，返回新的 signal */
function beginGeneration() {
    abortActiveGeneration();
    activeController = new AbortController();
    return activeController.signal;
}

/** 中止当前在途生成（停止播放 / 切换消息 / 卸载供应商时调用） */
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

export class MiMoTtsProvider {
    settings;
    voices = [];
    separator = '。';

    audioElement = document.createElement('audio');

    defaultSettings = {
        voiceMap: {},
        model: 'mimo-v2.5-tts',
        // whole = 整段播放（干净、连贯）；chunked = 分块流式（首音快但有间断）
        play_mode: 'whole',
        // 仅 chunked 模式有效：每块攒够多久才抛给播放器
        chunk_seconds: 8,
        // 分段流水线：长文本自动按句切分、逐批请求，边到边播（首音更快）。
        // 用于替代酒馆的「按段朗读」——后者会让清洗变为逐行，跨行正则失效。
        pipeline: true,
        pipeline_first: 20,   // 首批字数（越小首音越快）
        pipeline_max: 120,    // 后续每批上限（越大卡顿越少）
        style: '',
        voices: ['茉莉', '冰糖', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'],
    };

    get settingsHtml() {
        return `
        <div class="mimo-tts-settings">
            <label for="mimo_play_mode">播放方式：</label>
            <select id="mimo_play_mode" class="text_pole">
                <option value="whole">整段播放（推荐：声音完整连贯，等待稍长）</option>
                <option value="chunked">分块流式（首音快，但会有间断）</option>
            </select>
            <small>
                <b>推荐用"整段播放"。</b>酒馆全程只用一个播放器，每换一次音频源就要重新解码等待
                0.3~0.5 秒，所以只要分成多块就必然一顿一顿，"分块流式"无法做到连贯。<br>
                整段播放走非流式接口拿完整音频，只播一次，因此完全顺滑；
                代价是首音要等 MiMo 把整段合成完（约 50 毫秒/字，200 字约 10 秒）。
            </small>

            <label for="mimo_chunk_seconds">攒包阈值（秒，仅"分块流式"有效）：</label>
            <input id="mimo_chunk_seconds" type="number" class="text_pole" min="1" max="60" step="1"/>

            <label class="checkbox_label">
                <input type="checkbox" id="mimo_pipeline"/>
                <span>分段流水线（长文本自动分句，首音更快）</span>
            </label>
            <small>
                酒馆的「按段朗读」会让文本清洗变成<b>逐行</b>执行，跨行正则因此失效
                （标签、元数据会被念出来）。要正确过滤，需把「按段朗读」<b>关掉</b>；
                关掉后由本扩展自己把长文本按句切分、逐批请求、边到边播，首音仍只要 1~2 秒。
            </small>

            <label for="mimo_pipeline_first">首批字数 / 后续每批上限：</label>
            <div class="flex-container alignItemsCenter flexGap5">
                <input id="mimo_pipeline_first" type="number" class="text_pole" min="5" max="200" step="5"/>
                <input id="mimo_pipeline_max" type="number" class="text_pole" min="20" max="500" step="10"/>
            </div>

            <hr>

            <label for="mimo_api_key">API Key：</label>
            <input id="mimo_api_key" type="password" class="text_pole" maxlength="200" placeholder="sk-..." autocomplete="off"/>

            <label for="mimo_model">模型：</label>
            <input id="mimo_model" type="text" class="text_pole" maxlength="100"/>

            <label for="mimo_voices">音色列表（逗号分隔）：</label>
            <input id="mimo_voices" type="text" class="text_pole" maxlength="500"/>

            <label for="mimo_style">风格指令（可留空）：</label>
            <input id="mimo_style" type="text" class="text_pole" maxlength="500" placeholder="例如：用轻快上扬的语调，语速稍快"/>

            <small class="mimo-hint">
                本扩展由浏览器直接请求小米新加坡的接口，服务器不参与，也不需要装任何服务端组件。<br>
                音色与角色映射沿用酒馆的 Voice Map，无需在此重复设置。
            </small>
        </div>`;
    }

    constructor() {
        this.handler = async function (/** @type {string} */ key) {
            if (key !== 'api_key_custom_openai_tts') {
                return;
            }
        }.bind(this);
    }

    dispose() {
        // 供应商被卸载/切换时，中止仍在途的生成，避免音频迟到落地
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

        $('#mimo_play_mode').val(this.settings.play_mode);
        $('#mimo_chunk_seconds').val(this.settings.chunk_seconds);
        $('#mimo_pipeline').prop('checked', !!this.settings.pipeline);
        $('#mimo_pipeline_first').val(this.settings.pipeline_first);
        $('#mimo_pipeline_max').val(this.settings.pipeline_max);
        $('#mimo_api_key').val(this.settings.api_key);
        $('#mimo_model').val(this.settings.model);
        $('#mimo_voices').val(this.settings.voices.join(','));
        $('#mimo_style').val(this.settings.style);

        const bind = (selector, handler) => {
            $(selector).off('input change').on('input change', handler);
        };

        bind('#mimo_play_mode', () => this.onSettingsChange());
        bind('#mimo_chunk_seconds', () => this.onSettingsChange());
        bind('#mimo_pipeline', () => this.onSettingsChange());
        bind('#mimo_pipeline_first', () => this.onSettingsChange());
        bind('#mimo_pipeline_max', () => this.onSettingsChange());
        bind('#mimo_api_key', () => this.onSettingsChange());
        bind('#mimo_model', () => this.onSettingsChange());
        bind('#mimo_voices', () => this.onSettingsChange());
        bind('#mimo_style', () => this.onSettingsChange());

        await this.checkReady();

        console.info(`[MiMo TTS] v${VERSION} 设置已加载：${this.settings.play_mode}`);
    }

    onSettingsChange() {
        this.settings.play_mode = String($('#mimo_play_mode').val() || 'whole');
        const chunkSeconds = Number($('#mimo_chunk_seconds').val());
        this.settings.chunk_seconds = Number.isFinite(chunkSeconds) ? Math.min(60, Math.max(1, chunkSeconds)) : 8;
        this.settings.pipeline = !!$('#mimo_pipeline').prop('checked');
        const pf = Number($('#mimo_pipeline_first').val());
        this.settings.pipeline_first = Number.isFinite(pf) ? Math.min(200, Math.max(5, pf)) : 20;
        const pm = Number($('#mimo_pipeline_max').val());
        this.settings.pipeline_max = Number.isFinite(pm) ? Math.min(500, Math.max(20, pm)) : 120;
        this.settings.api_key = String($('#mimo_api_key').val() || '');
        this.settings.model = String($('#mimo_model').val() || 'mimo-v2.5-tts');
        this.settings.voices = String($('#mimo_voices').val() || '')
            .split(',')
            .map(v => v.trim())
            .filter(v => v.length > 0);
        this.settings.style = String($('#mimo_style').val() || '');
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
        // 新请求覆盖旧请求：中止上一个仍在途的生成
        const signal = beginGeneration();
        if (this.settings.play_mode === 'chunked') {
            return this.chunkedTts(text, voiceId, signal);
        }
        return this.wholeTts(text, voiceId, signal);
    }

    /**
     * 整段播放：一次请求拿完整音频，只交给播放器一次。
     * 走非流式接口，拿到单个完整 MP3（音频干净）。
     */
    /**
     * 把长文本切成适合流水线的批次。
     * 首批小（首音快），之后按几何增长到上限——因为 MiMo 的生成速度约为播放速度的
     * 2.5 倍（实测约 54ms/字 vs 约 135ms/字），只要下一批不超上一批的 ~2.5 倍，
     * 播放就不会"断粮"（断粮会表现为一段明显的静音）。
     */
    splitIntoChunks(text) {
        const first = Math.max(5, Number(this.settings.pipeline_first) || 20);
        const max = Math.max(first, Number(this.settings.pipeline_max) || 120);

        // 按句末标点切句（酒馆此前已把换行压成空格，所以按标点切）
        const sentences = String(text).match(/[^。！？!?…；;]+[。！？!?…；;]*/g) || [String(text)];

        const chunks = [];
        let cur = '';
        let limit = first;
        for (const s of sentences) {
            if (cur && cur.length + s.length > limit) {
                chunks.push(cur);
                cur = s;
                limit = Math.min(max, Math.max(limit * 2, first));
            } else {
                cur += s;
            }
        }
        if (cur) {
            chunks.push(cur);
        }
        return chunks;
    }

    /**
     * 整段播放：逐批请求、边到边抛。
     * 每批都是一整段完整音频（内容不切碎），所以不会出现"突突突"；
     * 批与批之间会有一次换源开销（0.3~0.5s），落在句子边界上。
     */
    async *wholeTts(text, voiceId, signal) {
        const chunks = this.settings.pipeline ? this.splitIntoChunks(text) : [text];

        for (let i = 0; i < chunks.length; i++) {
            if (signal?.aborted) {
                console.info('[MiMo TTS] 生成已取消（用户切换了消息或停止了播放）');
                return;
            }

            let bytes;
            let contentType;
            try {
                ({ bytes, contentType } = await this.fetchWholeBytes(chunks[i], voiceId, signal));
            } catch (error) {
                if (signal?.aborted || isAbortError(error)) {
                    console.info('[MiMo TTS] 生成已取消（用户切换了消息或停止了播放）');
                    return;
                }
                if (i === 0) {
                    throw error; // 首批失败：直接把错误暴露给用户
                }
                console.warn(`[MiMo TTS] 第 ${i + 1} 批失败，跳过该批：`, error);
                continue;
            }

            yield new Response(bytes, {
                status: 200,
                headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.length) },
            });
        }
    }

    /**
     * 拿一整段音频，返回原始字节 + MIME。
     * 直连走非流式接口（单个完整 MP3，仅含 1 个 Xing 头帧，音频干净）；
     */
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
        return { bytes, contentType: 'audio/mpeg' };
    }

    /**
     * 分块流式：用 pcm16 传输（无帧结构，可安全切割）并自行封装 WAV，
     * 以避开 MiMo 流式块自带的 Xing 头帧造成的杂音。
     * 注意：块与块之间仍会有 0.3~0.5 秒间断，这是酒馆播放器决定的。
     */
    async *chunkedTts(text, voiceId, signal) {
        let response;
        try {
            response = await this.postDirect(text, voiceId, true, 'pcm16', signal);
        } catch (error) {
            if (signal?.aborted || isAbortError(error)) {
                console.info('[MiMo TTS] 生成已取消（用户切换了消息或停止了播放）');
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
                console.info('[MiMo TTS] 生成已取消（用户切换了消息或停止了播放）');
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
        // 保证 16bit 采样对齐
        if (pcm.length % 2 !== 0) {
            pcm = pcm.subarray(0, pcm.length - 1);
        }
        const wav = pcm16ToWav(pcm);
        return new Response(wav, {
            status: 200,
            headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length) },
        });
    }

    /**
     * 解析 MiMo 的 SSE 流，逐段吐出原始音频字节。
     * 注意：网络分片可能把一行切断，所以要留残余缓冲。
     */
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

    /** 直连请求 */
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

        const { bytes, contentType } = await this.fetchWholeBytes(PREVIEW_TEXT, voiceId);
        const audio = new Blob([bytes], { type: contentType });
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
        // 框架可能也追加过一次，去重
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

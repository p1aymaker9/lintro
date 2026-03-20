// ─── 标准字幕数据结构 ───────────────────────────────────────────────────────
export interface SubtitleItem {
  startTime: number; // 开始时间，单位：秒
  endTime: number;   // 结束时间，单位：秒
  text: string;      // 字幕文本
}

// 降噪：此脚本运行在页面上下文，不能改写全局 console；仅在本模块内静默 console.log。
const console = Object.assign({}, globalThis.console, {
  log: (..._args: unknown[]) => {},
}) as Console;

// ─── B站字幕格式归一化 ────────────────────────────────────────────────────────
interface BilibiliSubtitleTrack {
  id: number;
  lan: string;
  lan_doc: string;
  subtitle_url: string;
}

function normalizeBilibiliSubtitles(
  items: Array<{ from: number; to: number; content: string }>
): SubtitleItem[] {
  return items.map((item) => ({
    startTime: item.from,
    endTime: item.to,
    text: item.content,
  }));
}

// ─── 提取逻辑 ────────────────────────────────────────────────────────────────
export default defineUnlistedScript(() => {
  const hostname = window.location.hostname;
  console.log(`Extractor: Running on ${hostname}`);

  // ── YouTube ──────────────────────────────────────────────────────────────
  if (hostname.includes('youtube.com')) {
    let subtitleCaptured = false; // 标记是否已获取到完整字幕
    let baseUrlSent = false;       // 标记是否已发送 baseUrl（避免重复）
    let lastBaseUrl = '';          // 上一次发送的 baseUrl（用于检测 CC 切换）
    let lastTrackSignature = '';   // 上一次发送的字幕轨道签名

    function isAdShowing(): boolean {
      const player = document.querySelector('#movie_player, .html5-video-player');
      return !!player?.classList.contains('ad-showing');
    }

    /** 从 timedtext URL 中剥离 fmt / tlang，返回可复用的 baseUrl */
    function extractBaseUrl(rawUrl: string): string {
      try {
        const u = new URL(rawUrl);
        u.searchParams.delete('fmt');
        u.searchParams.delete('tlang');
        return u.toString();
      } catch {
        // 降级：直接用字符串替换
        return rawUrl.replace(/[&?]fmt=[^&]*/g, '').replace(/[&?]tlang=[^&]*/g, '');
      }
    }

    function notifyBaseUrl(rawUrl: string) {
      if (isAdShowing()) {
        console.log('Extractor: 广告播放中，忽略广告字幕 baseUrl');
        return;
      }
      const baseUrl = extractBaseUrl(rawUrl);
      // 如果 baseUrl 和上次一致则跳过，否则允许重新发送（CC 开关场景）
      if (baseUrlSent && baseUrl === lastBaseUrl) return;
      baseUrlSent = true;
      lastBaseUrl = baseUrl;
      window.postMessage({ type: 'YT_SUBTITLE_BASEURL', payload: { baseUrl } }, '*');
      console.log('Extractor: 已发送 baseUrl →', baseUrl);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 策略 A：拦截 YouTube 自身的网络请求（最可靠）
    // YouTube 播放器在加载视频时会自己请求 timedtext API，
    // 我们 monkey-patch XHR，当 YouTube 自己的代码获取到字幕时直接截获。
    // ═══════════════════════════════════════════════════════════════════════
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: any[]
    ) {
      (this as any).__captionUrl = String(url);
      return (originalXHROpen as any).apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function(this: XMLHttpRequest, ...args: any[]) {
      const url: string = (this as any).__captionUrl || '';

      // 仅拦截 YouTube 的 timedtext 请求
      if (url.includes('/api/timedtext') || url.includes('timedtext?')) {
        // 立即发送 baseUrl，让 Content Script 可以并发拉取双轨
        notifyBaseUrl(url);
        this.addEventListener('load', function() {
          if (isAdShowing()) {
            console.log('Extractor (策略A): 广告播放中，忽略广告字幕响应');
            return;
          }
          if (this.responseText && this.responseText.length > 10) {
            console.log(`Extractor (策略A): ✅ 拦截到 YouTube 字幕请求! 长度: ${this.responseText.length}`);
            subtitleCaptured = true;

            try {
              // 尝试解析为 JSON (json3 格式)
              const json = JSON.parse(this.responseText);
              window.postMessage({
                type: 'YT_SUBTITLE_JSON',
                payload: {
                  languageCode: 'auto',
                  languageName: 'Intercepted',
                  data: json,
                  source: 'xhr-intercept',
                }
              }, '*');
            } catch {
              // 可能是 XML 格式，直接传原始文本
              window.postMessage({
                type: 'YT_SUBTITLE_RAW',
                payload: {
                  rawText: this.responseText,
                  url: url,
                  source: 'xhr-intercept',
                }
              }, '*');
            }
          }
        });
      }
      return (originalXHRSend as any).apply(this, args);
    };

    // 同样拦截 fetch (覆盖 YouTube 用 fetch 的场景)
    const originalFetch = window.fetch;
    window.fetch = async function(...args: any[]) {
      const request = args[0];
      const url = typeof request === 'string' ? request : (request as Request)?.url || '';

      const response = await (originalFetch as any).apply(this, args);

      if (url.includes('/api/timedtext') || url.includes('timedtext?')) {
        // 立即发送 baseUrl（fetch 场景下的补充）
        notifyBaseUrl(url);
        // clone 响应以免影响 YouTube 正常消费
        const cloned = response.clone();
        cloned.text().then((text: string) => {
          if (isAdShowing()) {
            console.log('Extractor (策略A-fetch): 广告播放中，忽略广告字幕响应');
            return;
          }
          if (text && text.length > 10) {
            console.log(`Extractor (策略A-fetch): ✅ 拦截到字幕 fetch! 长度: ${text.length}`);
            subtitleCaptured = true;

            try {
              const json = JSON.parse(text);
              window.postMessage({
                type: 'YT_SUBTITLE_JSON',
                payload: {
                  languageCode: 'auto',
                  languageName: 'Intercepted-Fetch',
                  data: json,
                  source: 'fetch-intercept',
                }
              }, '*');
            } catch {
              window.postMessage({
                type: 'YT_SUBTITLE_RAW',
                payload: { rawText: text, url, source: 'fetch-intercept' }
              }, '*');
            }
          }
        }).catch(() => {});
      }

      return response;
    };

    console.log('Extractor (策略A): XHR/Fetch 拦截器已安装');

    // ═══════════════════════════════════════════════════════════════════════
    // 策略 B：通过 YouTube Player API 获取
    // YouTube 的 <div id="movie_player"> 暴露了内部 API
    // ═══════════════════════════════════════════════════════════════════════
    function tryPlayerAPI(): boolean {
      const player = document.querySelector('#movie_player') as any;
      if (!player) return false;

      // 方法 1: getOption('captions', 'tracklist')
      try {
        if (typeof player.getOption === 'function') {
          const tracklist = player.getOption('captions', 'tracklist');
          if (tracklist && tracklist.length > 0) {
            console.log('Extractor (策略B): ✅ 通过 Player API 获取到字幕轨道列表', tracklist);
            window.postMessage({
              type: 'YT_PLAYER_TRACKLIST',
              payload: { tracklist, source: 'player-api' }
            }, '*');
          }
        }
      } catch (e) {
        console.warn('Extractor (策略B): getOption failed', e);
      }

      // 方法 2: 直接获取当前播放的字幕数据
      try {
        if (typeof player.getOption === 'function') {
          const track = player.getOption('captions', 'track');
          if (track) {
            console.log('Extractor (策略B): 当前字幕轨道:', track);
          }
        }
      } catch (e) {}

      return false;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 策略 C：DOM 实时观测保底
    // 监听 YouTube 播放器中的 .ytp-caption-segment 元素变化
    // 实时捕获正在显示的字幕文本，并带时间戳
    // ═══════════════════════════════════════════════════════════════════════
    function setupDOMObserver() {
      const collectedCaptions: Array<{ time: number; text: string }> = [];
      let lastText = '';
      let observerStarted = false;

      const captureCaption = () => {
        const segments = document.querySelectorAll('.ytp-caption-segment');
        if (segments.length === 0) return;

        const text = Array.from(segments).map(s => s.textContent?.trim()).filter(Boolean).join(' ');
        if (!text || text === lastText) return;
        lastText = text;

        // 从视频元素获取当前时间
        const video = document.querySelector('video');
        const currentTime = video ? video.currentTime : 0;

        collectedCaptions.push({ time: currentTime, text });

        // 每收集到新字幕就发送给 Content Script
        window.postMessage({
          type: 'YT_CAPTION_REALTIME',
          payload: {
            currentTime,
            text,
            source: 'dom-observer',
          }
        }, '*');
      };

      // 等待播放器容器出现
      const waitForCaptionContainer = () => {
        const container = document.querySelector('.ytp-caption-window-container') 
          || document.querySelector('#ytp-caption-window-container');
        
        if (container) {
          if (observerStarted) return;
          observerStarted = true;
          console.log('Extractor (策略C): ✅ 字幕容器已找到，开始监听 DOM');

          const domObserver = new MutationObserver(captureCaption);
          domObserver.observe(container, {
            childList: true,
            subtree: true,
            characterData: true,
          });
          // 首次立即检查
          captureCaption();
        } else {
          // 还没出现，继续等
          setTimeout(waitForCaptionContainer, 1000);
        }
      };

      waitForCaptionContainer();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 启动所有策略
    // ═══════════════════════════════════════════════════════════════════════

    // 提取 track 列表信息（即使无法 fetch，至少让 Content Script 知道有哪些轨道）
    const extractTrackInfo = () => {
      if (isAdShowing()) {
        console.log('Extractor: 广告播放中，暂不发送字幕轨道');
        return;
      }
      const data = (window as any).ytInitialPlayerResponse;
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length > 0) {
        const signature = tracks.map((t: any) => `${t.languageCode}:${t.baseUrl}`).join('|');
        if (signature === lastTrackSignature) return;
        lastTrackSignature = signature;
        window.postMessage({ type: 'YT_CAPTIONS_TRACKS', payload: tracks }, '*');
        console.log('Extractor: 字幕轨道列表已发送', tracks.map((t: any) => t.languageCode));
      }
    };

    extractTrackInfo();

    // 延时启动策略 B（等播放器初始化完毕）
    setTimeout(() => tryPlayerAPI(), 3000);
    // 再次尝试（有时播放器加载慢）
    setTimeout(() => tryPlayerAPI(), 6000);

    // 定时刷新轨道信息：广告结束后可重新发现主片字幕轨道
    setInterval(() => {
      extractTrackInfo();
    }, 2000);

    // 启动策略 C（DOM 保底）
    setupDOMObserver();

    // SPA 导航后重新启动
    window.addEventListener('yt-navigate-finish', () => {
      subtitleCaptured = false;
      baseUrlSent = false;
      lastBaseUrl = '';
      lastTrackSignature = '';
      setTimeout(() => {
        extractTrackInfo();
        tryPlayerAPI();
      }, 2000);
    });

    return;
  }

  // ── Bilibili ─────────────────────────────────────────────────────────────
  if (hostname.includes('bilibili.com')) {
    let tracksSent = false;

    /** 发送字幕轨道列表到 Content Script */
    function dispatchTracks(subtitles: BilibiliSubtitleTrack[]) {
      if (subtitles.length === 0) return;
      tracksSent = true;
      window.postMessage({
        type: 'BILI_CAPTIONS_EXTRACTED',
        payload: subtitles,
      }, '*');
      console.log('Extractor (Bilibili): ✅ Subtitle tracks dispatched:', subtitles.map(t => t.lan));
    }

    /** 发送直接拦截到的字幕 JSON body */
    function dispatchSubtitleBody(body: any[], url: string) {
      window.postMessage({
        type: 'BILI_SUBTITLE_BODY',
        payload: { body, url },
      }, '*');
      console.log(`Extractor (Bilibili): ✅ Subtitle body dispatched (${body.length} items)`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 策略 A：拦截 XHR / Fetch — 捕获 B站 Player API 和字幕 JSON
    // B站播放器加载视频时会请求 api.bilibili.com/x/player/v2（或 wbi/v2），
    // 响应 data.subtitle.subtitles 包含字幕轨道列表。
    // 实际字幕 JSON 从 *.hdslb.com/bfs/subtitle/ 获取。
    // ═══════════════════════════════════════════════════════════════════════

    const origXHROpen = XMLHttpRequest.prototype.open;
    const origXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: any[]
    ) {
      (this as any).__biliUrl = String(url);
      return (origXHROpen as any).apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function(this: XMLHttpRequest, ...args: any[]) {
      const url: string = (this as any).__biliUrl || '';

      // 拦截 Player API（字幕轨道列表）
      if (url.includes('/x/player/v2') || url.includes('/x/player/wbi/v2')) {
        this.addEventListener('load', function() {
          try {
            const json = JSON.parse(this.responseText);
            const subtitles = json?.data?.subtitle?.subtitles;
            if (subtitles && Array.isArray(subtitles) && subtitles.length > 0) {
              console.log('Extractor (Bilibili/XHR): ✅ Player API intercepted');
              dispatchTracks(subtitles);
            }
          } catch (e) {
            // 解析失败，忽略
          }
        });
      }

      // 拦截实际字幕 JSON（备用路径：直接捕获字幕内容）
      if (url.includes('hdslb.com') && url.includes('subtitle')) {
        this.addEventListener('load', function() {
          try {
            const json = JSON.parse(this.responseText);
            if (json?.body && Array.isArray(json.body) && json.body.length > 0) {
              console.log('Extractor (Bilibili/XHR): ✅ Subtitle JSON intercepted');
              dispatchSubtitleBody(json.body, url);
            }
          } catch (e) {
            // 解析失败，忽略
          }
        });
      }

      return (origXHRSend as any).apply(this, args);
    };

    // Fetch 拦截
    const origFetch = window.fetch;
    window.fetch = async function(...args: any[]) {
      const request = args[0];
      const url = typeof request === 'string' ? request : (request as Request)?.url || '';

      const response = await (origFetch as any).apply(this, args);

      // 拦截 Player API
      if (url.includes('/x/player/v2') || url.includes('/x/player/wbi/v2')) {
        const cloned = response.clone();
        cloned.json().then((json: any) => {
          const subtitles = json?.data?.subtitle?.subtitles;
          if (subtitles && Array.isArray(subtitles) && subtitles.length > 0) {
            console.log('Extractor (Bilibili/fetch): ✅ Player API intercepted');
            dispatchTracks(subtitles);
          }
        }).catch(() => {});
      }

      // 拦截字幕 JSON
      if (url.includes('hdslb.com') && url.includes('subtitle')) {
        const cloned = response.clone();
        cloned.json().then((json: any) => {
          if (json?.body && Array.isArray(json.body) && json.body.length > 0) {
            console.log('Extractor (Bilibili/fetch): ✅ Subtitle JSON intercepted');
            dispatchSubtitleBody(json.body, url);
          }
        }).catch(() => {});
      }

      return response;
    };

    console.log('Extractor (Bilibili): XHR/Fetch 拦截器已安装');

    // ═══════════════════════════════════════════════════════════════════════
    // 策略 B：__INITIAL_STATE__ 保底
    // B站 SSR 会在页面初始化时将数据注入到全局变量中
    // ═══════════════════════════════════════════════════════════════════════

    const tryInitialState = () => {
      if (tracksSent) return true;

      const state = (window as any).__INITIAL_STATE__;
      const candidates = [
        state?.videoData?.subtitle?.subtitles,
        state?.subtitle?.subtitles,
        (window as any).player?.subtitle?.subtitles,
        state?.videoData?.subtitle?.list,
        state?.playerInfo?.subtitle?.subtitles,
      ];

      for (const subtitles of candidates) {
        if (subtitles && Array.isArray(subtitles) && subtitles.length > 0) {
          console.log('Extractor (Bilibili): ✅ Found subtitles via __INITIAL_STATE__');
          dispatchTracks(subtitles);
          return true;
        }
      }

      console.log('Extractor (Bilibili): __INITIAL_STATE__ 未找到字幕');
      return false;
    };

    // 延时尝试 __INITIAL_STATE__（等待 B站 hydration）
    setTimeout(tryInitialState, 2000);
    setTimeout(tryInitialState, 5000);

    // ═══════════════════════════════════════════════════════════════════════
    // URL 变化监听 (B站 SPA 导航)
    // ═══════════════════════════════════════════════════════════════════════

    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
      const url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        tracksSent = false;
        console.log('Extractor (Bilibili): URL changed, waiting for new subtitle data...');
        setTimeout(tryInitialState, 2500);
      }
    });
    observer.observe(document, { subtree: true, childList: true });

    return;
  }

  console.warn('Extractor: Unsupported host:', hostname);
});

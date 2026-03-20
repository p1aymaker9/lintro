/**
 * Offscreen Document — 核心请求执行者
 *
 * 运行在一个隐藏的离屏 HTML 页面上下文中。
 * 相比 Service Worker，它是完整的页面环境，fetch 时会携带
 * 浏览器存储的 Cookie，且受 DNR 规则处理，能绕过 CORS/CSP 限制。
 */
export default defineUnlistedScript(() => {
  // 降噪：仅静默 console.log，保留 console.warn/error。
  const console = Object.assign({}, globalThis.console, {
    log: (..._args: unknown[]) => {},
  }) as Console;

  console.log('Offscreen: Document ready.');

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'OFFSCREEN_FETCH') {
      console.log('Offscreen: Fetching URL:', message.url);

      fetch(message.url, { credentials: 'include' })
        .then(async (res) => {
          const text = await res.text();
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          if (!text) throw new Error('Empty response body received');
          console.log('Offscreen: Success, response length:', text.length);
          sendResponse({ success: true, data: text });
        })
        .catch((err) => {
          console.error('Offscreen: Fetch error:', err.message);
          sendResponse({ success: false, error: err.message });
        });

      return true; // 保持异步通道开启
    }
  });
});

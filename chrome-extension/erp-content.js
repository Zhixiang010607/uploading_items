(() => {
  "use strict";

  const CHANNEL = "temu-readonly-helper-bridge";
  const STORAGE_KEY = "temuReadOnlyTemplateSync";
  const pending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || message.type !== "SYNC_READONLY_TEMPLATES_RESULT") return;
    const request = pending.get(message.requestId);
    if (!request) return;
    window.clearTimeout(request.timeoutId);
    pending.delete(message.requestId);
    message.ok ? request.resolve(message.payload) : request.reject(new Error(message.error || "妙手模板同步失败"));
  });

  function requestPageSync() {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("妙手模板读取超时，请确认页面仍处于登录状态"));
      }, 60000);
      pending.set(requestId, { resolve, reject, timeoutId });
      window.postMessage({
        channel: CHANNEL,
        type: "SYNC_READONLY_TEMPLATES",
        requestId
      }, window.location.origin);
    });
  }

  async function runSync() {
    const payload = await requestPageSync();
    await chrome.storage.local.set({ [STORAGE_KEY]: payload });
    return {
      ok: true,
      shopCount: payload.shops.length,
      productCount: payload.productTemplates.length,
      skuCount: payload.skuTemplates.length,
      syncedAt: payload.syncedAt
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "START_READONLY_TEMPLATE_SYNC") return false;
    runSync()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "妙手模板同步失败" }));
    return true;
  });
})();

(() => {
  "use strict";

  const CHANNEL = "temu-readonly-helper-bridge";
  const STORAGE_KEY = "temuReadOnlyTemplateSync";
  const SYNC_RESPONSE_TYPE = "SYNC_READONLY_TEMPLATES_RESULT";
  const DRAFT_RESPONSE_TYPE = "CREATE_TEMPLATE_DRAFTS_RESULT";
  const pending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || ![SYNC_RESPONSE_TYPE, DRAFT_RESPONSE_TYPE].includes(message.type)) return;
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

  function requestTemplateDraftJob(payload) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("妙手草稿处理超时，请保持妙手页面开启"));
      }, 30 * 60 * 1000);
      pending.set(requestId, { resolve, reject, timeoutId });
      window.postMessage({
        channel: CHANNEL,
        type: "CREATE_TEMPLATE_DRAFTS",
        requestId,
        payload
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
    if (message?.type === "START_READONLY_TEMPLATE_SYNC") {
      runSync()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || "妙手模板同步失败" }));
      return true;
    }
    if (message?.type !== "START_TEMPLATE_DRAFT_JOB") return false;
    requestTemplateDraftJob(message.payload)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "创建未发布草稿失败" }));
    return true;
  });
})();

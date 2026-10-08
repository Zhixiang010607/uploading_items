(() => {
  "use strict";

  const STORAGE_KEY = "temuReadOnlyTemplateSync";
  const PUBLISHER_SOURCE = "temu-publisher";
  const HELPER_SOURCE = "temu-readonly-helper";

  function sendDraftResult(requestId, response) {
    window.postMessage({
      source: HELPER_SOURCE,
      type: "TEMPLATE_DRAFT_JOB_RESULT",
      requestId,
      ok: Boolean(response?.ok),
      payload: response?.payload || null,
      error: response?.error || ""
    }, window.location.origin);
  }

  function sendToPublisher(payload, fresh = false) {
    window.postMessage({
      source: HELPER_SOURCE,
      type: "READONLY_TEMPLATE_DATA",
      ok: Boolean(payload),
      fresh,
      payload: payload || null
    }, window.location.origin);
  }

  async function readAndSend(fresh = false) {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    sendToPublisher(result[STORAGE_KEY], fresh);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (message?.source !== PUBLISHER_SOURCE) return;
    if (message.type === "REQUEST_READONLY_TEMPLATE_DATA") {
      readAndSend(false).catch(() => sendToPublisher(null, false));
      return;
    }
    if (message.type === "REQUEST_TEMPLATE_DRAFT_JOB" && message.requestId) {
      chrome.runtime.sendMessage({ type: "RUN_TEMPLATE_DRAFT_JOB", payload: message.payload })
        .then((response) => sendDraftResult(message.requestId, response))
        .catch((error) => sendDraftResult(message.requestId, { ok: false, error: error.message }));
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]?.newValue) return;
    sendToPublisher(changes[STORAGE_KEY].newValue, true);
  });
})();

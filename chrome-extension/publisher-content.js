(() => {
  "use strict";

  const STORAGE_KEY = "temuReadOnlyTemplateSync";
  const PUBLISHER_SOURCE = "temu-publisher";
  const HELPER_SOURCE = "temu-readonly-helper";

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
    if (message?.source !== PUBLISHER_SOURCE || message.type !== "REQUEST_READONLY_TEMPLATE_DATA") return;
    readAndSend(false).catch(() => sendToPublisher(null, false));
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]?.newValue) return;
    sendToPublisher(changes[STORAGE_KEY].newValue, true);
  });
})();

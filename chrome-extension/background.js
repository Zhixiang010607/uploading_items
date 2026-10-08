"use strict";

async function findErpTab() {
  const tabs = await chrome.tabs.query({ url: "https://erp.91miaoshou.com/*" });
  return tabs.find((tab) => tab.active) || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "RUN_TEMPLATE_DRAFT_JOB") return false;
  (async () => {
    const tab = await findErpTab();
    if (!tab?.id) throw new Error("没有找到已登录的妙手 ERP 页面，请保持妙手页面开启");
    return chrome.tabs.sendMessage(tab.id, {
      type: "START_TEMPLATE_DRAFT_JOB",
      payload: message.payload
    });
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || "创建未发布草稿失败" }));
  return true;
});

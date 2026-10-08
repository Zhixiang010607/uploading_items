"use strict";

const STORAGE_KEY = "temuReadOnlyTemplateSync";
const ERP_URL = "https://erp.91miaoshou.com/pddkj/move_collect/template_management/product";
const PUBLISHER_URL = "https://yanyujie-upload-item-d1ab8962386-1465086870.tcloudbaseapp.com/";

const statusDot = document.querySelector("#statusDot");
const statusTitle = document.querySelector("#statusTitle");
const statusText = document.querySelector("#statusText");
const syncBtn = document.querySelector("#syncBtn");

function setStatus(title, message, state = "warning") {
  statusTitle.textContent = title;
  statusText.textContent = message;
  statusDot.className = `status-dot ${state === "warning" ? "" : state}`;
}

function renderStored(payload) {
  const productCount = Array.isArray(payload?.productTemplates) ? payload.productTemplates.length : 0;
  const skuCount = Array.isArray(payload?.skuTemplates) ? payload.skuTemplates.length : 0;
  document.querySelector("#productCount").textContent = String(productCount);
  document.querySelector("#skuCount").textContent = String(skuCount);
  document.querySelector("#syncedAt").textContent = payload?.syncedAt
    ? `上次同步：${new Date(payload.syncedAt).toLocaleString("zh-CN", { hour12: false })}`
    : "尚未同步";
  return { productCount, skuCount };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isMiaoshouTab(tab) {
  try {
    return new URL(tab?.url || "").hostname === "erp.91miaoshou.com";
  } catch {
    return false;
  }
}

async function initialize() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const counts = renderStored(stored[STORAGE_KEY]);
  const tab = await activeTab();
  if (isMiaoshouTab(tab)) {
    syncBtn.disabled = false;
    setStatus("妙手页面已就绪", "点击同步后只读取产品模板和 SKU 模板。", "success");
  } else if (counts.productCount || counts.skuCount) {
    setStatus("已有只读同步记录", "需要更新时，请先打开已登录的妙手页面。", "success");
  } else {
    setStatus("等待妙手页面", "请先打开并登录妙手 ERP，再回到这里同步。", "warning");
  }
}

syncBtn.addEventListener("click", async () => {
  syncBtn.disabled = true;
  syncBtn.textContent = "正在只读同步…";
  setStatus("正在读取模板", "将自动读取全部分页，请保持妙手页面开启。", "warning");
  try {
    const tab = await activeTab();
    if (!isMiaoshouTab(tab)) throw new Error("当前标签页不是妙手 ERP");
    const response = await chrome.tabs.sendMessage(tab.id, { type: "START_READONLY_TEMPLATE_SYNC" });
    if (!response?.ok) throw new Error(response?.error || "插件没有收到同步结果");
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    renderStored(stored[STORAGE_KEY]);
    setStatus("只读同步完成", `产品模板 ${response.productCount} 个，SKU 模板 ${response.skuCount} 个。`, "success");
  } catch (error) {
    const detail = String(error?.message || error);
    const message = detail.includes("Receiving end does not exist")
      ? "请刷新妙手页面后再次点击同步。"
      : detail;
    setStatus("同步失败", message, "error");
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = "从当前妙手页面同步";
  }
});

document.querySelector("#openErpBtn").addEventListener("click", () => chrome.tabs.create({ url: ERP_URL }));
document.querySelector("#openPublisherBtn").addEventListener("click", () => chrome.tabs.create({ url: PUBLISHER_URL }));

initialize().catch((error) => setStatus("插件初始化失败", error.message || String(error), "error"));

"use strict";

const STORAGE_KEY = "temuReadOnlyTemplateSync";
const PREFLIGHT_KEY = "temuTemplatePreflightResult";
const ERP_URL = "https://erp.91miaoshou.com/pddkj/move_collect/template_management/product";
const PUBLISHER_URL = "https://yanyujie-upload-item-d1ab8962386-1465086870.tcloudbaseapp.com/";

const statusDot = document.querySelector("#statusDot");
const statusTitle = document.querySelector("#statusTitle");
const statusText = document.querySelector("#statusText");
const syncBtn = document.querySelector("#syncBtn");
const preflightBtn = document.querySelector("#preflightBtn");

function setStatus(title, message, state = "warning") {
  statusTitle.textContent = title;
  statusText.textContent = message;
  statusDot.className = `status-dot ${state === "warning" ? "" : state}`;
}

function renderStored(payload) {
  const shopCount = Array.isArray(payload?.shops) ? payload.shops.length : 0;
  const productCount = Array.isArray(payload?.productTemplates) ? payload.productTemplates.length : 0;
  const skuCount = Array.isArray(payload?.skuTemplates) ? payload.skuTemplates.length : 0;
  document.querySelector("#shopCount").textContent = String(shopCount);
  document.querySelector("#productCount").textContent = String(productCount);
  document.querySelector("#skuCount").textContent = String(skuCount);
  document.querySelector("#syncedAt").textContent = payload?.syncedAt
    ? `上次同步：${new Date(payload.syncedAt).toLocaleString("zh-CN", { hour12: false })}`
    : "尚未同步";
  preflightBtn.disabled = !(shopCount && productCount && skuCount);
  return { shopCount, productCount, skuCount };
}

function chooseTemplate(items) {
  return items.find((item) => /冰箱贴/.test(item.name)) || items[0];
}

function buildPreflightJob(payload) {
  const shop = payload.shops[0];
  const productTemplate = chooseTemplate(payload.productTemplates);
  const skuTemplate = chooseTemplate(payload.skuTemplates);
  return {
    labels: { shop: shop.name, productTemplate: productTemplate.name, skuTemplate: skuTemplate.name },
    job: {
      mode: "queue",
      dryRun: true,
      shopId: shop.id,
      productTemplateId: productTemplate.id,
      skuTemplateId: skuTemplate.id,
      products: [{
        index: 1,
        title: "只读模板预检（不会创建商品）",
        images: Array.from({ length: 6 }, (_, index) => `https://example.invalid/temu-preflight/1.${index + 1}.jpg`)
      }]
    }
  };
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
  const stored = await chrome.storage.local.get([STORAGE_KEY, PREFLIGHT_KEY]);
  const counts = renderStored(stored[STORAGE_KEY]);
  const tab = await activeTab();
  if (isMiaoshouTab(tab)) {
    syncBtn.disabled = false;
    setStatus("妙手页面已就绪", "点击后同步产品模板和 SKU 模板。", "success");
  } else if (counts.shopCount || counts.productCount || counts.skuCount) {
    setStatus("已有只读同步记录", "需要更新时，请先打开已登录的妙手页面。", "success");
  } else {
    setStatus("等待妙手页面", "请先打开并登录妙手 ERP，再回到这里同步。", "warning");
  }
  const lastCheck = stored[PREFLIGHT_KEY];
  if (lastCheck?.checkedAt) {
    if (lastCheck.ok) {
      const first = lastCheck.response?.payload?.firstProduct || {};
      setStatus(
        "真实只读预检通过",
        `${lastCheck.labels?.shop || "店铺"}｜${lastCheck.labels?.productTemplate || "产品模板"} + ${lastCheck.labels?.skuTemplate || "SKU 模板"}｜轮播图 ${first.imageCount || 0} 张，SKU ${first.skuCount || 0} 个，类目${first.hasCategory ? "完整" : "缺失"}。`,
        "success"
      );
    } else {
      setStatus("只读预检失败", lastCheck.response?.error || "妙手没有返回预检结果", "error");
    }
  }
}

syncBtn.addEventListener("click", async () => {
  syncBtn.disabled = true;
  syncBtn.textContent = "正在同步…";
  setStatus("正在读取模板", "将自动读取全部分页，请保持妙手页面开启。", "warning");
  try {
    const tab = await activeTab();
    if (!isMiaoshouTab(tab)) throw new Error("当前标签页不是妙手 ERP");
    const response = await chrome.tabs.sendMessage(tab.id, { type: "START_READONLY_TEMPLATE_SYNC" });
    if (!response?.ok) throw new Error(response?.error || "插件没有收到同步结果");
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    renderStored(stored[STORAGE_KEY]);
    setStatus("只读同步完成", `店铺 ${response.shopCount} 个，产品模板 ${response.productCount} 个，SKU 模板 ${response.skuCount} 个。`, "success");
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

preflightBtn.addEventListener("click", async () => {
  preflightBtn.disabled = true;
  preflightBtn.textContent = "正在只读预检…";
  setStatus("正在组装两个模板", "只调用妙手模板接口，不创建或发布商品。", "warning");
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const payload = stored[STORAGE_KEY];
    if (!payload?.shops?.length || !payload?.productTemplates?.length || !payload?.skuTemplates?.length) {
      throw new Error("请先同步店铺、产品模板和 SKU 模板");
    }
    const { labels, job } = buildPreflightJob(payload);
    const response = await chrome.runtime.sendMessage({
      type: "RUN_TEMPLATE_DRAFT_JOB",
      payload: job,
      preflight: true,
      labels
    });
    if (!response?.ok || !response?.payload?.dryRun) throw new Error(response?.error || "妙手没有返回预检结果");
    const first = response.payload.firstProduct || {};
    setStatus(
      "真实只读预检通过",
      `${labels.shop}｜${labels.productTemplate} + ${labels.skuTemplate}｜轮播图 ${first.imageCount || 0} 张，SKU ${first.skuCount || 0} 个，类目${first.hasCategory ? "完整" : "缺失"}。`,
      "success"
    );
  } catch (error) {
    setStatus("只读预检失败", error.message || String(error), "error");
  } finally {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    renderStored(stored[STORAGE_KEY]);
    preflightBtn.textContent = "真实只读预检模板";
  }
});

document.querySelector("#openErpBtn").addEventListener("click", () => chrome.tabs.create({ url: ERP_URL }));
document.querySelector("#openPublisherBtn").addEventListener("click", () => chrome.tabs.create({ url: PUBLISHER_URL }));

initialize().catch((error) => setStatus("插件初始化失败", error.message || String(error), "error"));

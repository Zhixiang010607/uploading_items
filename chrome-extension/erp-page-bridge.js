(() => {
  "use strict";

  const CHANNEL = "temu-readonly-helper-bridge";
  const REQUEST_TYPE = "SYNC_READONLY_TEMPLATES";
  const RESPONSE_TYPE = "SYNC_READONLY_TEMPLATES_RESULT";
  const PAGE_SIZE = 100;
  const MAX_PAGES = 100;
  const ENDPOINTS = [
    {
      key: "productTemplates",
      path: "/api/platform/pddkj/item/item_template/searchTemplateList",
      listKey: "itemTemplateList",
      idKeys: ["itemTemplateId", "templateId", "id"]
    },
    {
      key: "skuTemplates",
      path: "/api/platform/pddkj/item/sku_prop_template/searchSkuPropTemplate",
      listKey: "skuPropTemplateList",
      idKeys: ["skuPropTemplateId", "templateId", "id"]
    }
  ];

  function findNamedArray(value, key, depth = 0) {
    if (depth > 6 || value == null || typeof value !== "object") return null;
    if (Array.isArray(value[key])) return value[key];
    for (const nested of Object.values(value)) {
      const found = findNamedArray(nested, key, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function firstValue(record, keys) {
    for (const key of keys) {
      const value = record?.[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return "";
  }

  function sanitizeList(records, definition) {
    const output = [];
    const seen = new Set();
    for (const record of records) {
      const id = firstValue(record, definition.idKeys);
      const name = firstValue(record, ["name", "templateName"]);
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      output.push({ id, name });
    }
    return output;
  }

  function assertSuccessfulPayload(payload) {
    const result = String(payload?.result || "").toLowerCase();
    if (result === "fail" || payload?.success === false) {
      throw new Error(payload?.reason || payload?.message || `妙手接口读取失败（${payload?.code || "未知错误"}）`);
    }
  }

  async function readPage(definition, pageNo) {
    const url = new URL(definition.path, window.location.origin);
    url.searchParams.set("pageNo", String(pageNo));
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`妙手接口返回 HTTP ${response.status}`);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("妙手登录状态不可用，请重新登录妙手 ERP");
    }
    assertSuccessfulPayload(payload);
    const list = findNamedArray(payload, definition.listKey);
    if (!list) throw new Error(`妙手返回内容中缺少 ${definition.listKey}`);
    return list;
  }

  async function readAll(definition) {
    const output = [];
    const seen = new Set();
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
      const page = await readPage(definition, pageNo);
      for (const item of sanitizeList(page, definition)) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        output.push(item);
      }
      if (page.length < PAGE_SIZE) return output;
    }
    throw new Error("模板数量超过 10000 条，为避免漏读已停止同步");
  }

  async function synchronize() {
    const [productTemplates, skuTemplates] = await Promise.all(ENDPOINTS.map(readAll));
    return {
      version: 1,
      source: "erp.91miaoshou.com",
      syncedAt: new Date().toISOString(),
      productTemplates,
      skuTemplates
    };
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || message.type !== REQUEST_TYPE || !message.requestId) return;
    try {
      const payload = await synchronize();
      window.postMessage({
        channel: CHANNEL,
        type: RESPONSE_TYPE,
        requestId: message.requestId,
        ok: true,
        payload
      }, window.location.origin);
    } catch (error) {
      window.postMessage({
        channel: CHANNEL,
        type: RESPONSE_TYPE,
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : "妙手模板同步失败"
      }, window.location.origin);
    }
  });
})();

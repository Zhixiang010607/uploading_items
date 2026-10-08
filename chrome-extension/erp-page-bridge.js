(() => {
  "use strict";

  const CHANNEL = "temu-readonly-helper-bridge";
  const REQUEST_TYPE = "SYNC_READONLY_TEMPLATES";
  const RESPONSE_TYPE = "SYNC_READONLY_TEMPLATES_RESULT";
  const DRAFT_REQUEST_TYPE = "CREATE_TEMPLATE_DRAFTS";
  const DRAFT_RESPONSE_TYPE = "CREATE_TEMPLATE_DRAFTS_RESULT";
  const ERP_COLLECT_BOX_BASE = "/api/platform/pddkj/move/collect_box/";
  const PAGE_SIZE = 100;
  const MAX_PAGES = 100;
  let erpAppApiPromise = null;
  const SHOP_ENDPOINTS = [
    "/api/auth/shop/getAllShopV2",
    "/api/auth/shop/getAllShop"
  ];
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

  function findRecordArray(value, requiredKey, depth = 0) {
    if (depth > 6 || value == null) return null;
    if (Array.isArray(value)) {
      return value.some((item) => item && typeof item === "object" && requiredKey in item) ? value : null;
    }
    if (typeof value !== "object") return null;
    for (const nested of Object.values(value)) {
      const found = findRecordArray(nested, requiredKey, depth + 1);
      if (found) return found;
    }
    return null;
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

  function sanitizeShops(records) {
    const output = [];
    const seen = new Set();
    for (const record of records) {
      const id = firstValue(record, ["shopId", "shop_id", "id"]);
      const name = firstValue(record, ["shopNick", "platformShopName", "shopName", "name"]);
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

  async function readShops() {
    let lastError = null;
    for (const path of SHOP_ENDPOINTS) {
      try {
        const url = new URL(path, window.location.origin);
        url.searchParams.set("platform", "pddkj");
        url.searchParams.set("pageNo", "1");
        url.searchParams.set("pageSize", "100000");
        const response = await fetch(url, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json" }
        });
        if (!response.ok) throw new Error(`妙手店铺接口返回 HTTP ${response.status}`);
        const payload = await response.json();
        assertSuccessfulPayload(payload);
        const list = findNamedArray(payload, "shopList") || findRecordArray(payload, "shopId") || [];
        const shops = sanitizeShops(list);
        if (shops.length) return shops;
        lastError = new Error("妙手店铺列表为空");
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("没有读取到妙手店铺名称");
  }

  async function synchronize() {
    const [shops, productTemplates, skuTemplates] = await Promise.all([
      readShops(),
      ...ENDPOINTS.map(readAll)
    ]);
    return {
      version: 2,
      source: "erp.91miaoshou.com",
      syncedAt: new Date().toISOString(),
      shops,
      productTemplates,
      skuTemplates
    };
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function findMainModuleUrl() {
    const moduleScript = Array.from(document.scripts).find((script) => {
      const src = script.src || "";
      return script.type === "module" && /\/assets\/\d+\/index-[a-f0-9]+\.js(?:\?|$)/i.test(src);
    });
    if (!moduleScript?.src) throw new Error("没有找到妙手当前网页模块，请刷新妙手页面后重试");
    return moduleScript.src;
  }

  function findEndpointExport(source, endpoint) {
    const escapedEndpoint = escapeRegExp(endpoint);
    const functionPattern = new RegExp(
      'function\\s+([\\w$]+)\\(e,t\\)\\{return\\s+[\\w$]+\\(e,\\{url:`\\$\\{[\\w$]+\\}' + escapedEndpoint + '`'
    );
    const arrowPattern = new RegExp(
      '(?:const|,)\\s*([\\w$]+)=\\(e,t\\)=>[\\w$]+\\(e,\\{url:`\\$\\{[\\w$]+\\}' + escapedEndpoint + '`'
    );
    const internalName = source.match(functionPattern)?.[1] || source.match(arrowPattern)?.[1];
    if (!internalName) throw new Error(`妙手当前版本中未找到接口 ${endpoint}`);

    const exportStart = source.lastIndexOf("export{");
    if (exportStart < 0) throw new Error("妙手当前网页模块没有公开接口映射");
    const exportBlock = source.slice(exportStart + 7);
    const exportMatch = exportBlock.match(
      new RegExp(`(?:^|,)${escapeRegExp(internalName)}\\s+as\\s+([\\w$]+)(?:,|})`)
    );
    if (!exportMatch?.[1]) throw new Error(`妙手当前版本没有导出接口 ${endpoint}`);
    return exportMatch[1];
  }

  function findAssetModuleUrl(source, mainModuleUrl, prefix) {
    const match = source.match(new RegExp(`assets/\\d+/(${escapeRegExp(prefix)}-[a-f0-9]+\\.js)`, "i"));
    if (!match?.[1]) throw new Error(`妙手当前版本缺少 ${prefix} 模块`);
    return new URL(`./${match[1]}`, mainModuleUrl).href;
  }

  async function loadEndpointModule(moduleUrl, endpoints) {
    const [source, module] = await Promise.all([
      fetch(moduleUrl, { credentials: "omit", cache: "force-cache" }).then((response) => {
        if (!response.ok) throw new Error(`妙手网页模块读取失败（HTTP ${response.status}）`);
        return response.text();
      }),
      import(moduleUrl)
    ]);
    return Object.fromEntries(endpoints.map((endpoint) => {
      const exportName = findEndpointExport(source, endpoint);
      const api = module[exportName];
      if (typeof api !== "function") throw new Error(`妙手接口 ${endpoint} 当前不可调用`);
      return [endpoint, api];
    }));
  }

  async function loadErpAppApi() {
    const moduleUrl = findMainModuleUrl();
    const [source, module] = await Promise.all([
      fetch(moduleUrl, { credentials: "omit", cache: "force-cache" }).then((response) => {
        if (!response.ok) throw new Error(`妙手网页模块读取失败（HTTP ${response.status}）`);
        return response.text();
      }),
      import(moduleUrl)
    ]);
    const endpoints = [
      "rebuildCollectItemInfoBySkuTemplate",
      "createCollectBoxItem"
    ];
    const mainApi = Object.fromEntries(endpoints.map((endpoint) => {
      const exportName = findEndpointExport(source, endpoint);
      const api = module[exportName];
      if (typeof api !== "function") throw new Error(`妙手接口 ${endpoint} 当前不可调用`);
      return [endpoint, api];
    }));
    const productTemplateApi = await loadEndpointModule(
      findAssetModuleUrl(source, moduleUrl, "item_template"),
      ["getItemTemplate"]
    );
    return { ...mainApi, ...productTemplateApi };
  }

  async function getErpAppApi() {
    if (!erpAppApiPromise) {
      erpAppApiPromise = loadErpAppApi().catch((error) => {
        erpAppApiPromise = null;
        throw error;
      });
    }
    return erpAppApiPromise;
  }

  function readableErpError(error) {
    const payload = error?.response?.data;
    return payload?.reason || payload?.message || payload?.msg || error?.reason || error?.message || "妙手接口调用失败";
  }

  async function postErp(path, body) {
    const endpoint = String(path).split("/").filter(Boolean).pop();
    try {
      const api = await getErpAppApi();
      if (typeof api[endpoint] !== "function") throw new Error(`不允许调用妙手接口 ${endpoint}`);
      const payload = await api[endpoint]("pddkj", body);
      assertSuccessfulPayload(payload);
      return payload;
    } catch (error) {
      throw new Error(readableErpError(error));
    }
  }

  function collectItemInfo(payload) {
    const core = globalThis.TemuTemplateDraftCore;
    const named = core.findNamedObject(payload, ["siteCollectItemInfo", "collectItemInfo", "shopCollectItemInfo"]);
    if (named) return named;
    const data = payload?.data;
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
    throw new Error("妙手没有返回可用的模板内容");
  }

  function findDetailId(payload, depth = 0) {
    if (depth > 7 || payload == null) return "";
    if (typeof payload !== "object") return "";
    for (const key of ["collectBoxDetailId", "detailId", "id"]) {
      if (payload[key] !== undefined && payload[key] !== null && String(payload[key]).trim()) {
        return String(payload[key]).trim();
      }
    }
    for (const value of Object.values(payload)) {
      const found = findDetailId(value, depth + 1);
      if (found) return found;
    }
    return "";
  }

  async function buildCombinedTemplate(job) {
    const core = globalThis.TemuTemplateDraftCore;
    const productResponse = await postErp("/api/platform/pddkj/item/item_template/getItemTemplate", {
      itemTemplateId: job.productTemplateId
    });
    const productTemplate = core.findNamedObject(productResponse, ["getItemTemplate", "itemTemplate"]);
    if (!productTemplate) throw new Error("产品模板详情为空");
    const productInfo = core.applyProductTemplateModules(core.createDefaultCollectInfo(job.shopId), productTemplate);
    if (!productInfo.cid) throw new Error("产品模板没有类目，无法套用 SKU 模板");
    const skuTemplate = await postErp(`${ERP_COLLECT_BOX_BASE}rebuildCollectItemInfoBySkuTemplate`, {
      skuPropTemplateId: job.skuTemplateId,
      collectItemInfo: JSON.stringify(productInfo),
      applicationType: "cover",
      coverType: "completeCover"
    });
    return core.applyProductSkuAttributes(collectItemInfo(skuTemplate), productTemplate.skuAttribute);
  }

  async function createTemplateDrafts(input) {
    const core = globalThis.TemuTemplateDraftCore;
    if (!core) throw new Error("模板草稿组件没有加载，请刷新妙手页面");
    const job = core.normalizeDraftJob(input);
    if (!job.dryRun && (job.mode !== "queue" || job.confirmation !== "CREATE_UNPUBLISHED_ONLY_V1")) {
      throw new Error("仅允许创建未发布草稿，安全确认无效");
    }

    const combinedTemplate = await buildCombinedTemplate(job);
    if (job.dryRun) {
      const preview = core.applyProductOverrides(combinedTemplate, job.products[0], job.shopId);
      return {
        dryRun: true,
        productCount: job.products.length,
        firstProduct: {
          index: 1,
          title: preview.title,
          imageCount: preview.imgUrls?.length || 0,
          previewImage: preview.imgUrls?.[0] || "",
          hasCategory: Boolean(preview.cid),
          skuCount: Object.keys(preview.skuMap || {}).length || preview.skuList?.length || 0
        }
      };
    }

    const results = [];
    for (const product of job.products) {
      const payload = core.buildCreatePayload(combinedTemplate, product, job.shopId);
      const created = await postErp(`${ERP_COLLECT_BOX_BASE}createCollectBoxItem`, payload);
      const collectBoxDetailId = findDetailId(created);
      if (!collectBoxDetailId) throw new Error(`产品 ${product.index} 已请求创建，但妙手未返回商品 ID，任务已停止`);
      results.push({ index: product.index, collectBoxDetailId });
    }
    return { dryRun: false, createdCount: results.length, results };
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || !message.requestId) return;
    const isSync = message.type === REQUEST_TYPE;
    const isDraft = message.type === DRAFT_REQUEST_TYPE;
    if (!isSync && !isDraft) return;
    try {
      const payload = isSync ? await synchronize() : await createTemplateDrafts(message.payload);
      window.postMessage({
        channel: CHANNEL,
        type: isSync ? RESPONSE_TYPE : DRAFT_RESPONSE_TYPE,
        requestId: message.requestId,
        ok: true,
        payload
      }, window.location.origin);
    } catch (error) {
      window.postMessage({
        channel: CHANNEL,
        type: isSync ? RESPONSE_TYPE : DRAFT_RESPONSE_TYPE,
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : (isSync ? "妙手模板同步失败" : "创建未发布草稿失败")
      }, window.location.origin);
    }
  });
})();

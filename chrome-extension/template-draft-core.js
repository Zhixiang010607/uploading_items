(() => {
  "use strict";

  const SITE = "PDDKJ";
  const MAX_PRODUCTS = 2000;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function parseMaybeJson(value) {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  function findNamedObject(value, keys, depth = 0) {
    if (depth > 7 || value == null) return null;
    const parsed = parseMaybeJson(value);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    for (const key of keys) {
      const candidate = parseMaybeJson(parsed[key]);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
    }
    for (const nested of Object.values(parsed)) {
      const found = findNamedObject(nested, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function requiredText(value, label) {
    const text = String(value ?? "").trim();
    if (!text) throw new Error(`${label}不能为空`);
    return text;
  }

  function normalizeDraftJob(input) {
    const job = {
      mode: input?.mode,
      dryRun: Boolean(input?.dryRun),
      confirmation: String(input?.confirmation || ""),
      shopId: requiredText(input?.shopId, "店铺 ID"),
      productTemplateId: requiredText(input?.productTemplateId, "产品模板 ID"),
      skuTemplateId: requiredText(input?.skuTemplateId, "SKU 模板 ID"),
      products: Array.isArray(input?.products) ? input.products : []
    };
    if (!job.products.length || job.products.length > MAX_PRODUCTS) {
      throw new Error(`草稿产品数量必须为 1-${MAX_PRODUCTS}`);
    }
    job.products = job.products.map((product, offset) => {
      const index = Number(product?.index);
      if (!Number.isInteger(index) || index !== offset + 1) {
        throw new Error(`产品序号必须从 1 连续排列，当前位置为 ${product?.index}`);
      }
      const images = Array.isArray(product?.images) ? product.images.map(String) : [];
      if (images.length !== 6 || images.some((url) => !/^https:\/\//i.test(url))) {
        throw new Error(`产品 ${index} 必须包含 6 个有效的妙手图片地址`);
      }
      return {
        index,
        title: requiredText(product?.title, `产品 ${index} 标题`),
        images
      };
    });
    return job;
  }

  function applyProductOverrides(templateInfo, product, shopId) {
    const item = clone(templateInfo || {});
    item.title = product.title;
    item.multiLanguageTitleMap = { ...(item.multiLanguageTitleMap || {}), en: product.title };
    item.imgUrls = [...product.images];
    item.shopIds = [shopId];

    if (item.skuMap && typeof item.skuMap === "object") {
      Object.values(item.skuMap).forEach((sku) => {
        if (sku && typeof sku === "object") sku.imgUrl = product.images[0];
      });
    }
    if (Array.isArray(item.skuList)) {
      item.skuList.forEach((sku) => {
        if (sku && typeof sku === "object") sku.imgUrl = product.images[0];
      });
    }
    return item;
  }

  function buildCreatePayload(templateInfo, product, shopId) {
    return {
      shopIds: [shopId],
      site: SITE,
      siteCollectItemInfo: JSON.stringify(applyProductOverrides(templateInfo, product, shopId))
    };
  }

  const api = Object.freeze({
    SITE,
    normalizeDraftJob,
    findNamedObject,
    applyProductOverrides,
    buildCreatePayload
  });

  globalThis.TemuTemplateDraftCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

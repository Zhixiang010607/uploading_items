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

  function createDefaultCollectInfo(shopId) {
    return {
      collectBoxDetailShopList: [{
        shopId,
        shopName: "",
        sizeTemplateId: "",
        brandId: null
      }],
      cid: "",
      attributes: [],
      title: "",
      multiLanguageTitleMap: { en: "" },
      itemNum: "",
      productOriginCountry: "",
      productOriginProvince: "",
      productOriginCertFiles: [],
      outerGoodsUrl: "",
      imgUrls: [],
      personalizationSwitch: "0",
      saleAttributes: [],
      skuMap: {},
      sizeCharts: [],
      shopIdAndGoodsModelReqMap: {},
      isBasePlate: "0",
      basePlateSkuKey: "",
      mainImgAppVideoId: "",
      mainImgVideoUrl: "",
      outerPackageShape: "",
      outerPackageType: "",
      outerPackageImgUrls: [],
      goodsLayerDecorationReqs: [],
      sourceList: [],
      inventoryRegion: 1,
      productGuideFileUrl: "",
      productGuideFileName: "",
      translateLanguages: [],
      collectShowSizeTemplateIds: [],
      firstType: "",
      technologyType: "",
      twiceType: [],
      vehicleLibraryRelationList: [],
      notesVideoId: "",
      notesVideoUrl: "",
      manufacturingLocationRegionShortNameList: []
    };
  }

  function applyProductTemplateModules(item, template) {
    item.cid = template.cid == null ? "" : String(template.cid);
    if (template.attribute?.attributes) item.attributes = clone(template.attribute.attributes);

    if (template.productInfo) {
      const fields = [
        "productOriginCountry",
        "productOriginProvince",
        "productOriginCertFiles",
        "manufacturingLocationRegionShortNameList",
        "outerGoodsUrl",
        "personalizationSwitch",
        "technologyType",
        "firstType",
        "twiceType"
      ];
      fields.forEach((field) => {
        if (template.productInfo[field] !== undefined) item[field] = clone(template.productInfo[field]);
      });
    }

    if (template.package) {
      ["outerPackageShape", "outerPackageType", "outerPackageImgUrls"].forEach((field) => {
        if (template.package[field] !== undefined) item[field] = clone(template.package[field]);
      });
    }

    if (template.description?.goodsLayerDecorationReqs !== undefined) {
      const description = template.description.goodsLayerDecorationReqs;
      try {
        item.goodsLayerDecorationReqs = typeof description === "string" ? JSON.parse(description) : clone(description);
      } catch {
        throw new Error("产品模板中的商品描述格式无效");
      }
    }

    if (template.productGuideFile) {
      ["productGuideFileName", "productGuideFileUrl"].forEach((field) => {
        if (template.productGuideFile[field] !== undefined) item[field] = template.productGuideFile[field];
      });
    }
    if (template.basePlate?.type !== undefined) item.isBasePlate = template.basePlate.type;
    return item;
  }

  function applyProductSkuAttributes(item, skuAttribute) {
    if (!skuAttribute || typeof skuAttribute !== "object") return item;
    const fields = [
      "isSensitive",
      "sensitiveTypes",
      "sensitiveLimit",
      "length",
      "width",
      "height",
      "weight",
      "skuClassification",
      "numberOfPieces",
      "pieceUnitCode",
      "individuallyPacked",
      "netContentNumber",
      "netContentUnitCode",
      "mixedType",
      "numberOfPiecesNew",
      "pieceNewUnitCode",
      "totalNetContentNumber",
      "totalNetContentUnitCode",
      "netWeight"
    ];
    Object.values(item.skuMap || {}).forEach((sku) => {
      if (!sku || typeof sku !== "object") return;
      fields.forEach((field) => {
        if (skuAttribute[field] !== undefined) sku[field] = clone(skuAttribute[field]);
      });
    });
    return item;
  }

  const api = Object.freeze({
    SITE,
    normalizeDraftJob,
    findNamedObject,
    applyProductOverrides,
    buildCreatePayload,
    createDefaultCollectInfo,
    applyProductTemplateModules,
    applyProductSkuAttributes
  });

  globalThis.TemuTemplateDraftCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

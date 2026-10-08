"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../chrome-extension/template-draft-core.js");

function product(index) {
  return {
    index,
    title: `Title ${index}`,
    images: Array.from({ length: 6 }, (_, offset) => `https://images.example/${index}.${offset + 1}.jpg`)
  };
}

test("normalizes a contiguous draft job", () => {
  const job = core.normalizeDraftJob({
    mode: "queue",
    confirmation: "CREATE_UNPUBLISHED_ONLY_V1",
    shopId: "shop-1",
    productTemplateId: "product-template-1",
    skuTemplateId: "sku-template-1",
    products: [product(1), product(2)]
  });
  assert.equal(job.products.length, 2);
  assert.equal(job.products[1].images[5], "https://images.example/2.6.jpg");
});

test("copies templates then overrides title and all image positions", () => {
  const template = {
    cid: "123",
    title: "Template title",
    imgUrls: ["https://old.example/image.jpg"],
    multiLanguageTitleMap: { en: "Old title" },
    skuMap: {
      red: { price: "1.00", imgUrl: "https://old.example/sku.jpg" }
    }
  };
  const result = core.applyProductOverrides(template, product(1), "shop-1");
  assert.equal(result.title, "Title 1");
  assert.equal(result.multiLanguageTitleMap.en, "Title 1");
  assert.deepEqual(result.imgUrls, product(1).images);
  assert.equal(result.skuMap.red.imgUrl, product(1).images[0]);
  assert.equal(result.skuMap.red.price, "1.00");
  assert.equal(template.title, "Template title");
});

test("builds the unpublished create payload", () => {
  const payload = core.buildCreatePayload({ cid: "123", skuMap: {} }, product(1), "shop-1");
  const item = JSON.parse(payload.siteCollectItemInfo);
  assert.deepEqual(payload.shopIds, ["shop-1"]);
  assert.equal(payload.site, "PDDKJ");
  assert.equal(item.imgUrls.length, 6);
  assert.equal(item.imgUrls[0], "https://images.example/1.1.jpg");
});

test("rejects incomplete image groups", () => {
  const incomplete = product(1);
  incomplete.images.pop();
  assert.throws(() => core.normalizeDraftJob({
    shopId: "shop-1",
    productTemplateId: "product-template-1",
    skuTemplateId: "sku-template-1",
    products: [incomplete]
  }), /必须包含 6 个/);
});

test("finds JSON encoded collect item information", () => {
  const payload = { data: { siteCollectItemInfo: JSON.stringify({ cid: "123", title: "Template" }) } };
  assert.deepEqual(core.findNamedObject(payload, ["siteCollectItemInfo"]), { cid: "123", title: "Template" });
});

test("applies reusable product template modules without sharing references", () => {
  const template = {
    cid: 456,
    attribute: { attributes: [{ id: "material", value: "metal" }] },
    productInfo: {
      productOriginCountry: "CN",
      productOriginCertFiles: [{ url: "https://example.test/cert.jpg" }],
      personalizationSwitch: "1"
    },
    package: {
      outerPackageShape: "BOX",
      outerPackageImgUrls: ["https://example.test/package.jpg"]
    },
    description: {
      goodsLayerDecorationReqs: '[{"type":"text","value":"description"}]'
    },
    productGuideFile: {
      productGuideFileName: "guide.pdf",
      productGuideFileUrl: "https://example.test/guide.pdf"
    },
    basePlate: { type: "1" }
  };
  const item = core.applyProductTemplateModules(core.createDefaultCollectInfo("shop-1"), template);

  assert.equal(item.cid, "456");
  assert.equal(item.productOriginCountry, "CN");
  assert.equal(item.outerPackageShape, "BOX");
  assert.equal(item.goodsLayerDecorationReqs[0].value, "description");
  assert.equal(item.productGuideFileName, "guide.pdf");
  assert.equal(item.isBasePlate, "1");
  item.attributes[0].value = "changed";
  assert.equal(template.attribute.attributes[0].value, "metal");
});

test("applies product SKU settings to every rebuilt SKU", () => {
  const item = {
    skuMap: {
      one: { price: "1.00" },
      two: { price: "2.00" }
    }
  };
  core.applyProductSkuAttributes(item, {
    length: 10,
    width: 20,
    netWeight: 30,
    ignoredField: "do not copy"
  });

  assert.equal(item.skuMap.one.length, 10);
  assert.equal(item.skuMap.two.width, 20);
  assert.equal(item.skuMap.one.netWeight, 30);
  assert.equal(item.skuMap.one.ignoredField, undefined);
});

test("rejects invalid product descriptions before any draft can be created", () => {
  assert.throws(() => core.applyProductTemplateModules(
    core.createDefaultCollectInfo("shop-1"),
    { description: { goodsLayerDecorationReqs: "not-json" } }
  ), /商品描述格式无效/);
});

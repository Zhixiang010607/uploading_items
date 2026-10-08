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

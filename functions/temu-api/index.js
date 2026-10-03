const crypto = require("node:crypto");
const cloudbase = require("@cloudbase/js-sdk");

const ENV_ID = process.env.TCB_ENV_ID || "yanyujie-upload-item-d1ab8962386";
const IMAGE_BUCKET = process.env.IMAGE_BUCKET || "temu-product-images";
const MIAOSHOU_BASE_URL = "https://openapi-erp.91miaoshou.com";
const MAX_ITEMS = 12000;
const DB_PAGE_SIZE = 1000;
const SIGN_CHUNK_LIMIT = 50;
const IMPORT_CHUNK_LIMIT = 24;

let app;
function getApp(context) {
  if (!app) app = cloudbase.init({ env: ENV_ID, context });
  return app;
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(payload)
  };
}

function parseBody(event, context = {}) {
  if (!event.body && context.httpContext) return event && typeof event === "object" ? event : {};
  if (!event.body) return {};
  if (typeof event.body === "object") return event.body;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "请求内容不是有效 JSON");
  }
}

class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

function requestPath(event, context = {}) {
  const rawUrl = event.path || event.rawPath || context.httpContext?.url || "/";
  const raw = String(rawUrl).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const normalized = raw.replace(/^\/api(?=\/|$)/, "") || "/";
  return normalized.replace(/\/$/, "") || "/";
}

function requireCredentials() {
  if (!process.env.MIAOSHOU_APP_ID || !process.env.MIAOSHOU_APP_SECRET) {
    throw new ApiError(503, "妙手开放平台凭证尚未配置");
  }
}

async function miaoshouRequest(path, body = {}) {
  requireCredentials();
  const bodyJson = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const appKey = process.env.MIAOSHOU_APP_ID;
  const appSecret = process.env.MIAOSHOU_APP_SECRET;
  const content = `${appSecret}${path}${timestamp}${appKey}${bodyJson}${appSecret}`;
  const sign = crypto.createHmac("sha256", appSecret).update(content).digest("hex");
  const response = await fetch(`${MIAOSHOU_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-app-key": appKey,
      "x-timestamp": timestamp,
      "x-sign": sign
    },
    body: bodyJson,
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 500) }; }
  if (!response.ok || data.result === "fail") {
    throw new ApiError(502, data.message || `妙手接口返回 ${response.status}`, {
      code: data.code || "upstreamError"
    });
  }
  return data;
}

function validateBatch(input) {
  const { id, manifestHash, products, items } = input;
  if (!/^[a-z0-9-]{16,80}$/.test(id || "")) throw new ApiError(400, "批次 ID 不合法");
  if (!/^[a-f0-9]{64}$/.test(manifestHash || "")) throw new ApiError(400, "批次清单哈希不合法");
  if (!Array.isArray(products) || products.length < 1) throw new ApiError(400, "产品标题不能为空");
  if (!Array.isArray(items) || items.length !== products.length * 6) {
    throw new ApiError(400, "图片数量必须严格等于产品数量乘以 6");
  }
  if (items.length > MAX_ITEMS) throw new ApiError(400, `单批最多 ${MAX_ITEMS} 张图片`);

  const slots = new Set();
  for (const item of items) {
    const slot = `${item.productIndex}.${item.imagePosition}`;
    if (!Number.isInteger(item.productIndex) || item.productIndex < 1 || item.productIndex > products.length) {
      throw new ApiError(400, `产品序号越界：${slot}`);
    }
    if (!Number.isInteger(item.imagePosition) || item.imagePosition < 1 || item.imagePosition > 6) {
      throw new ApiError(400, `图片位置错误：${slot}`);
    }
    if (slots.has(slot)) throw new ApiError(400, `图片槽位重复：${slot}`);
    if (!/^[a-f0-9]{64}$/.test(item.sha256 || "")) throw new ApiError(400, `SHA-256 不合法：${slot}`);
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0) throw new ApiError(400, `文件大小不合法：${slot}`);
    if (!/^image\/(jpeg|png|webp)$/i.test(item.mimeType || "")) throw new ApiError(400, `不支持的图片格式：${slot}`);
    slots.add(slot);
  }
  for (let product = 1; product <= products.length; product += 1) {
    for (let position = 1; position <= 6; position += 1) {
      if (!slots.has(`${product}.${position}`)) throw new ApiError(400, `缺少图片：${product}.${position}`);
    }
  }
}

async function createBatch(db, input) {
  validateBatch(input);
  const existing = await db.from("temu_upload_batches")
    .select("id,status,expected_count,uploaded_count,imported_count")
    .eq("manifest_hash", input.manifestHash)
    .limit(1);
  if (existing.error) throw new ApiError(500, "读取历史批次失败", existing.error);
  if (existing.data?.length) return { ...existing.data[0], resumed: true };

  const batch = {
    id: input.id,
    manifest_hash: input.manifestHash,
    status: "created",
    product_count: input.products.length,
    expected_count: input.items.length,
    store_id: input.storeId || null,
    product_template_id: input.productTemplateId || null,
    sku_template_id: input.skuTemplateId || null
  };
  const created = await db.from("temu_upload_batches").insert(batch);
  if (created.error) throw new ApiError(500, "创建上传批次失败", created.error);

  const rows = input.items.map((item) => ({
    batch_id: input.id,
    product_index: item.productIndex,
    image_position: item.imagePosition,
    original_name: item.originalName,
    object_key: `batches/${input.id}/${item.productIndex}.${item.imagePosition}-${item.sha256.slice(0, 16)}.${item.extension}`,
    size_bytes: item.sizeBytes,
    sha256: item.sha256,
    mime_type: item.mimeType
  }));
  for (let offset = 0; offset < rows.length; offset += 200) {
    const inserted = await db.from("temu_upload_items").insert(rows.slice(offset, offset + 200));
    if (inserted.error) throw new ApiError(500, "保存图片清单失败", inserted.error);
  }
  return { ...batch, resumed: false };
}

async function readBatchItems(db, batchId, columns = "*") {
  const rows = [];
  for (let offset = 0; ; offset += DB_PAGE_SIZE) {
    const page = await db.from("temu_upload_items")
      .select(columns)
      .eq("batch_id", batchId)
      .order("product_index")
      .order("image_position")
      .range(offset, offset + DB_PAGE_SIZE - 1);
    if (page.error) throw new ApiError(500, "读取图片清单失败", page.error);
    rows.push(...(page.data || []));
    if (!page.data || page.data.length < DB_PAGE_SIZE) return rows;
  }
}

async function batchStatus(db, batchId, includeItems = false) {
  const batchResult = await db.from("temu_upload_batches").select("*").eq("id", batchId).single();
  if (batchResult.error || !batchResult.data) throw new ApiError(404, "批次不存在");
  const result = { batch: batchResult.data };
  if (includeItems) {
    result.items = await readBatchItems(
      db,
      batchId,
      "product_index,image_position,object_key,size_bytes,sha256,mime_type,storage_status,erp_status,error_message"
    );
  }
  return result;
}

async function signUploads(db, storage, batchId, slots) {
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > SIGN_CHUNK_LIMIT) {
    throw new ApiError(400, `每次签名数量必须为 1-${SIGN_CHUNK_LIMIT}`);
  }
  const normalized = slots.map((slot) => `${Number(slot.productIndex)}.${Number(slot.imagePosition)}`);
  const all = await readBatchItems(
    db,
    batchId,
    "product_index,image_position,object_key,size_bytes,sha256,mime_type,storage_status"
  );
  const wanted = new Set(normalized);
  const items = all.filter((item) => wanted.has(`${item.product_index}.${item.image_position}`));
  if (items.length !== wanted.size) throw new ApiError(400, "签名请求包含不属于该批次的图片");

  const bucket = storage.from(IMAGE_BUCKET);
  const signed = [];
  for (const item of items) {
    if (item.storage_status === "uploaded") {
      signed.push({ ...item, alreadyUploaded: true });
      continue;
    }
    const result = await bucket.createSignedUploadUrl(item.object_key, { upsert: true });
    if (result.error) throw new ApiError(502, "生成图片上传凭证失败", result.error);
    signed.push({
      ...item,
      path: result.data.path,
      token: result.data.token,
      uploadUrl: result.data.fullSignedURL,
      alreadyUploaded: false
    });
  }
  return signed;
}

async function finalizeBatch(db, batchId) {
  const result = await db.rpc("temu_finalize_upload_batch", { p_batch_id: batchId });
  if (result.error) throw new ApiError(500, "云端图片核验失败", result.error);
  return Array.isArray(result.data) ? result.data[0] : result.data;
}

async function importImages(db, storage, batchId, slots) {
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > IMPORT_CHUNK_LIMIT) {
    throw new ApiError(400, `每次导入妙手数量必须为 1-${IMPORT_CHUNK_LIMIT}`);
  }
  const status = await batchStatus(db, batchId, false);
  if (status.batch.uploaded_count !== status.batch.expected_count || status.batch.status !== "uploaded") {
    throw new ApiError(409, "图片尚未全部通过云端校验，不能导入妙手");
  }
  const wanted = new Set(slots.map((slot) => `${Number(slot.productIndex)}.${Number(slot.imagePosition)}`));
  const query = await readBatchItems(db, batchId);
  const items = query.filter((item) => wanted.has(`${item.product_index}.${item.image_position}`));
  const bucket = storage.from(IMAGE_BUCKET);
  const output = [];
  for (const item of items) {
    if (item.erp_status === "imported") {
      output.push({ slot: `${item.product_index}.${item.image_position}`, status: "imported", resumed: true });
      continue;
    }
    try {
      const signed = await bucket.createSignedUrl(item.object_key, 86400);
      if (signed.error) throw signed.error;
      const publicUrl = signed.data.fullSignedURL;
      const erp = await miaoshouRequest("/open/v1/product/picture/picture_space/upload_picture_link", {
        imgUrl: publicUrl,
        scene: "product"
      });
      const erpUrl = erp.data?.url || erp.data?.imgUrl || erp.data?.pictureUrl || erp.data || null;
      await db.from("temu_upload_items").update({
        erp_status: "imported",
        erp_image_url: typeof erpUrl === "string" ? erpUrl : null,
        erp_response: erp,
        error_message: null,
        updated_at: new Date().toISOString()
      }).eq("batch_id", batchId).eq("product_index", item.product_index).eq("image_position", item.image_position);
      output.push({ slot: `${item.product_index}.${item.image_position}`, status: "imported" });
    } catch (error) {
      await db.from("temu_upload_items").update({
        erp_status: "failed",
        error_message: error.message,
        updated_at: new Date().toISOString()
      }).eq("batch_id", batchId).eq("product_index", item.product_index).eq("image_position", item.image_position);
      output.push({ slot: `${item.product_index}.${item.image_position}`, status: "failed", message: error.message });
    }
  }
  const countResult = await db.from("temu_upload_items").select("product_index", { count: "exact", head: true })
    .eq("batch_id", batchId).eq("erp_status", "imported");
  const importedCount = countResult.count || 0;
  await db.from("temu_upload_batches").update({
    imported_count: importedCount,
    status: importedCount === status.batch.expected_count ? "ready" : "importing",
    updated_at: new Date().toISOString()
  }).eq("id", batchId);
  return { items: output, importedCount, expectedCount: status.batch.expected_count };
}

async function cleanupBatch(db, storage, batchId) {
  const status = await batchStatus(db, batchId, true);
  if (status.batch.status !== "published") {
    throw new ApiError(409, "只有整批商品全部发布成功后才能删除临时图片");
  }
  const keys = status.items.map((item) => item.object_key);
  const bucket = storage.from(IMAGE_BUCKET);
  for (let offset = 0; offset < keys.length; offset += 100) {
    const removed = await bucket.remove(keys.slice(offset, offset + 100));
    if (removed.error) throw new ApiError(502, "删除云端临时图片失败", removed.error);
  }
  await db.from("temu_upload_batches").update({
    status: "cleaned",
    updated_at: new Date().toISOString()
  }).eq("id", batchId);
  return { deletedCount: keys.length, status: "cleaned" };
}

const READ_ENDPOINTS = {
  shops: "/open/v1/product/shop/shop/get_shop_list",
  productTemplates: "/open/v1/product/collect_box/pddkj_choice/collect_box/search_collect_box_detail_list",
  productTemplateDetail: "/open/v1/product/collect_box/pddkj_choice/collect_box/get_shop_collect_item_info",
  skuTemplateDetail: "/open/v1/product/collect_box/pddkj_choice/collect_box/get_site_collect_item_info"
};

exports.main = async (event, context) => {
  const rpc = event?.rpc;
  const method = (rpc?.method || event.httpMethod || event.requestContext?.http?.method || context.httpContext?.httpMethod || context.httpContext?.method || "GET").toUpperCase();
  if (method === "OPTIONS") {
    return json(200, { ok: true });
  }
  const path = rpc?.path || requestPath(event, context);

  try {
    const sdk = getApp(context);
    const db = sdk.rdb();
    const storage = sdk.storage;
    const body = rpc?.body || parseBody(event, context);

    if (method === "GET" && path === "/health") {
      return json(200, {
        ok: true,
        environment: ENV_ID,
        bucket: IMAGE_BUCKET,
        miaoshouConfigured: Boolean(process.env.MIAOSHOU_APP_ID && process.env.MIAOSHOU_APP_SECRET),
        limits: { maxImages: MAX_ITEMS, imagesPerProduct: 6, publishBatchSize: 200 }
      });
    }
    if (method === "POST" && path === "/erp/read") {
      const upstreamPath = READ_ENDPOINTS[body.resource];
      if (!upstreamPath) throw new ApiError(400, "不允许读取该 ERP 资源");
      return json(200, await miaoshouRequest(upstreamPath, body.params || {}));
    }
    if (method === "POST" && path === "/batches") {
      return json(201, await createBatch(db, body));
    }

    const statusMatch = path.match(/^\/batches\/([a-z0-9-]+)$/);
    if (method === "GET" && statusMatch) return json(200, await batchStatus(db, statusMatch[1], true));
    const signMatch = path.match(/^\/batches\/([a-z0-9-]+)\/sign$/);
    if (method === "POST" && signMatch) return json(200, { items: await signUploads(db, storage, signMatch[1], body.slots) });
    const finalizeMatch = path.match(/^\/batches\/([a-z0-9-]+)\/finalize$/);
    if (method === "POST" && finalizeMatch) return json(200, await finalizeBatch(db, finalizeMatch[1]));
    const importMatch = path.match(/^\/batches\/([a-z0-9-]+)\/import$/);
    if (method === "POST" && importMatch) return json(200, await importImages(db, storage, importMatch[1], body.slots));
    const cleanupMatch = path.match(/^\/batches\/([a-z0-9-]+)\/cleanup$/);
    if (method === "POST" && cleanupMatch) return json(200, await cleanupBatch(db, storage, cleanupMatch[1]));

    throw new ApiError(404, "接口不存在");
  } catch (error) {
    console.error(JSON.stringify({ path, message: error.message, details: error.details || null }));
    return json(error.statusCode || 500, {
      ok: false,
      message: error.statusCode ? error.message : "服务器处理失败",
      details: error.statusCode && error.details ? error.details : undefined
    });
  }
};

exports.__test = { validateBatch, requestPath };

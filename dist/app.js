const APP_CONFIG = window.TEMU_APP_CONFIG;
const UPLOAD_CONCURRENCY = 6;
const UPLOAD_ATTEMPT_TIMEOUT_MS = 60000;
const READONLY_HELPER_SOURCE = "temu-readonly-helper";
const PUBLISHER_SOURCE = "temu-publisher";
const cloudApp = window.cloudbase?.init({
  env: APP_CONFIG.envId,
  accessKey: APP_CONFIG.publishableKey
});
const imageBucket = cloudApp?.storage.from(APP_CONFIG.bucket);

let products = [];
let selected = new Set();
let imageFilesBySlot = new Map();
let publishRunning = false;
let uploadWakeLock = null;
let erpReady = false;
let readOnlyTemplateSync = null;
let activeBatchId = localStorage.getItem("temu-active-batch") || "";
let importState = emptyImportState();

function emptyImportState() {
  return {
    titleCount: 0,
    groupCount: 0,
    completeGroups: 0,
    invalidFiles: [],
    nestedFiles: [],
    missingImages: [],
    duplicateImages: [],
    imageCount: 0,
    imageInspected: false,
    errors: [],
    valid: false
  };
}

function iconRefresh() {
  if (window.lucide) window.lucide.createIcons();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

function getSelectedLabel(selector, fallback = "尚未选择") {
  const select = document.querySelector(selector);
  return select?.selectedOptions?.[0]?.textContent || fallback;
}

function getSelectedValue(selector) {
  return document.querySelector(selector)?.value || "";
}

function showToast(title, message, type = "warning") {
  const toast = document.createElement("div");
  toast.className = `toast ${type === "success" ? "" : "warning"}`;
  toast.innerHTML = `<i data-lucide="${type === "success" ? "circle-check" : "info"}"></i><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
  document.querySelector("#toastRegion").appendChild(toast);
  iconRefresh();
  window.setTimeout(() => toast.remove(), 5200);
}

function setSubmitStatus(title, message, current = null, total = null, state = "warning") {
  document.querySelector("#submitStatusTitle").textContent = title;
  document.querySelector("#submitStatusText").textContent = message;
  document.querySelector("#submitStatusDot").className = `status-dot ${state}`;
  const progress = document.querySelector("#uploadProgress");
  if (current === null || total === null) {
    progress.hidden = true;
    return;
  }
  progress.hidden = false;
  const percent = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
  document.querySelector("#uploadProgressBar").style.width = `${percent}%`;
  document.querySelector("#uploadProgressText").textContent = `${current} / ${total}`;
}

async function api(path, options = {}) {
  const response = await fetch(`${APP_CONFIG.apiBase}${path}`, {
    method: options.method || "GET",
    headers: options.body === undefined ? {} : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`云端接口返回了无法识别的内容（HTTP ${response.status}）`);
  }
  if (!response.ok || data?.ok === false) {
    const code = data?.details?.code ? `（${data.details.code}）` : "";
    throw new Error(`${data?.message || `请求失败：HTTP ${response.status}`}${code}`);
  }
  return data;
}

function renderProducts(query = "") {
  const rows = document.querySelector("#productRows");
  const normalized = query.trim().toLowerCase();
  const visible = products.filter((item) => `${item.id} ${item.title}`.toLowerCase().includes(normalized));
  const skuTemplate = escapeHtml(getSelectedLabel("#skuTemplateSelect"));
  rows.innerHTML = visible.map((item) => {
    const statusClass = item.status === "通过" ? "success" : "error";
    return `<tr>
      <td class="check-cell"><input class="product-check" type="checkbox" data-id="${item.id}" ${selected.has(item.id) ? "checked" : ""} aria-label="选择 ${item.id}" /></td>
      <td><div class="product-cell"><span class="thumb-number">${item.group}</span><span class="product-copy"><strong>${escapeHtml(item.title)}</strong><small>Excel 第 ${item.group} 个产品标题</small></span></div></td>
      <td><div class="image-sequence"><code>${item.group}.1</code><span>至</span><code>${item.group}.6</code><span>6 张</span></div></td>
      <td><div class="image-sequence"><span class="thumb-number">${item.group}.1</span><span>轮播图第一张</span></div></td>
      <td>${skuTemplate}</td>
      <td><span class="tag ${statusClass}">${item.status}</span></td>
      <td><button class="icon-btn row-action edit-product" data-id="${item.id}" title="查看匹配详情" aria-label="查看 ${item.id}"><i data-lucide="eye"></i></button></td>
    </tr>`;
  }).join("");
  bindProductRows();
  updateSelectedCount();
  iconRefresh();
}

function bindProductRows() {
  document.querySelectorAll(".product-check").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      event.target.checked ? selected.add(event.target.dataset.id) : selected.delete(event.target.dataset.id);
      updateSelectedCount();
    });
  });
  document.querySelectorAll(".edit-product").forEach((button) => {
    button.addEventListener("click", () => openProductDialog(button.dataset.id));
  });
}

function updateSelectedCount() {
  const count = document.querySelector("#selectedCount");
  if (count) count.textContent = selected.size;
  const checks = [...document.querySelectorAll(".product-check")];
  document.querySelector("#selectAll").checked = checks.length > 0 && checks.every((input) => input.checked);
}

function refreshImportValidation() {
  const errors = [];
  if (!importState.titleCount) errors.push("尚未读取 Excel 产品标题");
  if (importState.nestedFiles.length) errors.push(`文件夹内不能再有子文件夹：${importState.nestedFiles.slice(0, 4).join("、")}`);
  if (importState.invalidFiles.length) errors.push(`文件名或格式错误：${importState.invalidFiles.slice(0, 6).join("、")}`);
  if (importState.duplicateImages.length) errors.push(`编号重复：${importState.duplicateImages.slice(0, 6).join("、")}`);
  if (importState.missingImages.length) errors.push(`缺少图片：${importState.missingImages.slice(0, 8).join("、")}`);
  if (importState.imageInspected && importState.titleCount !== importState.groupCount) {
    errors.push(`数量不一致：Excel 有 ${importState.titleCount} 个标题，图片有 ${importState.groupCount} 组`);
  }
  importState.errors = errors;
  importState.valid = importState.imageInspected && errors.length === 0 && importState.imageCount === importState.titleCount * 6;

  if (importState.imageInspected) {
    const dropZone = document.querySelector("#imageDrop");
    dropZone.classList.toggle("input-success", importState.valid);
    dropZone.classList.toggle("input-error", !importState.valid);
    const output = document.querySelector("#imageFileName");
    output.textContent = importState.valid
      ? `检查通过：${importState.imageCount} 张图片 · ${importState.groupCount} 组轮播图`
      : `检查失败：${errors.join("；")}`;
    output.title = output.textContent;
  }
  const summary = document.querySelector("#matchSummary");
  if (summary) {
    const detail = importState.imageInspected
      ? `${importState.groupCount} 组轮播图。${importState.valid ? "全部编号完整。" : errors[0] || "等待检查。"}`
      : "选择图片文件夹后自动检查。";
    summary.innerHTML = `<span id="selectedCount">${selected.size}</span> 个产品：${importState.titleCount} 个 Excel 标题；${escapeHtml(detail)}`;
  }
  if (!APP_CONFIG.liveWritesEnabled) {
    setSubmitStatus("安全测试模式", "当前不会上传、导入或发布任何真实数据。", null, null, "warning");
  } else if (!publishRunning) {
    setSubmitStatus(
      importState.valid ? "本地资料检查通过" : "等待选择完整资料",
      importState.valid ? "发布前会先上传全部图片，再由云端逐张复核。" : (errors[0] || "请选择 Excel 和完整图片文件夹。"),
      null,
      null,
      importState.valid ? "success" : "warning"
    );
  }
}

function readTitlesFromRows(rows) {
  if (!rows.length) return [];
  const titleNames = ["产品标题", "商品标题", "标题", "product title", "title"];
  const headers = rows[0].map((item) => String(item ?? "").trim().toLowerCase());
  const titleIndex = headers.findIndex((header) => titleNames.includes(header));
  const columnIndex = titleIndex >= 0 ? titleIndex : 0;
  return rows.slice(1).map((row) => String(row[columnIndex] ?? "").trim()).filter(Boolean);
}

function applyTitles(titles, fileName) {
  if (!titles.length) throw new Error("表格中没有读到产品标题，请确认第一列或标题列有数据");
  products = titles.map((title, index) => ({
    id: `EXCEL-${String(index + 1).padStart(4, "0")}`,
    group: index + 1,
    title,
    status: imageFilesBySlot.has(`${index + 1}.1`) ? "通过" : "等待图片"
  }));
  selected = new Set(products.map((item) => item.id));
  importState.titleCount = products.length;
  document.querySelector("#sheetFileName").textContent = `${fileName} · ${products.length} 个标题`;
  renderProducts();
  refreshImportValidation();
  showToast("产品标题已读取", `${products.length} 个标题将依次匹配 1.1–1.6、2.1–2.6。`, "success");
}

async function handleSheetFile(file) {
  try {
    if (!window.XLSX) throw new Error("Excel 读取组件加载失败，请刷新网页后重试");
    const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
    applyTitles(readTitlesFromRows(rows), file.name);
  } catch (error) {
    document.querySelector("#sheetFileName").textContent = `读取失败：${error.message}`;
    showToast("表格读取失败", error.message, "warning");
  }
}

function inspectImageFolder(fileList) {
  const files = [...fileList];
  const groups = new Map();
  const invalidFiles = [];
  const nestedFiles = [];
  const duplicateImages = [];
  const nextFilesBySlot = new Map();

  files.forEach((file) => {
    const pathParts = (file.webkitRelativePath || file.name).split("/").filter(Boolean);
    if (pathParts.length > 2) nestedFiles.push(file.webkitRelativePath);
    const match = file.name.match(/^(\d+)\.([1-6])\.(jpe?g|png|webp)$/i);
    if (!match) {
      invalidFiles.push(file.name);
      return;
    }
    const group = Number(match[1]);
    const position = Number(match[2]);
    if (group < 1 || String(group) !== match[1]) {
      invalidFiles.push(file.name);
      return;
    }
    const slot = `${group}.${position}`;
    if (nextFilesBySlot.has(slot)) duplicateImages.push(slot);
    nextFilesBySlot.set(slot, file);
    if (!groups.has(group)) groups.set(group, new Set());
    groups.get(group).add(position);
  });

  const highestGroup = groups.size ? Math.max(...groups.keys()) : 0;
  const missingImages = [];
  let completeGroups = 0;
  for (let group = 1; group <= highestGroup; group += 1) {
    const positions = groups.get(group);
    for (let position = 1; position <= 6; position += 1) {
      if (!positions?.has(position)) missingImages.push(`${group}.${position}`);
    }
    if (positions?.size === 6) completeGroups += 1;
  }

  imageFilesBySlot = nextFilesBySlot;
  Object.assign(importState, {
    groupCount: highestGroup,
    completeGroups,
    invalidFiles,
    nestedFiles,
    missingImages,
    duplicateImages,
    imageCount: files.length,
    imageInspected: true
  });
  products.forEach((product) => {
    product.status = groups.get(product.group)?.size === 6 ? "通过" : "图片不完整";
  });
  renderProducts();
  refreshImportValidation();
  showToast(
    importState.valid ? "图片编号检查通过" : "图片编号需要修正",
    importState.valid ? `${highestGroup} 组，共 ${files.length} 张图片。` : importState.errors.join("；"),
    importState.valid ? "success" : "warning"
  );
}

async function sha256Blob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Text(value) {
  return sha256Blob(new Blob([value], { type: "text/plain" }));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return output;
}

function extensionFor(file) {
  const extension = file.name.split(".").pop().toLowerCase();
  return extension === "jpeg" ? "jpg" : extension;
}

function mimeFor(file) {
  const extension = extensionFor(file);
  return extension === "jpg" ? "image/jpeg" : `image/${extension}`;
}

async function buildManifest() {
  const slots = [...imageFilesBySlot.entries()].sort((a, b) => {
    const [ag, ap] = a[0].split(".").map(Number);
    const [bg, bp] = b[0].split(".").map(Number);
    return ag - bg || ap - bp;
  });
  let hashed = 0;
  setSubmitStatus("正在核对文件内容", "为每张图片计算 SHA-256，确保上传前后完全一致。", 0, slots.length, "warning");
  const items = await mapWithConcurrency(slots, 2, async ([slot, file]) => {
    const [productIndex, imagePosition] = slot.split(".").map(Number);
    const sha256 = await sha256Blob(file);
    hashed += 1;
    setSubmitStatus("正在核对文件内容", `已完成 ${hashed} 张图片的内容校验。`, hashed, slots.length, "warning");
    return {
      productIndex,
      imagePosition,
      originalName: file.name,
      sizeBytes: file.size,
      mimeType: mimeFor(file),
      extension: extensionFor(file),
      sha256
    };
  });
  const manifestSource = JSON.stringify({
    products: products.map((item) => item.title),
    storeId: getSelectedValue("#storeSelect"),
    productTemplateId: getSelectedValue("#productTemplateSelect"),
    skuTemplateId: getSelectedValue("#skuTemplateSelect"),
    items
  });
  return { items, manifestHash: await sha256Text(manifestSource) };
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

async function requestUploadWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible" || uploadWakeLock) return;
  try {
    uploadWakeLock = await navigator.wakeLock.request("screen");
    uploadWakeLock.addEventListener("release", () => { uploadWakeLock = null; }, { once: true });
  } catch {
    uploadWakeLock = null;
  }
}

async function releaseUploadWakeLock() {
  if (!uploadWakeLock) return;
  const lock = uploadWakeLock;
  uploadWakeLock = null;
  await lock.release().catch(() => {});
}

async function uploadOne(serverItem, manifestItem) {
  const slot = `${manifestItem.productIndex}.${manifestItem.imagePosition}`;
  const file = imageFilesBySlot.get(slot);
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const result = await withTimeout(
        imageBucket.upload(serverItem.object_key, file, {
          upsert: true,
          contentType: manifestItem.mimeType,
          metadata: {
            sha256: manifestItem.sha256,
            productIndex: String(manifestItem.productIndex),
            imagePosition: String(manifestItem.imagePosition),
            originalName: manifestItem.originalName
          }
        }),
        UPLOAD_ATTEMPT_TIMEOUT_MS,
        `${slot} 单次上传超过 60 秒`
      );
      if (result?.error) throw new Error(result.error.message || "腾讯云存储返回错误");
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await sleep(600 * (2 ** (attempt - 1)) + Math.random() * 300);
    }
  }
  throw new Error(`${slot} 上传失败：${lastError?.message || "未知错误"}`);
}

async function uploadAndVerify(batchId, manifestItems) {
  let verified = await api(`/batches/${batchId}/finalize`, { method: "POST", body: {} });
  const manifestBySlot = new Map(manifestItems.map((item) => [`${item.productIndex}.${item.imagePosition}`, item]));
  for (let round = 1; round <= 5 && !verified.complete; round += 1) {
    const status = await api(`/batches/${batchId}`);
    const pending = status.items.filter((item) => item.storage_status !== "uploaded");
    let settled = 0;
    let failures = 0;
    setSubmitStatus("正在上传全部图片", `第 ${round} 轮：仅重试尚未通过云端核验的图片。`, manifestItems.length - pending.length, manifestItems.length, "warning");
    await mapWithConcurrency(pending, UPLOAD_CONCURRENCY, async (item) => {
      const slot = `${item.product_index}.${item.image_position}`;
      try {
        await uploadOne(item, manifestBySlot.get(slot));
      } catch {
        failures += 1;
      } finally {
        settled += 1;
        const current = manifestItems.length - pending.length + settled;
        setSubmitStatus("正在上传全部图片", "可切换到其他软件；请保持浏览器和本页面开启。", current, manifestItems.length, "warning");
      }
    });
    verified = await api(`/batches/${batchId}/finalize`, { method: "POST", body: {} });
    if (!verified.complete && failures) await sleep(Math.min(30000, 3000 * round));
  }

  if (!verified.complete) {
    const status = await api(`/batches/${batchId}`);
    const pending = status.items.filter((item) => item.storage_status !== "uploaded");
    let settled = 0;
    setSubmitStatus("正在执行最终恢复", `常规重试结束，最后补传 ${pending.length} 张失败图片。`, 0, pending.length, "warning");
    await mapWithConcurrency(pending, UPLOAD_CONCURRENCY, async (item) => {
      const slot = `${item.product_index}.${item.image_position}`;
      try {
        await uploadOne(item, manifestBySlot.get(slot));
      } catch {
        // Final verification below remains authoritative; failed files are never marked complete.
      } finally {
        settled += 1;
        setSubmitStatus("正在执行最终恢复", "逐张补传并等待最终云端核验。", settled, pending.length, "warning");
      }
    });
    verified = await api(`/batches/${batchId}/finalize`, { method: "POST", body: {} });
  }
  if (!verified.complete || verified.matched_count !== verified.expected_count) {
    throw new Error(`云端核验未通过：应有 ${verified.expected_count} 张，完整匹配 ${verified.matched_count} 张`);
  }
  return verified;
}

async function importAllImages(batchId, total) {
  let status = await api(`/batches/${batchId}`);
  let pending = status.items.filter((item) => item.erp_status !== "imported");
  for (let round = 1; round <= 5 && pending.length; round += 1) {
    for (let offset = 0; offset < pending.length; offset += 24) {
      const chunk = pending.slice(offset, offset + 24).map((item) => ({
        productIndex: item.product_index,
        imagePosition: item.image_position
      }));
      const result = await api(`/batches/${batchId}/import`, { method: "POST", body: { slots: chunk } });
      setSubmitStatus("正在导入妙手图片空间", "腾讯云图片已全部验证，现在写入 ERP。", result.importedCount, total, "warning");
      const allFailed = result.items.length && result.items.every((item) => item.status === "failed");
      if (allFailed) throw new Error(result.items[0].message || "妙手图片导入失败");
    }
    status = await api(`/batches/${batchId}`);
    pending = status.items.filter((item) => item.erp_status !== "imported");
  }
  if (pending.length) throw new Error(`仍有 ${pending.length} 张图片未成功导入妙手，当前批次已保留，可再次重试`);
}

async function runPublishFlow() {
  if (publishRunning) return;
  if (!APP_CONFIG.liveWritesEnabled) return showToast("真实写入尚未启用", "当前为安全测试模式，不会上传、导入或发布真实数据。", "warning");
  if (!importState.valid) return showToast("资料检查未通过", importState.errors[0] || "请选择完整资料", "warning");
  if (selected.size !== products.length) return showToast("必须提交全部产品", "为保证文件夹不多不少，请保持全部产品选中。", "warning");
  if (!erpReady) return showToast("个人模板尚未同步", "产品模板和 SKU 模板需要通过已登录的妙手网页同步。", "warning");
  if (!["#storeSelect", "#productTemplateSelect", "#skuTemplateSelect"].every((selector) => getSelectedValue(selector))) {
    return showToast("店铺或模板未选择", "请选择目标店铺、产品模板和 SKU 模板。", "warning");
  }
  if (!imageBucket) return showToast("腾讯云组件未连接", "请刷新网页后重试。", "warning");

  publishRunning = true;
  await requestUploadWakeLock();
  const button = document.querySelector("#publishBtn");
  button.disabled = true;
  try {
    const { items, manifestHash } = await buildManifest();
    const requestedId = `batch-${crypto.randomUUID()}`;
    const batch = await api("/batches", {
      method: "POST",
      body: {
        id: requestedId,
        manifestHash,
        products: products.map((item) => ({ title: item.title })),
        items,
        storeId: getSelectedValue("#storeSelect"),
        productTemplateId: getSelectedValue("#productTemplateSelect"),
        skuTemplateId: getSelectedValue("#skuTemplateSelect")
      }
    });
    activeBatchId = batch.id;
    localStorage.setItem("temu-active-batch", activeBatchId);
    const verified = await uploadAndVerify(activeBatchId, items);
    setSubmitStatus("云端图片全部核验成功", `${verified.expected_count} 张图片不多、不少，编号和内容均一致。`, verified.expected_count, verified.expected_count, "success");
    await importAllImages(activeBatchId, items.length);
    setSubmitStatus("全部图片已上传并导入", "图片已完整进入妙手；商品发布接口需在应用权限启用后继续。", items.length, items.length, "success");
    showToast("整批图片处理完成", `${items.length} 张图片全部上传、校验并导入成功。`, "success");
  } catch (error) {
    setSubmitStatus("发布已暂停", error.message, null, null, "error");
    showToast("商品发布未完成", error.message, "warning");
  } finally {
    publishRunning = false;
    button.disabled = false;
    await releaseUploadWakeLock();
  }
}

function findRecordArray(value, depth = 0) {
  if (depth > 6 || value == null) return [];
  if (Array.isArray(value)) return value.length && value.every((item) => typeof item === "object") ? value : [];
  if (typeof value !== "object") return [];
  for (const key of ["records", "rows", "list", "items", "shopList", "detailList", "data", "result"]) {
    if (key in value) {
      const found = findRecordArray(value[key], depth + 1);
      if (found.length) return found;
    }
  }
  for (const nested of Object.values(value)) {
    const found = findRecordArray(nested, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function recordValue(record, keys) {
  for (const key of keys) if (record?.[key] !== undefined && record[key] !== null) return String(record[key]);
  return "";
}

function fillSelect(selector, records, kind) {
  const select = document.querySelector(selector);
  const previousValue = select.value;
  const idKeys = kind === "shop"
    ? ["shopId", "shop_id", "id"]
    : kind === "skuTemplate"
      ? ["skuPropTemplateId", "templateId", "id"]
      : ["itemTemplateId", "detailId", "collectBoxDetailId", "templateId", "id"];
  const nameKeys = kind === "shop"
    ? ["shopNick", "shopName", "shop_name", "name", "mallName"]
    : ["name", "templateName", "title", "productTitle", "goodsName"];
  const options = records.map((record, index) => {
    const value = recordValue(record, idKeys);
    const label = recordValue(record, nameKeys) || `${kind === "shop" ? "店铺" : "模板"} ${index + 1}`;
    return value ? `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>` : "";
  }).filter(Boolean);
  select.innerHTML = options.length ? `<option value="">请选择</option>${options.join("")}` : '<option value="">没有可用数据</option>';
  select.disabled = !options.length;
  if (previousValue && [...select.options].some((option) => option.value === previousValue)) select.value = previousValue;
  return options.length;
}

function normalizeReadOnlyTemplates(records, kind) {
  if (!Array.isArray(records)) return [];
  const idKeys = kind === "skuTemplate" ? ["id", "skuPropTemplateId"] : ["id", "itemTemplateId"];
  const output = [];
  const seen = new Set();
  for (const record of records.slice(0, 5000)) {
    const id = recordValue(record, idKeys).trim();
    const name = recordValue(record, ["name", "templateName"]).trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    output.push({ id, name });
  }
  return output;
}

function normalizeReadOnlyShops(records) {
  if (!Array.isArray(records)) return [];
  const output = [];
  const seen = new Set();
  for (const record of records.slice(0, 5000)) {
    const id = recordValue(record, ["id", "shopId"]).trim();
    const name = recordValue(record, ["name", "shopNick", "platformShopName"]).trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    output.push({ id, name });
  }
  return output;
}

function requestReadOnlyTemplateSync() {
  window.postMessage({
    source: PUBLISHER_SOURCE,
    type: "REQUEST_READONLY_TEMPLATE_DATA",
    version: 1
  }, window.location.origin);
}

function applyReadOnlyTemplateSync(payload, showResult = false) {
  if (!payload || ![1, 2].includes(payload.version)) return false;
  const shops = normalizeReadOnlyShops(payload.shops);
  const productTemplates = normalizeReadOnlyTemplates(payload.productTemplates, "productTemplate");
  const skuTemplates = normalizeReadOnlyTemplates(payload.skuTemplates, "skuTemplate");
  if (!productTemplates.length && !skuTemplates.length) return false;

  readOnlyTemplateSync = {
    version: payload.version,
    source: "erp.91miaoshou.com",
    syncedAt: String(payload.syncedAt || ""),
    shops,
    productTemplates,
    skuTemplates
  };

  const shopCount = shops.length ? fillSelect("#storeSelect", shops, "shop") : 0;
  const productCount = fillSelect("#productTemplateSelect", productTemplates, "productTemplate");
  const skuCount = fillSelect("#skuTemplateSelect", skuTemplates, "skuTemplate");
  const storeSelect = document.querySelector("#storeSelect");
  const storeReady = !storeSelect.disabled && [...storeSelect.options].some((option) => option.value);
  erpReady = storeReady && productCount > 0 && skuCount > 0;

  const sourceState = document.querySelector("#channel .section-state");
  const shopDescription = shopCount ? `${shopCount} 个店铺` : "店铺沿用开放平台数据";
  sourceState.innerHTML = erpReady
    ? '<i data-lucide="circle-check"></i>店铺与模板已同步'
    : '<i data-lucide="circle-alert"></i>模板已同步 · 店铺读取中';
  sourceState.title = `Chrome 辅助插件只读同步：${shopDescription}，${productCount} 个产品模板，${skuCount} 个 SKU 模板`;
  sourceState.classList.toggle("connected", erpReady);

  const connection = document.querySelector(".sidebar-foot .connection-line");
  connection.querySelector("strong").textContent = erpReady ? "只读数据已同步" : "模板已同步";
  connection.querySelector("span:last-child").textContent = `${shopCount ? `${shopCount} 个店铺 · ` : ""}${productCount} 个产品模板 · ${skuCount} 个 SKU 模板`;
  if (showResult) {
    showToast(
      "妙手模板已只读同步",
      `已读取 ${shopCount} 个店铺、${productCount} 个产品模板和 ${skuCount} 个 SKU 模板，没有执行任何写入。`,
      productCount && skuCount ? "success" : "warning"
    );
  }
  iconRefresh();
  return true;
}

function handleReadOnlyHelperMessage(event) {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data;
  if (message?.source !== READONLY_HELPER_SOURCE || message.type !== "READONLY_TEMPLATE_DATA") return;
  if (message.ok === false) {
    if (message.error) showToast("只读插件同步失败", message.error, "warning");
    return;
  }
  applyReadOnlyTemplateSync(message.payload, Boolean(message.fresh));
}

async function syncERP(showResult = false) {
  const sourceState = document.querySelector("#channel .section-state");
  const storeSelect = document.querySelector("#storeSelect");
  storeSelect.innerHTML = '<option value="">正在读取 ERP…</option>';
  storeSelect.disabled = true;
  if (!readOnlyTemplateSync) {
    ["#productTemplateSelect", "#skuTemplateSelect"].forEach((selector) => {
      const select = document.querySelector(selector);
      select.innerHTML = '<option value="">需要 Chrome 只读插件同步</option>';
      select.disabled = true;
    });
  }
  requestReadOnlyTemplateSync();
  try {
    await api("/health");
    const productsResponse = await api("/erp/read", {
      method: "POST",
      body: { resource: "productTemplates", params: { pageNo: 0, pageSize: 500, filter: {} } }
    });
    const collectBoxProducts = findRecordArray(productsResponse);

    let shops = [];
    let usingProductShopIds = false;
    try {
      const shopsResponse = await api("/erp/read", {
        method: "POST",
        body: { resource: "shops", params: { platform: "pddkj", site: "PDDKJ", pageNo: 1, pageSize: 100 } }
      });
      shops = findRecordArray(shopsResponse);
    } catch {
      const shopsById = new Map();
      for (const product of collectBoxProducts) {
        for (const binding of product.collectBoxDetailShopList || []) {
          const shopId = recordValue(binding, ["shopId", "shop_id", "id"]);
          if (shopId) shopsById.set(shopId, { shopId, shopNick: `店铺 ID ${shopId}` });
        }
      }
      shops = [...shopsById.values()];
      usingProductShopIds = shops.length > 0;
    }
    if (!fillSelect("#storeSelect", shops, "shop")) throw new Error("妙手接口已连接，但没有读取到已绑定店铺");

    if (readOnlyTemplateSync) {
      applyReadOnlyTemplateSync(readOnlyTemplateSync, showResult);
    } else {
      erpReady = false;
      sourceState.innerHTML = '<i data-lucide="circle-alert"></i>店铺已读取 · 模板等待插件同步';
      sourceState.title = usingProductShopIds
        ? "店铺 ID 已读取；请在已登录的妙手模板页面点击 Chrome 辅助插件进行只读同步。"
        : "请在已登录的妙手模板页面点击 Chrome 辅助插件进行只读同步。";
      sourceState.classList.remove("connected");
      document.querySelector(".sidebar-foot .connection-line strong").textContent = "云端已连接";
      document.querySelector(".sidebar-foot .connection-line span:last-child").textContent = "妙手店铺可用 · 模板等待只读同步";
      if (showResult) {
        showToast(
          "妙手店铺已读取",
          `已读取 ${shops.length} 个店铺${usingProductShopIds ? " ID" : ""}；产品模板和 SKU 模板等待 Chrome 插件同步。`,
          "warning"
        );
      }
    }
  } catch (error) {
    erpReady = false;
    storeSelect.innerHTML = '<option value="">妙手店铺不可用</option>';
    storeSelect.disabled = true;
    sourceState.innerHTML = '<i data-lucide="circle-alert"></i>ERP 连接失败';
    sourceState.title = error.message;
    sourceState.classList.remove("connected");
    document.querySelector(".sidebar-foot .connection-line strong").textContent = "腾讯云已连接";
    document.querySelector(".sidebar-foot .connection-line span:last-child").textContent = `妙手：${error.message}`;
    if (readOnlyTemplateSync) applyReadOnlyTemplateSync(readOnlyTemplateSync, false);
    if (showResult) showToast("妙手连接失败", error.message, "warning");
  }
  iconRefresh();
}

window.addEventListener("message", handleReadOnlyHelperMessage);

function openDialog(title, subtitle, body) {
  document.querySelector("#dialogTitle").textContent = title;
  document.querySelector("#dialogSubtitle").textContent = subtitle;
  document.querySelector("#dialogBody").innerHTML = body;
  const backdrop = document.querySelector("#dialogBackdrop");
  backdrop.classList.add("open");
  backdrop.setAttribute("aria-hidden", "false");
}

function closeDialog() {
  const backdrop = document.querySelector("#dialogBackdrop");
  backdrop.classList.remove("open");
  backdrop.setAttribute("aria-hidden", "true");
}

function openProductDialog(id) {
  const product = products.find((item) => item.id === id);
  if (!product) return;
  openDialog("匹配详情", `${product.id} · Excel 标题与图片组`, `<div class="dialog-form">
    <div class="field span-2"><label>产品标题</label><input value="${escapeHtml(product.title)}" disabled /></div>
    <div class="field"><label>轮播图片</label><input value="${product.group}.1 至 ${product.group}.6" disabled /></div>
    <div class="field"><label>预览图</label><input value="${product.group}.1" disabled /></div>
    <div class="field span-2"><label>SKU 模板</label><input value="${escapeHtml(getSelectedLabel("#skuTemplateSelect"))}" disabled /></div>
  </div>`);
}

function closeSidebar() {
  document.querySelector("#sidebar").classList.remove("open");
  document.querySelector("#mobileBackdrop").classList.remove("show");
}

function initEvents() {
  document.addEventListener("visibilitychange", () => {
    if (publishRunning && document.visibilityState === "visible") requestUploadWakeLock();
  });
  window.addEventListener("beforeunload", (event) => {
    if (!publishRunning) return;
    event.preventDefault();
    event.returnValue = "";
  });
  document.querySelector("#menuBtn").addEventListener("click", () => {
    document.querySelector("#sidebar").classList.add("open");
    document.querySelector("#mobileBackdrop").classList.add("show");
  });
  document.querySelector("#sidebarClose").addEventListener("click", closeSidebar);
  document.querySelector("#mobileBackdrop").addEventListener("click", closeSidebar);
  document.querySelectorAll(".step").forEach((step) => step.addEventListener("click", () => {
    document.querySelectorAll(".step").forEach((item) => item.classList.remove("active"));
    step.classList.add("active");
    document.querySelector(`#${step.dataset.stepTarget}`).scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  document.querySelector("#sheetInput").addEventListener("change", (event) => event.target.files[0] && handleSheetFile(event.target.files[0]));
  document.querySelector("#imageInput").addEventListener("change", (event) => event.target.files.length && inspectImageFolder(event.target.files));
  document.querySelector("#selectAll").addEventListener("change", (event) => {
    document.querySelectorAll(".product-check").forEach((input) => {
      input.checked = event.target.checked;
      event.target.checked ? selected.add(input.dataset.id) : selected.delete(input.dataset.id);
    });
    updateSelectedCount();
  });
  document.querySelector("#productSearch").addEventListener("input", (event) => renderProducts(event.target.value));
  document.querySelector("#publishBtn").addEventListener("click", runPublishFlow);
  document.querySelector("#refreshERP").addEventListener("click", () => syncERP(true));
  document.querySelector("#skuTemplateSelect").addEventListener("change", () => renderProducts(document.querySelector("#productSearch").value));
  document.querySelector("#filterBtn").addEventListener("click", () => showToast("当前显示全部商品", "可使用搜索框按标题或序号查找。", "success"));
  document.querySelector("#dialogClose").addEventListener("click", closeDialog);
  document.querySelector("#dialogCancel").addEventListener("click", closeDialog);
  document.querySelector("#dialogConfirm").addEventListener("click", closeDialog);
  document.querySelector("#dialogBackdrop").addEventListener("click", (event) => event.target.id === "dialogBackdrop" && closeDialog());
  document.addEventListener("keydown", (event) => event.key === "Escape" && closeDialog());
}

document.addEventListener("DOMContentLoaded", () => {
  if (!APP_CONFIG.liveWritesEnabled) {
    const button = document.querySelector("#publishBtn");
    button.disabled = true;
    button.title = "安全测试模式：妙手审核通过并经确认后启用";
  }
  renderProducts();
  initEvents();
  refreshImportValidation();
  syncERP(false);
  iconRefresh();
});

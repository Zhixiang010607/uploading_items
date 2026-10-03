let products = [
  { id: "EXCEL-001", group: 1, title: "复古旅行城市纪念冰箱贴装饰", status: "通过" },
  { id: "EXCEL-002", group: 2, title: "可爱动物立体树脂冰箱贴礼物", status: "通过" },
  { id: "EXCEL-003", group: 3, title: "海滨风景手绘纪念磁贴家居装饰", status: "通过" },
  { id: "EXCEL-004", group: 4, title: "世界地标系列立体冰箱贴收藏", status: "通过" },
  { id: "EXCEL-005", group: 5, title: "节日礼物磁性留言贴厨房装饰", status: "通过" }
];

const drafts = [
  { title: "秋季新品 · 冰箱贴 24 款", meta: "36 个商品 · 北美店铺", issue: "4 个商品缺少图片", tag: "待补图片" },
  { title: "城市旅行纪念系列", meta: "18 个商品 · 欧洲店铺", issue: "3 个类目属性待填写", tag: "待补属性" },
  { title: "万圣节主题磁贴", meta: "42 个商品 · 北美店铺", issue: "检查已通过，可创建任务", tag: "可以发布" }
];

const tasks = [
  { id: "TASK-20261003-003", name: "冰箱贴 · 北美店铺", count: 60, status: "发布中", progress: 68, time: "今天 14:26", detail: "已完成 41 / 60" },
  { id: "TASK-20261003-002", name: "城市纪念系列 · 欧洲店铺", count: 84, status: "部分失败", progress: 87, time: "今天 11:08", detail: "成功 73 · 失败 11" },
  { id: "TASK-20261003-001", name: "动物系列 · 北美店铺", count: 42, status: "已完成", progress: 100, time: "今天 09:15", detail: "成功 42 / 42" }
];

const pageMeta = {
  publish: ["发布商品", "整理本地商品资料并创建发布任务"],
  drafts: ["商品草稿", "继续处理未完成的商品资料"],
  tasks: ["发布任务", "查看批次进度和失败原因"],
  templates: ["模板中心", "统一商品、SKU 和图片处理规则"],
  settings: ["接入设置", "配置图片存储与发布平台"]
};

let selected = new Set(products.map((item) => item.id));
let importState = {
  titleCount: products.length,
  groupCount: products.length,
  completeGroups: products.length,
  invalidFiles: [],
  missingImages: [],
  duplicateImages: [],
  imageCount: products.length * 6,
  imageInspected: false,
  errors: [],
  valid: true
};

function iconRefresh() {
  if (window.lucide) window.lucide.createIcons();
}

function renderProducts(query = "") {
  const rows = document.querySelector("#productRows");
  const normalized = query.trim().toLowerCase();
  const visible = products.filter((item) => `${item.id} ${item.title}`.toLowerCase().includes(normalized));
  const skuTemplate = getSelectedLabel("#skuTemplateSelect", "冰箱贴单规格 SKU 模板");
  rows.innerHTML = visible.map((item) => {
    const statusClass = item.status === "通过" ? "success" : "error";
    return `
      <tr>
        <td class="check-cell"><input class="product-check" type="checkbox" data-id="${item.id}" ${selected.has(item.id) ? "checked" : ""} aria-label="选择 ${item.id}" /></td>
        <td><div class="product-cell"><span class="thumb-number">${item.group}</span><span class="product-copy"><strong>${item.title}</strong><small>Excel 第 ${item.group} 个产品标题</small></span></div></td>
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
  document.querySelector("#selectedCount").textContent = selected.size;
  const checks = [...document.querySelectorAll(".product-check")];
  document.querySelector("#selectAll").checked = checks.length > 0 && checks.every((input) => input.checked);
}

function getSelectedLabel(selector, fallback = "") {
  const select = document.querySelector(selector);
  return select?.selectedOptions?.[0]?.textContent || fallback;
}

function updateMatchSummary() {
  const summary = document.querySelector("#matchSummary");
  if (!importState.imageInspected) {
    summary.innerHTML = `<span id="selectedCount">${selected.size}</span> 个产品：${importState.titleCount} 个 Excel 标题；选择图片文件夹后自动检查。`;
    return;
  }
  const statusText = importState.valid
    ? "数量一致，每组均为 6 张，预览图取每组第一张。"
    : importState.errors[0];
  summary.innerHTML = `<span id="selectedCount">${selected.size}</span> 个产品：${importState.titleCount} 个 Excel 标题，${importState.groupCount} 组轮播图。${statusText}`;
}

function refreshImportValidation() {
  const errors = [];
  if (importState.invalidFiles.length) errors.push(`命名错误：${importState.invalidFiles.slice(0, 6).join("、")}`);
  if (importState.duplicateImages.length) errors.push(`编号重复：${importState.duplicateImages.slice(0, 6).join("、")}`);
  if (importState.missingImages.length) errors.push(`缺少图片：${importState.missingImages.slice(0, 8).join("、")}`);
  if (importState.imageInspected && importState.titleCount !== importState.groupCount) {
    errors.push(`数量不一致：Excel 有 ${importState.titleCount} 个标题，图片有 ${importState.groupCount} 组`);
  }
  importState.errors = errors;
  importState.valid = importState.imageInspected ? errors.length === 0 : true;

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
  updateMatchSummary();
}

function renderDrafts() {
  document.querySelector("#draftList").innerHTML = drafts.map((draft) => `
    <div class="list-row">
      <div><h3>${draft.title}</h3><p>${draft.meta}</p></div>
      <div><small>${draft.issue}</small></div>
      <div><span class="tag ${draft.tag === "可以发布" ? "success" : "pending"}">${draft.tag}</span></div>
      <button class="btn secondary draft-open">继续编辑</button>
    </div>`).join("");
  document.querySelectorAll(".draft-open").forEach((button) => button.addEventListener("click", () => {
    switchView("publish");
    showToast("已打开草稿", "演示数据已载入商品检查列表。", "success");
  }));
}

function renderTasks() {
  document.querySelector("#taskList").innerHTML = tasks.map((task) => {
    const tagClass = task.status === "已完成" ? "success" : task.status === "部分失败" ? "error" : "info";
    return `
      <div class="list-row task-row">
        <div><h3>${task.name}</h3><p>${task.id} · ${task.count} 个商品</p></div>
        <div><div class="progress-track"><span style="width:${task.progress}%"></span></div><small>${task.detail}</small></div>
        <div class="task-meta"><span><i data-lucide="clock-3"></i>${task.time}</span><span class="tag ${tagClass}">${task.status}</span></div>
        <div class="task-actions">${task.status === "部分失败" ? '<button class="btn secondary retry-task"><i data-lucide="rotate-ccw"></i>重试失败项</button>' : '<button class="icon-btn row-action" title="查看详情"><i data-lucide="eye"></i></button>'}</div>
      </div>`;
  }).join("");
  document.querySelectorAll(".retry-task").forEach((button) => button.addEventListener("click", () => {
    showToast("已加入重试队列", "演示模式：11 个失败商品已创建本地重试记录。", "success");
  }));
  iconRefresh();
}

function switchView(viewName) {
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  document.querySelector(`#view-${viewName}`).classList.add("active");
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === viewName));
  document.querySelector("#pageTitle").textContent = pageMeta[viewName][0];
  document.querySelector("#pageSubtitle").textContent = pageMeta[viewName][1];
  closeSidebar();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showToast(title, message, type = "warning") {
  const toast = document.createElement("div");
  toast.className = `toast ${type === "success" ? "" : "warning"}`;
  toast.innerHTML = `<i data-lucide="${type === "success" ? "circle-check" : "info"}"></i><div><strong>${title}</strong><span>${message}</span></div>`;
  document.querySelector("#toastRegion").appendChild(toast);
  iconRefresh();
  window.setTimeout(() => toast.remove(), 4200);
}

function openDialog(title, subtitle, body, onConfirm = null) {
  document.querySelector("#dialogTitle").textContent = title;
  document.querySelector("#dialogSubtitle").textContent = subtitle;
  document.querySelector("#dialogBody").innerHTML = body;
  const backdrop = document.querySelector("#dialogBackdrop");
  backdrop.classList.add("open");
  backdrop.setAttribute("aria-hidden", "false");
  document.querySelector("#dialogConfirm").onclick = () => {
    if (onConfirm) onConfirm();
    closeDialog();
  };
  iconRefresh();
}

function closeDialog() {
  const backdrop = document.querySelector("#dialogBackdrop");
  backdrop.classList.remove("open");
  backdrop.setAttribute("aria-hidden", "true");
}

function openProductDialog(id) {
  const product = products.find((item) => item.id === id);
  openDialog("匹配详情", `${product.id} · Excel 标题与图片组`, `
    <div class="dialog-form">
      <div class="field span-2"><label>产品标题（来自 Excel）</label><input value="${product.title}" disabled /></div>
      <div class="field"><label>轮播图片</label><input value="${product.group}.1 至 ${product.group}.6（共 6 张）" disabled /></div>
      <div class="field"><label>预览图</label><input value="${product.group}.1" disabled /></div>
      <div class="field span-2"><label>SKU 模板（来自 ERP）</label><input value="${getSelectedLabel("#skuTemplateSelect")}" disabled /></div>
    </div>`);
}

function closeSidebar() {
  document.querySelector("#sidebar").classList.remove("open");
  document.querySelector("#mobileBackdrop").classList.remove("show");
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"' && quoted) {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

async function handleSheetFile(file) {
  document.querySelector("#sheetFileName").textContent = file.name;
  if (!file.name.toLowerCase().endsWith(".csv")) {
    showToast("Excel 已选择", "正式后端接入后会读取产品标题并与轮播图组数核对。", "success");
    return;
  }

  const lines = (await file.text()).split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return showToast("CSV 没有产品数据", "请确认第一行为表头，后续每行包含一个产品标题。", "warning");
  const headers = parseCsvLine(lines[0]).map((item) => item.toLowerCase());
  const titleNames = ["产品标题", "商品标题", "标题", "product title", "title"];
  const titleIndex = headers.findIndex((header) => titleNames.includes(header));
  const columnIndex = titleIndex >= 0 ? titleIndex : 0;
  const titles = lines.slice(1).map((line) => parseCsvLine(line)[columnIndex]).filter(Boolean);
  products = titles.map((title, index) => ({ id: `EXCEL-${String(index + 1).padStart(3, "0")}`, group: index + 1, title, status: "通过" }));
  selected = new Set(products.map((item) => item.id));
  importState.titleCount = products.length;
  renderProducts();
  refreshImportValidation();
  showToast("产品标题已读取", `从 CSV 读取 ${products.length} 个标题，将依次匹配 1.1–1.6、2.1–2.6。`, "success");
}

function inspectImageFolder(files) {
  const groups = new Map();
  const invalidFiles = [];
  const duplicateImages = [];
  [...files].forEach((file) => {
    const dotIndex = file.name.lastIndexOf(".");
    const baseName = dotIndex > 0 ? file.name.slice(0, dotIndex) : file.name;
    const match = baseName.match(/^(\d+)\.([1-6])$/);
    if (!match) {
      invalidFiles.push(file.name);
      return;
    }
    const group = Number(match[1]);
    const position = Number(match[2]);
    if (!groups.has(group)) groups.set(group, new Set());
    if (groups.get(group).has(position)) duplicateImages.push(`${group}.${position}`);
    groups.get(group).add(position);
  });

  const highestGroup = groups.size ? Math.max(...groups.keys()) : 0;
  let completeGroups = 0;
  const missingImages = [];
  for (let group = 1; group <= highestGroup; group += 1) {
    const positions = groups.get(group);
    for (let position = 1; position <= 6; position += 1) {
      if (!positions?.has(position)) missingImages.push(`${group}.${position}`);
    }
    if (positions?.size === 6) completeGroups += 1;
  }
  importState.groupCount = highestGroup;
  importState.completeGroups = completeGroups;
  importState.invalidFiles = invalidFiles;
  importState.missingImages = missingImages;
  importState.duplicateImages = duplicateImages;
  importState.imageCount = files.length;
  importState.imageInspected = true;
  products.forEach((product) => {
    const positions = groups.get(product.group);
    product.status = positions?.size === 6 ? "通过" : "图片不完整";
  });
  renderProducts();
  refreshImportValidation();
  showToast(
    importState.valid ? "图片编号检查通过" : "图片编号需要修正",
    importState.valid
      ? `${highestGroup} 组轮播图，每组 6 张；每组第一张设为预览图。`
      : importState.errors.join("；"),
    importState.valid ? "success" : "warning"
  );
}

function initEvents() {
  document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => switchView(item.dataset.view)));
  document.querySelectorAll("[data-view-link]").forEach((item) => item.addEventListener("click", () => switchView(item.dataset.viewLink)));
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

  document.querySelector("#sheetInput").addEventListener("change", (event) => {
    if (event.target.files[0]) handleSheetFile(event.target.files[0]);
  });
  document.querySelector("#imageInput").addEventListener("change", (event) => {
    if (event.target.files.length) inspectImageFolder(event.target.files);
  });

  document.querySelector("#selectAll").addEventListener("change", (event) => {
    document.querySelectorAll(".product-check").forEach((input) => {
      input.checked = event.target.checked;
      event.target.checked ? selected.add(input.dataset.id) : selected.delete(input.dataset.id);
    });
    updateSelectedCount();
  });
  document.querySelector("#productSearch").addEventListener("input", (event) => renderProducts(event.target.value));
  document.querySelector("#saveDraftBtn").addEventListener("click", () => showToast("草稿已保存", "当前资料已保存在本地演示环境。", "success"));
  document.querySelector("#publishBtn").addEventListener("click", () => {
    if (!selected.size) return showToast("请选择商品", "至少选择一个商品后才能创建任务。", "warning");
    if (!importState.valid) return showToast("图片与标题尚未完全匹配", "请确保每个 Excel 标题都有一组 N.1 至 N.6 的六张轮播图。", "warning");
    const storeName = getSelectedLabel("#storeSelect");
    const productTemplate = getSelectedLabel("#productTemplateSelect");
    const skuTemplate = getSelectedLabel("#skuTemplateSelect");
    tasks.unshift({ id: `TASK-DEMO-${String(tasks.length + 1).padStart(3, "0")}`, name: `${storeName} · ${productTemplate} · ${skuTemplate}`, count: selected.size, status: "发布中", progress: 12, time: "刚刚", detail: `已完成 0 / ${selected.size}` });
    renderTasks();
    document.querySelector("#todayTaskCount").textContent = tasks.length;
    document.querySelector("#taskBadge").textContent = tasks.length;
    showToast("演示任务已创建", "没有请求真实接口，可在“发布任务”中查看本地记录。", "success");
  });

  ["#storeSelect", "#productTemplateSelect"].forEach((selector) => {
    document.querySelector(selector).addEventListener("change", () => showToast("ERP 选项已更新", `${getSelectedLabel(selector)} 已选中。`, "success"));
  });
  document.querySelector("#skuTemplateSelect").addEventListener("change", () => {
    renderProducts(document.querySelector("#productSearch").value);
    showToast("SKU 模板已更新", `${getSelectedLabel("#skuTemplateSelect")} 已应用到全部产品。`, "success");
  });
  document.querySelector("#filterBtn").addEventListener("click", () => showToast("筛选条件", "当前显示全部商品，可使用搜索框快速定位。", "warning"));
  document.querySelector("#refreshTasks").addEventListener("click", () => showToast("状态已刷新", "当前展示本地演示任务。", "success"));
  document.querySelector("#newTemplateBtn").addEventListener("click", () => showToast("模板编辑器待接入", "下一阶段可以加入完整模板创建与复制功能。", "warning"));
  document.querySelectorAll(".placeholder-action").forEach((button) => button.addEventListener("click", () => {
    const names = { cos: "腾讯云 COS", miaoshou: "妙手开放平台", temu: "TEMU 官方开放平台" };
    showToast(`${names[button.dataset.action]}尚未接入`, "需要后端服务保存密钥、签名请求并处理授权回调。", "warning");
  }));
  document.querySelector("#dialogClose").addEventListener("click", closeDialog);
  document.querySelector("#dialogCancel").addEventListener("click", closeDialog);
  document.querySelector("#dialogBackdrop").addEventListener("click", (event) => { if (event.target.id === "dialogBackdrop") closeDialog(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDialog(); });
}

document.addEventListener("DOMContentLoaded", () => {
  renderProducts();
  renderDrafts();
  renderTasks();
  initEvents();
  iconRefresh();
});

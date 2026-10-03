const crypto = require("node:crypto");
const { chromium } = require("playwright");

const pageUrl = process.env.STRESS_PAGE_URL || "http://127.0.0.1:4317";
const imageCount = Number(process.env.STRESS_IMAGE_COUNT || 1998);
const imageBytes = Number(process.env.STRESS_IMAGE_BYTES || 131072);
const concurrency = Number(process.env.STRESS_CONCURRENCY || 4);
const skipCount = Number(process.env.STRESS_SKIP_COUNT || 12);

if (!Number.isInteger(imageCount) || imageCount < 6 || imageCount % 6 !== 0) {
  throw new Error("STRESS_IMAGE_COUNT must be a positive multiple of 6");
}
if (!Number.isInteger(imageBytes) || imageBytes < 1024) {
  throw new Error("STRESS_IMAGE_BYTES must be at least 1024");
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
  throw new Error("STRESS_CONCURRENCY must be between 1 and 32");
}

const batchId = `stress-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
const startedAt = Date.now();

function printProgress(update) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const amount = update.total ? ` ${update.current}/${update.total}` : "";
  process.stdout.write(`[${elapsed}s] ${update.phase}${amount}${update.note ? ` - ${update.note}` : ""}\n`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(30 * 60 * 1000);
  await page.exposeFunction("reportStressProgress", printProgress);

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.cloudbase && window.TEMU_APP_CONFIG, null, { timeout: 60000 });

    const result = await page.evaluate(async ({ batchId, imageCount, imageBytes, concurrency, skipCount }) => {
      const config = window.TEMU_APP_CONFIG;
      const app = window.cloudbase.init({ env: config.envId, accessKey: config.publishableKey });
      const bucket = app.storage.from(config.bucket);
      const encoder = new TextEncoder();
      const pngHeader = Uint8Array.from(
        atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
        (char) => char.charCodeAt(0)
      );

      function slotFor(index) {
        return {
          productIndex: Math.floor(index / 6) + 1,
          imagePosition: (index % 6) + 1
        };
      }

      function makeBytes(index) {
        const bytes = new Uint8Array(imageBytes);
        bytes.set(pngHeader, 0);
        const marker = encoder.encode(`${batchId}:${index}`);
        bytes.set(marker, pngHeader.length);
        const view = new DataView(bytes.buffer);
        view.setUint32(imageBytes - 8, index, false);
        view.setUint32(imageBytes - 4, imageCount - index, false);
        return bytes;
      }

      async function sha256Hex(bytes) {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      }

      async function mapConcurrent(values, limit, worker, onProgress) {
        let cursor = 0;
        let completed = 0;
        const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
          while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= values.length) return;
            await worker(values[index], index);
            completed += 1;
            if (completed === values.length || completed % 50 === 0) onProgress(completed);
          }
        });
        await Promise.all(runners);
      }

      async function api(path, options = {}) {
        const response = await fetch(`${config.apiBase}${path}`, {
          method: options.method || "GET",
          headers: options.body === undefined ? {} : { "content-type": "application/json" },
          body: options.body === undefined ? undefined : JSON.stringify(options.body)
        });
        const data = await response.json();
        if (!response.ok || data?.ok === false) {
          throw new Error(`${options.method || "GET"} ${path}: ${data?.message || response.status}`);
        }
        return data;
      }

      await window.reportStressProgress({ phase: "hash", current: 0, total: imageCount });
      const items = new Array(imageCount);
      const indexes = Array.from({ length: imageCount }, (_, index) => index);
      await mapConcurrent(indexes, 8, async (index) => {
        const slot = slotFor(index);
        const sha256 = await sha256Hex(makeBytes(index));
        items[index] = {
          ...slot,
          originalName: `${slot.productIndex}.${slot.imagePosition}.png`,
          sizeBytes: imageBytes,
          mimeType: "image/png",
          extension: "png",
          sha256,
          objectKey: `batches/${batchId}/${slot.productIndex}.${slot.imagePosition}-${sha256.slice(0, 16)}.png`
        };
      }, (current) => window.reportStressProgress({ phase: "hash", current, total: imageCount }));

      const products = Array.from({ length: imageCount / 6 }, (_, index) => ({ title: `Stress product ${index + 1}` }));
      const manifestHash = await sha256Hex(encoder.encode(JSON.stringify({ batchId, products, items })));
      const batch = await api("/batches", {
        method: "POST",
        body: {
          id: batchId,
          manifestHash,
          products,
          items,
          storeId: "stress-test-only",
          productTemplateId: "stress-test-only",
          skuTemplateId: "stress-test-only"
        }
      });
      await window.reportStressProgress({ phase: "batch-created", note: `${batch.id}; ${imageCount} manifest rows` });

      const skippedIndexes = new Set();
      const actualSkipCount = Math.min(Math.max(skipCount, 0), imageCount - 1);
      for (let step = 1; step <= actualSkipCount; step += 1) {
        skippedIndexes.add(Math.floor((step * imageCount) / (actualSkipCount + 1)));
      }

      async function uploadItem(item, index) {
        let lastError;
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          try {
            const blob = new Blob([makeBytes(index)], { type: item.mimeType });
            const upload = await bucket.upload(item.objectKey, blob, {
              upsert: true,
              contentType: item.mimeType,
              metadata: {
                sha256: item.sha256,
                productIndex: String(item.productIndex),
                imagePosition: String(item.imagePosition),
                originalName: item.originalName,
                stressTest: "true"
              }
            });
            if (upload?.error) throw new Error(upload.error.message || "storage upload failed");
            return;
          } catch (error) {
            lastError = error;
            if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 600 * (2 ** (attempt - 1))));
          }
        }
        throw new Error(`${item.productIndex}.${item.imagePosition} failed after retries: ${lastError?.message}`);
      }

      const firstPass = items.map((item, index) => ({ item, index })).filter(({ index }) => !skippedIndexes.has(index));
      await window.reportStressProgress({ phase: "upload-pass-1", current: 0, total: firstPass.length, note: `${skippedIndexes.size} intentionally deferred` });
      await mapConcurrent(firstPass, concurrency, ({ item, index }) => uploadItem(item, index), (current) => {
        window.reportStressProgress({ phase: "upload-pass-1", current, total: firstPass.length });
      });

      const firstFinalize = await api(`/batches/${batchId}/finalize`, { method: "POST", body: {} });
      if (firstFinalize.complete || firstFinalize.failed_count !== skippedIndexes.size) {
        throw new Error(`first verification mismatch: ${JSON.stringify(firstFinalize)}`);
      }
      await window.reportStressProgress({ phase: "verify-incomplete", note: `${firstFinalize.failed_count} deferred files correctly detected` });

      const status = await api(`/batches/${batchId}`);
      if (status.items.length !== imageCount) {
        throw new Error(`status returned ${status.items.length}/${imageCount} manifest rows`);
      }
      const pending = status.items.filter((item) => item.storage_status !== "uploaded");
      if (pending.length !== skippedIndexes.size) {
        throw new Error(`resume scan found ${pending.length}/${skippedIndexes.size} pending files`);
      }
      const indexBySlot = new Map(items.map((item, index) => [`${item.productIndex}.${item.imagePosition}`, index]));
      await window.reportStressProgress({ phase: "upload-resume", current: 0, total: pending.length });
      await mapConcurrent(pending, concurrency, async (serverItem) => {
        const slot = `${serverItem.product_index}.${serverItem.image_position}`;
        const index = indexBySlot.get(slot);
        await uploadItem(items[index], index);
      }, (current) => window.reportStressProgress({ phase: "upload-resume", current, total: pending.length }));

      const final = await api(`/batches/${batchId}/finalize`, { method: "POST", body: {} });
      if (!final.complete || final.expected_count !== imageCount || final.matched_count !== imageCount || final.failed_count !== 0) {
        throw new Error(`final verification mismatch: ${JSON.stringify(final)}`);
      }
      const finalStatus = await api(`/batches/${batchId}`);
      const incorrect = finalStatus.items.filter((item) => item.storage_status !== "uploaded");
      if (finalStatus.items.length !== imageCount || incorrect.length) {
        throw new Error(`final status mismatch: rows=${finalStatus.items.length}, incorrect=${incorrect.length}`);
      }

      await window.reportStressProgress({ phase: "verified", current: imageCount, total: imageCount, note: "all files matched by slot, size, and SHA-256" });
      return {
        batchId,
        productCount: products.length,
        imageCount,
        imageBytes,
        totalBytes: imageCount * imageBytes,
        concurrency,
        deferredAndRetried: pending.length,
        final
      };
    }, { batchId, imageCount, imageBytes, concurrency, skipCount });

    process.stdout.write(`${JSON.stringify({ ok: true, elapsedSeconds: (Date.now() - startedAt) / 1000, ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, batchId, elapsedSeconds: (Date.now() - startedAt) / 1000, message: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();

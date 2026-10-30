"use strict";

// Offscreen OCR host. Content scripts cannot reliably spawn Tesseract's worker
// because the host page's CSP applies there; an extension-owned offscreen page
// runs under the extension CSP and can load the bundled worker/core/lang files.

const OCR_WORKER_OPTIONS = Object.freeze({
    workerPath: chrome.runtime.getURL("dist/vendor/tesseract/worker.min.js"),
    corePath: chrome.runtime.getURL("dist/vendor/tesseract/tesseract-core-lstm.wasm.js"),
    langPath: chrome.runtime.getURL("dist/vendor/tesseract/lang"),
    workerBlobURL: false,
    cacheMethod: "none",
    gzip: true,
    logger: () => {}
});

// Below this Tesseract confidence the result is flagged for review. The
// engine itself has no "make it 90" switch, so we improve the pixels first.
const OCR_GOOD_CONFIDENCE = 80;
const OCR_MAX_SCALE = 2;
const OCR_MAX_DIM = 2800;
const OCR_CLIP_PERCENT = 0.02;

let workerPromise = null;
let queue = Promise.resolve();

function getWorker() {
    if (!workerPromise) {
        if (typeof Tesseract === "undefined" || typeof Tesseract.createWorker !== "function") {
            return Promise.reject(new Error("Tesseract did not load in the OCR offscreen document."));
        }
        workerPromise = Tesseract.createWorker("eng", 1, {
            ...OCR_WORKER_OPTIONS,
            errorHandler: (error) => console.error("[IKO OCR]", error)
        }).then(async (worker) => {
            // Explicit PSM 3 keeps large headings that the default auto mode
            // can drop when they sit above the main text block.
            await worker.setParameters({ tessedit_pageseg_mode: "3" });
            return worker;
        }).catch((error) => {
            workerPromise = null;
            throw error;
        });
    }
    return workerPromise;
}

function isUsableText(text) {
    return String(text || "").replace(/[^A-Za-z0-9]/g, "").length >= 3;
}

function decodeImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Could not decode the image for OCR."));
        img.src = src;
    });
}

// Upscale small captures, convert to grayscale, then stretch the 2nd–98th
// percentile of luminance back to 0–255. This is the single biggest win for
// downscaled screenshots and soft phone photos.
function buildCanvas(img, filter) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, img.naturalWidth || 1);
    canvas.height = Math.max(1, img.naturalHeight || 1);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not create an OCR canvas.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.filter = filter;
    ctx.drawImage(img, 0, 0);
    ctx.filter = "none";
    return canvas;
}

function preprocessImage(img) {
    const naturalW = Math.max(1, img.naturalWidth || 1);
    const naturalH = Math.max(1, img.naturalHeight || 1);
    const scale = Math.min(OCR_MAX_SCALE, OCR_MAX_DIM / Math.max(naturalW, naturalH));
    const width = Math.max(1, Math.round(naturalW * scale));
    const height = Math.max(1, Math.round(naturalH * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not create an OCR canvas.");

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.filter = "grayscale(1)";
    ctx.drawImage(img, 0, 0, width, height);
    ctx.filter = "none";

    const imageData = ctx.getImageData(0, 0, width, height);
    const d = imageData.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
        const v = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
        d[i] = d[i + 1] = d[i + 2] = v;
        hist[v] += 1;
    }

    const total = d.length / 4;
    let lo = 0;
    let hi = 255;
    let acc = 0;
    for (let v = 0; v < 256; v += 1) {
        acc += hist[v];
        if (acc >= total * OCR_CLIP_PERCENT) { lo = v; break; }
    }
    acc = 0;
    for (let v = 255; v >= 0; v -= 1) {
        acc += hist[v];
        if (acc >= total * OCR_CLIP_PERCENT) { hi = v; break; }
    }
    if (hi <= lo) { lo = 0; hi = 255; }

    const stretch = 255 / (hi - lo);
    for (let i = 0; i < d.length; i += 4) {
        const v = Math.max(0, Math.min(255, Math.round((d[i] - lo) * stretch)));
        d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);

    return { canvas, scale };
}

async function runPass(worker, input, psm, pass) {
    await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
    const result = await worker.recognize(input, {}, { text: true });
    const data = result?.data || result || {};
    return {
        pass,
        text: String(data.text || ""),
        confidence: Number(data.confidence || 0)
    };
}

// Rasterize an image element onto a canvas so every OCR pass sees identical,
// canonically-decoded pixels. Raw data-URL inputs go through a different decode
// path in Tesseract.js that scores measurably lower confidence on degraded
// scans, so all candidates are compared on the same raster.
async function rasterize(img, scale = 1, filter = "none") {
    const width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    const height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not create an OCR canvas.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.filter = filter;
    ctx.drawImage(img, 0, 0, width, height);
    ctx.filter = "none";
    return canvas;
}

// Prefer a usable result over an unusable one; otherwise keep the highest
// confidence. Preprocessing can raise confidence while losing whole lines, so
// we only accept it when it actually wins on both usability and confidence.
function pickBest(candidates) {
    let best = null;
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (!best) { best = candidate; continue; }
        const bestUsable = isUsableText(best.text);
        const candidateUsable = isUsableText(candidate.text);
        if (candidateUsable && !bestUsable) { best = candidate; continue; }
        if (candidateUsable === bestUsable && candidate.confidence > best.confidence) {
            best = candidate;
        }
    }
    return best;
}

async function recognize(image) {
    if (!image || typeof image !== "string") throw new Error("No image supplied to OCR.");
    const worker = await getWorker();
    const passes = [];

    // Raw pass: rasterized through a canvas so the candidate set below always
    // compares canonically-decoded pixels.
    const img = await decodeImage(image);
    const rawCanvas = await rasterize(img, 1, "contrast(1.10)");
    const raw = await runPass(worker, rawCanvas, 3, "raw-psm3");
    passes.push({ pass: raw.pass, confidence: raw.confidence, chars: raw.text.length });
    let best = raw;

    if (best.confidence < OCR_GOOD_CONFIDENCE) {
        // The persistent worker's classifier can drift with prior OCRs, which
        // measurably lowers confidence on degraded scans. Rerun on a fresh
        // worker so "hard" scans are scored against a clean classifier.
        await worker.terminate();
        workerPromise = null;
        const freshWorker = await getWorker();
        const freshRaw = await runPass(freshWorker, rawCanvas, 3, "raw-psm3");
        passes.push({ pass: freshRaw.pass, confidence: freshRaw.confidence, chars: freshRaw.text.length });
        best = freshRaw;
    }

    if (!isUsableText(best.text) || best.confidence < OCR_GOOD_CONFIDENCE) {
        try {
            const prepared = preprocessImage(img);
            const pre = await runPass(worker, prepared.canvas, 3, `preprocessed-psm3@${prepared.scale.toFixed(2)}x`);
            passes.push({ pass: pre.pass, confidence: pre.confidence, chars: pre.text.length });
            best = pickBest([best, pre]);

            if (!isUsableText(best.text) || best.confidence < OCR_GOOD_CONFIDENCE) {
                const pre6 = await runPass(worker, prepared.canvas, 6, `preprocessed-psm6@${prepared.scale.toFixed(2)}x`);
                passes.push({ pass: pre6.pass, confidence: pre6.confidence, chars: pre6.text.length });
                best = pickBest([best, pre6]);
            }
        } catch (error) {
            // Preprocessing is best-effort: keep the raw result if it fails.
            console.warn("[IKO OCR] preprocessing pass skipped:", error);
        }
    }

    return {
        text: best.text,
        confidence: best.confidence,
        // Tesseract can report high confidence for an empty page, so treat
        // "no usable text" as low confidence regardless of the number.
        // OCR_GOOD_CONFIDENCE is the IKO floor (>= 80 = acceptable, not low).
        lowConfidence: !isUsableText(best.text) || best.confidence < OCR_GOOD_CONFIDENCE,
        passes
    };
}

function resetWorker() {
    const pending = workerPromise;
    workerPromise = null;
    if (pending) {
        pending.then((worker) => worker.terminate()).catch(() => { /* already gone */ });
    }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.target === "offscreen" && message.type === "IKO_OCR_OFFSCREEN_PING") {
        sendResponse({ ready: true });
        return false;
    }
    if (message.type !== "IKO_OCR_OFFSCREEN") return false;

    const task = queue.then(() => recognize(message.image));
    queue = task.catch(() => { /* keep the queue alive after failures */ });

    task.then(
        (result) => {
            try { sendResponse({ success: true, ...result }); } catch { /* caller gone */ }
        },
        (error) => {
            resetWorker();
            try {
                sendResponse({
                    success: false,
                    error: String(error?.message || error).slice(0, 300)
                });
            } catch { /* caller gone */ }
        }
    );
    return true;
});

// Exposed for diagnostics and automated checks.
self.IKOOffscreenOCR = { recognize, resetWorker };

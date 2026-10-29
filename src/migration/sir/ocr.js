// P1b OCR layer — universal, dependency-free core + pluggable engine.
// Philosophy (per pipeline): never OCR text-native content; preprocess every
// image the same deterministic way; route honestly when no engine is present
// instead of returning garbage. The bundled Tesseract engine runs in an
// extension offscreen document; a `window.IKOOCR.peer` can still override it.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else {
        root.IKOOCR = root.IKOOCR || {};
        Object.assign(root.IKOOCR, factory());
    }
}(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const OCR_VERSION = "0.1.0";

    // Deterministic grayscale + contrast + 2x upscale. Same input pixels →
    // same output pixels. Helps ANY downstream OCR (Tesseract, VLM, built-in).
    function preprocessImageData(imageData) {
        const src = imageData.data;
        const w = imageData.width, h = imageData.height;
        const gray = new Uint8ClampedArray(w * h);
        for (let i = 0; i < w * h; i += 1) {
            const r = src[i * 4], g = src[i * 4 + 1], b = src[i * 4 + 2];
            // luminance + mild contrast stretch around mid-gray
            let v = 0.299 * r + 0.587 * g + 0.114 * b;
            v = Math.min(255, Math.max(0, (v - 128) * 1.25 + 128));
            gray[i] = v;
        }
        // 2x nearest upscale into RGBA (Tesseract likes ≥300dpi-ish pixels)
        const out = { width: w * 2, height: h * 2, data: new Uint8ClampedArray(w * 2 * h * 2 * 4) };
        for (let y = 0; y < h * 2; y += 1) {
            for (let x = 0; x < w * 2; x += 1) {
                const v = gray[Math.floor(y / 2) * w + Math.floor(x / 2)];
                const o = (y * w * 2 + x) * 4;
                out.data[o] = v; out.data[o + 1] = v; out.data[o + 2] = v; out.data[o + 3] = 255;
            }
        }
        return out;
    }

    // Convex skew estimate placeholder: returns 0 (hook for P1b+ deskew).
    function estimateSkewDeg() { return 0; }

    // Engine probe. Order: explicit peer → Tesseract global → bundled offscreen → none.
    function probeEngines() {
        const found = [];
        try {
            if (rootPeer()?.recognize) found.push("peer");
        } catch { /* ignore */ }
        try {
            if (typeof window !== "undefined" && window.Tesseract?.recognize) found.push("tesseract");
        } catch { /* ignore */ }
        try {
            if (extensionRuntime()) found.push("tesseract-offscreen");
        } catch { /* ignore */ }
        return found;
    }

    function rootPeer() {
        try {
            if (typeof window !== "undefined" && window.IKOOCR?.peer?.recognize) return window.IKOOCR.peer;
        } catch { /* ignore */ }
        return null;
    }

    function extensionRuntime() {
        try {
            if (typeof chrome !== "undefined" && chrome.runtime?.id &&
                typeof chrome.runtime.sendMessage === "function") {
                return chrome.runtime;
            }
        } catch { /* ignore */ }
        return null;
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(reader.error || new Error("Could not read the image."));
            reader.readAsDataURL(blob);
        });
    }

    function canvasToDataUrl(source) {
        const canvas = document.createElement("canvas");
        canvas.width = source.width;
        canvas.height = source.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not create an image canvas.");
        ctx.drawImage(source, 0, 0);
        return canvas.toDataURL("image/png");
    }

    // Convert any supported image source to a data URL that the offscreen
    // document can decode without touching the host page.
    async function toDataUrl(src) {
        if (typeof src === "string") return src;
        if (typeof Blob !== "undefined" && src instanceof Blob) {
            if (src.type === "application/pdf") {
                throw new Error("PDF pages need rasterizing first — screenshot the page and OCR the image.");
            }
            return blobToDataUrl(src);
        }
        if (typeof ImageData !== "undefined" && src instanceof ImageData) {
            const canvas = document.createElement("canvas");
            canvas.width = src.width;
            canvas.height = src.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Could not create an image canvas.");
            ctx.putImageData(src, 0, 0);
            return canvas.toDataURL("image/png");
        }
        if (typeof HTMLCanvasElement !== "undefined" && src instanceof HTMLCanvasElement) {
            return src.toDataURL("image/png");
        }
        if (typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement && src.src) {
            return src.src;
        }
        if (typeof ImageBitmap !== "undefined" && src instanceof ImageBitmap) {
            return canvasToDataUrl(src);
        }
        throw new Error("Unsupported image source for OCR.");
    }

    function withTimeout(promise, ms, message) {
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        });
        return Promise.race([promise, timeout]).finally(() => {
            if (timer) clearTimeout(timer);
        });
    }

    async function recognizeOffscreen(imageSource, { lang = "eng", timeoutMs = 60000 } = {}) {
        const runtime = extensionRuntime();
        if (!runtime) return null;

        let image;
        try {
            image = await toDataUrl(imageSource);
        } catch (e) {
            return { route: "ocr-failed", text: "", confidence: 0, engine: "tesseract-offscreen", error: String(e?.message || e).slice(0, 300) };
        }

        try {
            const response = await withTimeout(
                runtime.sendMessage({ type: "IKO_OCR_RECOGNIZE", image, lang }),
                timeoutMs,
                "OCR timed out before the engine responded."
            );
            if (!response?.success) {
                return {
                    route: "ocr-failed",
                    text: "",
                    confidence: 0,
                    engine: "tesseract-offscreen",
                    error: String(response?.error || "The OCR engine did not return a result.").slice(0, 300)
                };
            }
            return normalizeResult(
                {
                    text: response.text || "",
                    confidence: response.confidence ?? 0,
                    lowConfidence: response.lowConfidence,
                    passes: response.passes
                },
                "tesseract-offscreen"
            );
        } catch (e) {
            return { route: "ocr-failed", text: "", confidence: 0, engine: "tesseract-offscreen", error: String(e?.message || e).slice(0, 300) };
        }
    }

    // Main entry. imageSource: ImageData | canvas | Blob | ImageBitmap.
    // Returns {route, text, confidence, engine} — never throws on missing engine.
    async function recognize(imageSource, { lang = "eng", timeoutMs = 60000 } = {}) {
        const peer = rootPeer();
        if (peer?.recognize) {
            try {
                const r = await peer.recognize(imageSource, { lang, timeoutMs });
                return normalizeResult(r, "peer");
            } catch (e) {
                return { route: "ocr-failed", text: "", confidence: 0, engine: "peer", error: String(e?.message || e).slice(0, 300) };
            }
        }
        try {
            if (typeof window !== "undefined" && window.Tesseract?.recognize) {
                const input = await toTesseractInput(imageSource);
                const { data } = await window.Tesseract.recognize(input, lang, { logger: () => {} });
                return normalizeResult({ text: data?.text || "", confidence: data?.confidence ?? 0 }, "tesseract");
            }
        } catch (e) {
            return { route: "ocr-failed", text: "", confidence: 0, engine: "tesseract", error: String(e?.message || e).slice(0, 300) };
        }
        const offscreen = await recognizeOffscreen(imageSource, { lang, timeoutMs });
        if (offscreen) return offscreen;
        return {
            route: "ocr-engine-missing",
            text: "",
            confidence: 0,
            engine: "none",
            guidance: "The bundled Tesseract OCR engine is unavailable. Reload IKO in chrome://extensions " +
                "and try again, or register window.IKOOCR.peer {recognize}."
        };
    }

    async function toTesseractInput(src) {
        // Tesseract.js accepts canvas/video/Image/URL — pass through when possible.
        if (src instanceof Blob) {
            try { return await createImageBitmap(src); } catch { return src; }
        }
        return src;
    }

    function normalizeResult(r, engine) {
        const text = String(r?.text || "").replace(/\s+/g, " ").trim();
        const conf = typeof r?.confidence === "number" ? r.confidence / (r.confidence > 1 ? 100 : 1) : (text ? 0.7 : 0);
        const extra = {};
        if (typeof r?.lowConfidence === "boolean") extra.lowConfidence = r.lowConfidence;
        if (Array.isArray(r?.passes)) extra.passes = r.passes;
        if (!text || text.replace(/[^A-Za-z0-9]/g, "").length < 3) {
            return { route: "ocr-empty", text: "", confidence: conf, engine, ...extra };
        }
        return { route: "ocr-text", text: text.slice(0, 20000), confidence: Math.min(1, Math.max(0, conf)), engine, ...extra };
    }

    // Scanned PDF/image → SIR via OCR text (when engine present), else honest route.
    async function scannedToSIR(imageSource, meta = {}, SIR = null) {
        const ocr = await recognize(imageSource, meta);
        if (ocr.route !== "ocr-text") return { route: ocr.route, ocr, l3: null };
        let l3 = ocr.text;
        try {
            if (SIR) {
                const kv = SIR.textToSIR ? SIR.textToSIR(ocr.text) : null;
                const lines = [
                    SIR.buildDoc ? SIR.buildDoc({ id: meta.id || "scan", type: meta.kind || "scan", title: meta.title }) : "@DOC type=scan",
                    kv || `text=${ocr.text.slice(0, 1500)}`,
                    `@CONF ocr=${ocr.confidence.toFixed(2)} engine=${ocr.engine}${ocr.lowConfidence ? " warning=low-confidence" : ""}`
                ];
                l3 = lines.filter(Boolean).join("\n");
            }
        } catch { /* keep raw ocr text */ }
        return { route: "sir", ocr, l3 };
    }

    return { OCR_VERSION, preprocessImageData, estimateSkewDeg, probeEngines, recognize, scannedToSIR };
}));

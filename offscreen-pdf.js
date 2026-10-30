"use strict";

// Offscreen PDF layer. PDF.js runs inside the extension page (not the host
// page) because it needs its worker, CMaps, and standard fonts, all of which
// are bundled locally. Text is reconstructed into document structure and then
// compressed locally. Image-only pages are rasterized and OCR'd first, then
// sent through the same compressor.
(function () {
    const PDFJS_VERSION = "6.4.299";
    const PDF_MAX_BYTES = 30 * 1024 * 1024;
    const PDF_MAX_TEXT = 500000;
    const PDF_OCR_MIN_ALNUM = 20;
    const PDF_OCR_MAX_PAGES = 40;
    const PDF_OCR_MAX_DIM = 2200;
    const VENDOR = "dist/vendor/pdfjs/";

    let pdfjsPromise = null;

    function getPdfjs() {
        if (!pdfjsPromise) {
            pdfjsPromise = import(chrome.runtime.getURL(VENDOR + "pdf.min.mjs"))
                .then((pdfjs) => {
                    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(VENDOR + "pdf.worker.min.mjs");
                    return pdfjs;
                })
                .catch((error) => {
                    pdfjsPromise = null;
                    throw new Error(`PDF engine failed to load: ${String(error?.message || error)}`);
                });
        }
        return pdfjsPromise;
    }

    function base64ToBytes(base64) {
        const clean = String(base64 || "").replace(/\s+/g, "");
        if (!clean) throw new Error("PDF payload is empty.");
        if (clean.length > Math.ceil(PDF_MAX_BYTES * 4 / 3) + 8) {
            throw new Error(`PDF is too large for local text extraction (max ${Math.round(PDF_MAX_BYTES / 1048576)}MB).`);
        }
        const binary = atob(clean);
        if (binary.length > PDF_MAX_BYTES) {
            throw new Error(`PDF is too large for local text extraction (max ${Math.round(PDF_MAX_BYTES / 1048576)}MB).`);
        }
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function rawPageText(content) {
        let text = "";
        const items = Array.isArray(content?.items) ? content.items : [];
        for (const item of items) {
            if (typeof item?.str !== "string" || !item.str) continue;
            text += item.str;
            if (item.hasEOL) text += "\n";
            else if (!/\s$/.test(item.str)) text += " ";
        }
        return text
            .replace(/[ \t]+/g, " ")
            .replace(/ *\n */g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    function countAlnum(text) {
        try {
            return (String(text || "").match(/[\p{L}\p{N}]/gu) || []).length;
        } catch {
            return (String(text || "").match(/[A-Za-z0-9]/g) || []).length;
        }
    }

    function estimateTokens(text) {
        return Math.max(1, Math.ceil(String(text || "").length / 4));
    }

    function pageSize(page) {
        const viewport = page.getViewport({ scale: 1 });
        return { width: viewport.width, height: viewport.height };
    }

    async function renderPage(page) {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.max(1.4, Math.min(2.2, PDF_OCR_MAX_DIM / Math.max(base.width, base.height)));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Could not create the PDF OCR canvas.");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, background: "#ffffff" }).promise;
        return canvas;
    }

    async function ocrPage(page) {
        if (!self.IKOOffscreenOCR?.recognize) {
            throw new Error("OCR engine is not available in the offscreen document.");
        }
        const canvas = await renderPage(page);
        const image = canvas.toDataURL("image/png");
        const result = await self.IKOOffscreenOCR.recognize(image);
        return {
            text: String(result?.text || "").trim(),
            confidence: Number(result?.confidence || 0),
            lowConfidence: result?.lowConfidence === true,
            passes: result?.passes || []
        };
    }

    function combinePageBlocks(pages, textPages) {
        const textBlocks = textPages.length && self.IKOPDFLAYOUT?.buildDocumentBlocks
            ? self.IKOPDFLAYOUT.buildDocumentBlocks(textPages)
            : [];
        const byPage = new Map();
        for (const block of textBlocks) {
            if (!byPage.has(block.page)) byPage.set(block.page, []);
            byPage.get(block.page).push(block);
        }
        const blocks = [];
        for (const page of pages) {
            if (page.content) {
                blocks.push(...(byPage.get(page.page) || []));
            } else if (page.ocrText) {
                blocks.push(...self.IKOPDFLAYOUT.blocksFromText(page.ocrText, { page: page.page, ocr: true }));
            }
        }
        return blocks;
    }

    function noticeFor(ocrPages, blockedOcrPages) {
        if (ocrPages) {
            return "[Compressed PDF text — OCR + structure-preserving; headings, numbers, formulas, warnings, tables, and Q&A kept.]";
        }
        if (blockedOcrPages) {
            return "[Compressed PDF text — image-only pages were not OCR'd; use Compress to OCR them.]";
        }
        return "[Compressed PDF text — headings, numbers, formulas, warnings, tables, and Q&A kept.]";
    }

    async function extract(base64, options = {}) {
        const data = base64ToBytes(base64);
        const pdfjs = await getPdfjs();
        const ocrMode = ["auto", "never", "force"].includes(options.ocr) ? options.ocr : "auto";
        const task = pdfjs.getDocument({
            data,
            cMapUrl: chrome.runtime.getURL(VENDOR + "cmaps/"),
            cMapPacked: true,
            standardFontDataUrl: chrome.runtime.getURL(VENDOR + "standard_fonts/"),
            wasmUrl: chrome.runtime.getURL(VENDOR + "wasm/"),
            useSystemFonts: false,
            disableFontFace: true,
            isEvalSupported: false,
            verbosity: 0
        });

        let doc = null;
        try {
            doc = await task.promise;
            const pages = [];
            const textPages = [];
            const ocr = {
                pages: 0,
                failed: 0,
                limited: 0,
                confidenceSum: 0,
                lowConfidence: false,
                tried: 0
            };
            let rawChars = 0;

            for (let i = 1; i <= doc.numPages; i += 1) {
                const page = await doc.getPage(i);
                try {
                    const size = pageSize(page);
                    const content = await page.getTextContent();
                    const raw = rawPageText(content);
                    rawChars += raw.length;
                    const alnum = countAlnum(raw);
                    const wantOcr = ocrMode === "force" || (ocrMode === "auto" && alnum < PDF_OCR_MIN_ALNUM);
                    if (!wantOcr) {
                        const record = { page: i, width: size.width, height: size.height, content, rawText: raw };
                        pages.push(record);
                        textPages.push(record);
                        continue;
                    }

                    if (ocr.tried >= PDF_OCR_MAX_PAGES) {
                        ocr.limited += 1;
                        pages.push({
                            page: i,
                            width: size.width,
                            height: size.height,
                            content: alnum ? content : null,
                            rawText: raw,
                            ocrText: ""
                        });
                        if (alnum) textPages.push(pages[pages.length - 1]);
                        continue;
                    }

                    ocr.tried += 1;
                    let result = null;
                    let failure = null;
                    try {
                        result = await ocrPage(page);
                    } catch (error) {
                        failure = error;
                    }

                    if (result && countAlnum(result.text) >= 6) {
                        ocr.pages += 1;
                        ocr.confidenceSum += result.confidence;
                        if (result.lowConfidence) ocr.lowConfidence = true;
                        pages.push({
                            page: i,
                            width: size.width,
                            height: size.height,
                            content: null,
                            rawText: raw,
                            ocrText: result.text,
                            ocrConfidence: result.confidence,
                            ocrLow: result.lowConfidence
                        });
                    } else {
                        ocr.failed += 1;
                        // Keep native text when OCR failed; otherwise the page
                        // remains empty and the caller gets an honest count.
                        pages.push({
                            page: i,
                            width: size.width,
                            height: size.height,
                            content: alnum ? content : null,
                            rawText: raw,
                            ocrText: "",
                            ocrError: String(failure?.message || "OCR returned no readable text").slice(0, 200)
                        });
                        if (alnum) textPages.push(pages[pages.length - 1]);
                    }
                } finally {
                    page.cleanup();
                }
            }

            const blocks = combinePageBlocks(pages, textPages);
            let fullText = self.IKOPDFLAYOUT?.blocksToMarkdown
                ? self.IKOPDFLAYOUT.blocksToMarkdown(blocks)
                : pages.map(page => page.ocrText || page.rawText).filter(Boolean).join("\n\n");
            const truncated = fullText.length > PDF_MAX_TEXT;
            if (truncated) fullText = fullText.slice(0, PDF_MAX_TEXT).trim();
            const compressor = self.IKOTEXTCOMPRESS;
            let compressed = null;
            if (compressor?.compress) {
                compressed = compressor.compress(blocks, {
                    countTokens: estimateTokens,
                    tokensIn: estimateTokens(fullText),
                    targetRatio: 0.6,
                    maxRatio: 0.92,
                    notice: noticeFor(ocr.pages, ocr.limited || ocr.failed)
                });
            }

            const text = compressed?.text || fullText;
            return {
                text,
                fullText,
                pages: doc.numPages,
                chars: fullText.length,
                rawChars,
                tokensIn: compressed?.tokensIn || estimateTokens(fullText),
                tokensOut: compressed?.tokensOut || estimateTokens(text),
                ratio: compressed?.ratio || 0,
                savedPct: compressed?.savedPct || 0,
                blocks: blocks.length,
                ocrPages: ocr.pages,
                ocrFailed: ocr.failed,
                ocrLimited: ocr.limited,
                ocrConfidence: ocr.pages ? Math.round(ocr.confidenceSum / ocr.pages) : 0,
                ocrLowConfidence: ocr.lowConfidence,
                mode: ocr.pages ? (textPages.length ? "mixed" : "ocr") : "text",
                truncated,
                engine: `pdfjs-${PDFJS_VERSION}${ocr.pages ? "+tesseract" : ""}`
            };
        } finally {
            try { await doc?.destroy(); } catch { /* ignore */ }
        }
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || message.target !== "offscreen" || message.type !== "IKO_PDF_TEXT") return false;
        extract(message.data, { ocr: message.ocr }).then(
            (result) => {
                try { sendResponse({ success: true, ...result }); } catch { /* caller gone */ }
            },
            (error) => {
                try { sendResponse({ success: false, error: String(error?.message || error).slice(0, 300) }); } catch { /* caller gone */ }
            }
        );
        return true;
    });

    // Exposed for diagnostics and automated checks.
    self.IKOOffscreenPDF = { extract };
}());

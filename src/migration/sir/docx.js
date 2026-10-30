// P1c DOCX layer — local, dependency-free .docx text extraction.
// A .docx is a ZIP; the visible text lives in word/document.xml. We read the
// central directory, inflate that one entry with the platform's built-in
// DecompressionStream, and keep only <w:t> runs (paragraphs → newlines).
// Nothing leaves the browser and no third-party parser is bundled.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else {
        root.IKODOCX = root.IKODOCX || {};
        Object.assign(root.IKODOCX, factory());
    }
}(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const DOCX_VERSION = "0.1.0";
    const EOCD_SIG = 0x06054b50;
    const CENTRAL_SIG = 0x02014b50;
    const LOCAL_SIG = 0x04034b50;

    function decodeEntities(text) {
        return String(text || "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
            .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
            .replace(/&amp;/g, "&");
    }

    // word/document.xml → plain text. Paragraph ends become newlines, tabs and
    // line breaks survive, everything that is not <w:t> run text is dropped.
    function docxXmlToText(xml, maxChars = 200000) {
        let text = String(xml || "");
        text = text
            .replace(/<w:tab\b[^>]*\/>/g, "\t")
            .replace(/<w:br\b[^>]*\/>/g, "\n")
            .replace(/<\/w:p>/g, "\n");
        text = text.replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, "$1");
        text = text.replace(/<[^>]+>/g, "");
        text = decodeEntities(text);
        text = text
            .replace(/\r\n?/g, "\n")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        return text.slice(0, maxChars);
    }

    function findEndOfCentralDirectory(view, length) {
        const min = Math.max(0, length - 22 - 0xFFFF);
        for (let i = length - 22; i >= min; i -= 1) {
            if (view.getUint32(i, true) === EOCD_SIG) return i;
        }
        return -1;
    }

    async function inflateRaw(bytes) {
        if (typeof DecompressionStream !== "function") {
            throw new Error("This browser cannot decompress .docx (DecompressionStream missing).");
        }
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function toArrayBuffer(source) {
        if (source instanceof ArrayBuffer) return source;
        if (ArrayBuffer.isView(source)) {
            return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
        }
        if (source && typeof source.arrayBuffer === "function") return source.arrayBuffer();
        throw new Error("Unsupported .docx input.");
    }

    // Extract the visible text of a .docx. `source` may be a File/Blob, an
    // ArrayBuffer or any typed-array view. Throws a readable error for non-zip
    // input or legacy .doc.
    async function extractDocxText(source, { maxChars = 200000 } = {}) {
        const buffer = await toArrayBuffer(source);
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);
        if (bytes.length < 22) throw new Error("Not a valid .docx file (too small).");

        const eocd = findEndOfCentralDirectory(view, bytes.length);
        if (eocd < 0) {
            throw new Error("Not a valid .docx file (missing ZIP directory). Legacy .doc? Save as .docx.");
        }

        const count = view.getUint16(eocd + 10, true);
        let offset = view.getUint32(eocd + 16, true);
        let entry = null;
        for (let i = 0; i < count; i += 1) {
            if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_SIG) break;
            const method = view.getUint16(offset + 10, true);
            const compressedSize = view.getUint32(offset + 20, true);
            const nameLen = view.getUint16(offset + 28, true);
            const extraLen = view.getUint16(offset + 30, true);
            const commentLen = view.getUint16(offset + 32, true);
            const localOffset = view.getUint32(offset + 42, true);
            const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
            if (name === "word/document.xml") {
                entry = { method, compressedSize, localOffset };
                break;
            }
            offset += 46 + nameLen + extraLen + commentLen;
        }
        if (!entry) throw new Error("word/document.xml not found — is this a Word .docx?");

        const local = entry.localOffset;
        if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL_SIG) {
            throw new Error("Corrupt .docx entry (bad local header).");
        }
        const localNameLen = view.getUint16(local + 26, true);
        const localExtraLen = view.getUint16(local + 28, true);
        const dataStart = local + 30 + localNameLen + localExtraLen;
        const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);

        let xmlBytes;
        if (entry.method === 0) xmlBytes = compressed;
        else if (entry.method === 8) xmlBytes = await inflateRaw(compressed);
        else throw new Error(`Unsupported .docx compression method ${entry.method}.`);

        const xml = new TextDecoder().decode(xmlBytes);
        return docxXmlToText(xml, maxChars);
    }

    // Fallback estimate for when extraction is unavailable (legacy .doc or an
    // unreadable archive). A .docx holds roughly one token per ~18 zip bytes.
    function estimateWordTokens(sizeBytes) {
        return Math.max(500, Math.ceil(Number(sizeBytes || 0) / 18));
    }

    return { DOCX_VERSION, docxXmlToText, extractDocxText, estimateWordTokens };
}));

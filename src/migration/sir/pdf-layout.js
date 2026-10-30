// P1d PDF layout layer — turn PDF.js text items into document structure.
// PDF.js gives glyph runs with positions and font sizes; this module groups
// them into lines, headings, paragraphs, bullets, tables and Q&A blocks.
// It is pure data (no DOM, no PDF.js import) so Node tests and the offscreen
// page can use exactly the same layout logic.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else {
        root.IKOPDFLAYOUT = root.IKOPDFLAYOUT || {};
        Object.assign(root.IKOPDFLAYOUT, factory());
    }
}(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const LAYOUT_VERSION = "0.1.0";
    const BULLET_RE = /^[\u2022\u25e6\u25aa\u2023\u2043\u2219•*+\-\u00ab\u00bb\u2039\u203a]\s+/;
    const FURNITURE_TOP = 48;
    const FURNITURE_BOTTOM = 38;
    const TABLE_GAP_MIN = 18;
    const BODY_GAP_FACTOR = 1.55;

    function cleanText(value) {
        return String(value || "")
            .replace(/\u00a0/g, " ")
            .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
            .replace(/[\u00ad]/g, "")
            .replace(/[ \t]+/g, " ")
            .trim();
    }

    function countAlnum(text) {
        try {
            return (String(text || "").match(/[\p{L}\p{N}]/gu) || []).length;
        } catch {
            return (String(text || "").match(/[A-Za-z0-9]/g) || []).length;
        }
    }

    function itemSize(item) {
        const t = item?.transform;
        if (Array.isArray(t) && t.length >= 4) {
            const size = Math.hypot(Number(t[2]) || 0, Number(t[3]) || 0);
            if (size > 0) return size;
        }
        return Math.max(1, Number(item?.height) || 0);
    }

    function itemWidth(item) {
        const w = Number(item?.width);
        if (Number.isFinite(w) && w > 0) return w;
        return Math.max(1, String(item?.str || "").length * itemSize(item) * 0.5);
    }

    function buildItems(content) {
        const items = [];
        const raw = Array.isArray(content?.items) ? content.items : [];
        for (const item of raw) {
            if (typeof item?.str !== "string") continue;
            const text = cleanText(item.str);
            if (!text) continue;
            const t = Array.isArray(item.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
            items.push({
                text,
                x: Number(t[4]) || 0,
                y: Number(t[5]) || 0,
                width: itemWidth(item),
                size: itemSize(item),
                font: String(item.fontName || ""),
                eol: item.hasEOL === true
            });
        }
        return items;
    }

    // Group glyph runs into visual lines. Superscripts can sit a few points
    // above their line, so the tolerance follows the smaller font size.
    function buildLines(items) {
        const lines = [];
        for (const item of items) {
            let line = null;
            for (const candidate of lines) {
                const tol = Math.max(1.8, Math.min(candidate.size, item.size) * 0.38);
                if (Math.abs(candidate.y - item.y) <= tol) { line = candidate; break; }
            }
            if (!line) {
                line = { y: item.y, size: item.size, items: [] };
                lines.push(line);
            }
            line.items.push(item);
            line.size = Math.max(line.size, item.size);
        }
        lines.sort((a, b) => b.y - a.y || a.items[0].x - b.items[0].x);

        for (const line of lines) {
            line.items.sort((a, b) => a.x - b.x);
            const cells = [];
            for (const item of line.items) {
                const last = cells[cells.length - 1];
                const gap = last ? item.x - (last.x + last.width) : 0;
                if (last && gap <= Math.max(2.2, Math.min(last.size, item.size) * 0.5)) {
                    if (gap > Math.max(1.2, item.size * 0.13)) last.text += " ";
                    last.text += item.text;
                    last.width = Math.max(last.width, item.x + item.width - last.x);
                    last.size = Math.max(last.size, item.size);
                    last.fonts.add(item.font);
                } else {
                    cells.push({
                        x: item.x,
                        width: item.width,
                        text: item.text,
                        size: item.size,
                        fonts: new Set([item.font])
                    });
                }
            }
            for (const cell of cells) cell.text = cleanText(cell.text);
            line.cells = cells.filter(cell => cell.text);
            line.text = cleanText(line.cells.map(cell => cell.text).join(" "));
            line.maxSize = Math.max(...line.items.map(item => item.size), 1);
            line.fonts = new Set(line.items.map(item => item.font));
        }
        return lines.filter(line => line.text);
    }

    // Per page, the body size is the size carrying the most characters.
    // Headings and footnotes are therefore measured against real body text,
    // not a hard-coded point size.
    function bodyStyle(lines, fallback = { size: 10, font: "" }) {
        const sizes = new Map();
        const fonts = new Map();
        for (const line of lines) {
            for (const cell of line.cells) {
                const key = cell.size.toFixed(1);
                sizes.set(key, (sizes.get(key) || 0) + cell.text.length);
                for (const font of cell.fonts) {
                    fonts.set(font, (fonts.get(font) || 0) + cell.text.length);
                }
            }
        }
        let size = Number(fallback.size) || 10;
        let best = 0;
        for (const [key, count] of sizes) {
            const value = Number(key);
            if (!Number.isFinite(value) || value < 6 || value > 22) continue;
            if (count > best) { best = count; size = value; }
        }
        let font = fallback.font || "";
        best = 0;
        for (const [key, count] of fonts) {
            if (count > best) { best = count; font = key; }
        }
        return { size, font };
    }

    function hasBigGap(line) {
        for (let i = 1; i < line.cells.length; i += 1) {
            const prev = line.cells[i - 1];
            if (line.cells[i].x - (prev.x + prev.width) > TABLE_GAP_MIN) return true;
        }
        return false;
    }

    function tableRowsMatch(a, b) {
        if (!a || !b) return false;
        if (Math.abs(a.length - b.length) > 1) return false;
        return Math.abs((a[0]?.x || 0) - (b[0]?.x || 0)) <= 8;
    }

    // Tables in this layer are visual: two or more columns with a stable left
    // edge over consecutive lines. A single wide-gap line stays a paragraph.
    function markTables(lines) {
        const candidates = [];
        lines.forEach((line, index) => {
            if (line.cells.length >= 2 && hasBigGap(line)) candidates.push({ line, index });
        });
        const groups = [];
        let current = [];
        for (const candidate of candidates) {
            const prev = current[current.length - 1];
            if (prev && candidate.index - prev.index <= 2 && tableRowsMatch(prev.line.cells, candidate.line.cells)) {
                current.push(candidate);
            } else {
                if (current.length >= 2) groups.push(current);
                current = [candidate];
            }
        }
        if (current.length >= 2) groups.push(current);

        for (const group of groups) {
            const rows = group.map(({ line }) => line.cells.map(cell => cell.text));
            const first = rows[0] || [];
            const header = first.some(cell => /^(term|meaning|metric|component|role|without|with|focus|feature|item|value|description|stage|layer)$/i.test(cell.trim()));
            const table = { rows, header };
            group.forEach(({ line }, index) => {
                line.type = "table";
                line.table = table;
                line.tableRow = rows[index];
            });
        }
    }

    function furnitureKey(text) {
        return String(text || "")
            .toLowerCase()
            .replace(/\bpage\s*\d+\b/g, "page #")
            .replace(/\d+/g, "#")
            .replace(/[^a-z#]+/g, " ")
            .trim();
    }

    function isFurnitureLine(line, height) {
        const y = Number(line.y) || 0;
        if (y <= FURNITURE_TOP || y >= height - FURNITURE_BOTTOM) return true;
        return /^(?:page\s*)?\d+(?:\s*\/\s*\d+)?$/i.test(line.text);
    }

    function isContactLine(text) {
        const value = String(text || "");
        if (/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(value)) return true;
        if (/(?:https?:\/\/|www\.|linkedin\.com|github\.com|gitlab\.com)/i.test(value)) return true;
        if (/(?:\+?\d[\d\s().-]{7,}\d)/.test(value) && value.replace(/[^\d]/g, "").length >= 7) return true;
        return false;
    }

    function classifyLine(line, body) {
        if (line.type === "table") return "table";
        if (BULLET_RE.test(line.text)) return "li";
        if (isContactLine(line.text)) return "p";
        const ratio = body.size > 0 ? line.maxSize / body.size : 1;
        const bold = [...line.fonts].some(font => font && font !== body.font);
        if (ratio >= 1.5) return "h1";
        if (ratio >= 1.16) return "h2";
        if (ratio >= 1.055 && bold) return "h3";
        if (bold && line.text.length <= 54 && !/[.!?;]$/.test(line.text) && !/\d$/.test(line.text)) return "h4";
        return "p";
    }

    function lineBlock(line, page, type) {
        return {
            type,
            text: line.text,
            page,
            y: line.y,
            size: line.maxSize,
            cells: line.cells.map(cell => cell.text),
            table: line.table || null
        };
    }

    function appendText(block, text) {
        if (!text) return;
        const joiner = /[\-/]$/.test(block.text) ? "" : " ";
        block.text = cleanText(`${block.text}${joiner}${text}`);
    }

    function blocksForPage(pageData, options = {}) {
        const height = Number(pageData.height) || 792;
        const items = buildItems(pageData.content);
        let lines = buildLines(items);
        const drop = options.dropFurniture;
        if (drop && drop.size) {
            lines = lines.filter(line => {
                if (!isFurnitureLine(line, height)) return true;
                return !drop.has(furnitureKey(line.text));
            });
        }
        const body = bodyStyle(lines, options.fallbackBody);
        markTables(lines);
        for (const line of lines) {
            if (!line.type) line.type = classifyLine(line, body);
        }

        const blocks = [];
        let tableState = null;
        for (const line of lines) {
            if (line.type === "table") {
                if (!tableState || tableState.table !== line.table) {
                    tableState = { type: "table", page: pageData.page, table: line.table, text: "", rows: [] };
                    blocks.push(tableState);
                }
                tableState.rows.push(line.tableRow || line.table.rows[line.table.rows.length - 1]);
                tableState.text = line.text;
                continue;
            }
            tableState = null;

            const block = lineBlock(line, pageData.page, line.type);
            const prev = blocks[blocks.length - 1];
            const gap = prev ? prev.y - line.y : 0;

            if (line.type === "p" && prev && prev.type === "p" && gap > 0 && gap <= body.size * BODY_GAP_FACTOR) {
                appendText(prev, line.text);
                prev.y = line.y;
                continue;
            }
            if (line.type === "p" && prev && prev.type === "li" && gap > 0 && gap <= body.size * BODY_GAP_FACTOR) {
                appendText(prev, line.text);
                prev.y = line.y;
                continue;
            }
            if (line.type === "li" && prev && prev.type === "li") {
                // A bullet's wrapped continuation was classified as p above;
                // a real new bullet starts with a bullet glyph.
                blocks.push(block);
                continue;
            }
            if (line.type === "h1" && prev && prev.type === "h1" && (/^AND\b/i.test(line.text) || /^[A-Z0-9 ,&/()-]+$/.test(prev.text))) {
                appendText(prev, line.text);
                prev.y = line.y;
                continue;
            }
            if (line.type === "h4" && prev && prev.type === "p" && gap > 0 && gap <= body.size * BODY_GAP_FACTOR) {
                // A bold run-in label from a previous visual line is rare; keep
                // it as a paragraph heading only when it stands alone.
                blocks.push(block);
                continue;
            }
            blocks.push(block);
        }
        return blocks;
    }

    function splitQaSegments(text) {
        const clean = cleanText(text);
        if (!/Q\d+\./.test(clean)) return null;
        const parts = clean.split(/(?=\bQ\d+\.\s)/).map(part => part.trim()).filter(Boolean);
        if (parts.length < 1) return null;
        return parts;
    }

    // Turn paragraphs that contain "Q1. ... ? answer ... Q2. ..." into explicit
    // Q&A blocks. Answers can continue in the next block until the next Q.
    function splitQaBlocks(blocks) {
        const out = [];
        let pending = null;
        for (const block of blocks) {
            if (block.type !== "p") {
                if (pending) { out.push(pending); pending = null; }
                out.push(block);
                continue;
            }
            const segments = splitQaSegments(block.text);
            if (!segments) {
                if (pending) {
                    pending.answer = cleanText(`${pending.answer} ${block.text}`);
                    pending.text = cleanText(`${pending.question} ${pending.answer}`);
                    continue;
                }
                out.push(block);
                continue;
            }
            for (const segment of segments) {
                const match = segment.match(/^(Q\d+\.)\s*([\s\S]*)$/);
                if (!match) {
                    if (pending) {
                        pending.answer = cleanText(`${pending.answer} ${segment}`);
                        pending.text = cleanText(`${pending.question} ${pending.answer}`);
                    } else {
                        out.push({ ...block, text: segment });
                    }
                    continue;
                }
                if (pending) { out.push(pending); pending = null; }
                const rest = match[2];
                const qmark = rest.indexOf("?");
                if (qmark >= 0) {
                    const question = cleanText(`${match[1]} ${rest.slice(0, qmark + 1)}`);
                    const answer = cleanText(rest.slice(qmark + 1));
                    if (answer) out.push({ type: "qa", page: block.page, question, answer, text: `${question} ${answer}` });
                    else pending = { type: "qa", page: block.page, question, answer: "", text: question };
                } else {
                    pending = { type: "qa", page: block.page, question: cleanText(segment), answer: "", text: cleanText(segment) };
                }
            }
        }
        if (pending) out.push(pending);
        return out;
    }

    function mergeAcrossPages(blocks) {
        const out = [];
        for (const block of blocks) {
            const prev = out[out.length - 1];
            if (
                prev && block &&
                prev.type === "p" && block.type === "p" &&
                prev.page !== block.page &&
                !/[.!?:"')\]]$/.test(prev.text) &&
                /^[a-z(]/.test(block.text)
            ) {
                appendText(prev, block.text);
                continue;
            }
            out.push(block);
        }
        return out;
    }

    function buildDocumentBlocks(pages, options = {}) {
        const pageLines = [];
        for (const page of pages) {
            const height = Number(page.height) || 792;
            const lines = buildLines(buildItems(page.content));
            const body = bodyStyle(lines, options.fallbackBody);
            markTables(lines);
            for (const line of lines) if (!line.type) line.type = classifyLine(line, body);
            pageLines.push({ page, lines, body });
        }

        // Repeated running headers/footers are page furniture, not content.
        const furniture = new Map();
        for (const { page, lines } of pageLines) {
            const height = Number(page.height) || 792;
            for (const line of lines) {
                if (!isFurnitureLine(line, height)) continue;
                const key = furnitureKey(line.text);
                if (key) furniture.set(key, (furniture.get(key) || 0) + 1);
            }
        }
        const drop = new Set(
            [...furniture.entries()]
                .filter(([key, count]) => count >= 2 && key.replace(/#/g, "").trim().length >= 8)
                .map(([key]) => key)
        );

        const all = [];
        for (const { page, body } of pageLines) {
            const pageBlockList = blocksForPage(page, { fallbackBody: body, dropFurniture: drop });
            all.push(...pageBlockList);
        }
        return mergeAcrossPages(splitQaBlocks(all));
    }

    function blocksToText(blocks) {
        const lines = [];
        for (const block of blocks) {
            if (block.type === "table") {
                for (const row of block.rows || []) lines.push(row.join(" | "));
            } else if (block.type === "qa") {
                lines.push(block.question);
                if (block.answer) lines.push(block.answer);
            } else if (block.type === "li") {
                lines.push(`• ${block.text.replace(BULLET_RE, "")}`);
            } else if (block.type === "h1" || block.type === "h2" || block.type === "h3" || block.type === "h4") {
                lines.push(block.text);
            } else {
                lines.push(block.text);
            }
        }
        return lines.filter(Boolean).join("\n\n").trim();
    }

    function blocksToMarkdown(blocks) {
        const lines = [];
        const heading = { h1: "#", h2: "##", h3: "###", h4: "####" };
        for (const block of blocks) {
            if (block.type === "table") {
                const rows = block.rows || [];
                if (!rows.length) continue;
                rows.forEach((row, index) => {
                    lines.push(`| ${row.join(" | ")} |`);
                    if (index === 0 && block.table?.header) {
                        lines.push(`| ${row.map(() => "---").join(" | ")} |`);
                    }
                });
                lines.push("");
            } else if (block.type === "qa") {
                lines.push(block.question);
                if (block.answer) lines.push(`A: ${block.answer}`);
                lines.push("");
            } else if (block.type === "li") {
                lines.push(`- ${block.text.replace(BULLET_RE, "")}`);
            } else if (heading[block.type]) {
                lines.push(`${heading[block.type]} ${block.text}`);
                lines.push("");
            } else {
                lines.push(block.text);
                lines.push("");
            }
        }
        return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    function tableCells(line) {
        const value = String(line || "").trim();
        if (!value) return null;
        if (/^\|.*\|$/.test(value)) {
            const cells = value.slice(1, -1).split("|").map(cell => cleanText(cell));
            return cells.length >= 2 ? cells : null;
        }
        const parts = value.split(/\s{2,}/).map(cell => cleanText(cell)).filter(Boolean);
        if (parts.length >= 2 && parts.length <= 12 && value.length <= 400 && parts.every(cell => cell.length <= 120)) {
            return parts;
        }
        return null;
    }

    function looksLikeHeading(line, prevBlank, nextBlank, prevHeading = false) {
        const value = cleanText(line);
        if (!value || value.length > 100 || isContactLine(value)) return false;
        if (/[.!?;]$/.test(value)) return false;
        if (BULLET_RE.test(value) || /^(?:Q|A)\d*[.)]/i.test(value)) return false;
        if (/^\d{1,2}(?:\.\d+)?[.)]?\s+[A-Z]/.test(value) && value.length <= 90) return true;
        const letters = (value.match(/\p{L}/gu) || []).length;
        const upper = (value.match(/\p{Lu}/gu) || []).length;
        if (letters >= 3 && upper / letters >= 0.7) return true;
        const words = value.split(/\s+/).filter(Boolean);
        if (words.length >= 1 && words.length <= 10 && /^[A-Z0-9]/.test(value)) {
            if (prevBlank && nextBlank) return true;
            if ((prevBlank || prevHeading) && value.length <= 70) return true;
        }
        return false;
    }

    // Rebuild document blocks from plain text (OCR output or a text-only
    // source). The PDF.js path above is positional; this path is heuristic but
    // keeps headings, bullets, Q&A, tables and paragraphs in reading order.
    function blocksFromText(text, options = {}) {
        const page = Number(options.page) || 1;
        const lines = String(text || "")
            .replace(/\r\n?/g, "\n")
            .replace(/\t/g, "    ")
            .split("\n")
            .map(line => line.replace(/\s+$/, ""));
        const blocks = [];
        let paragraph = [];
        let table = null;
        let pendingQa = null;
        let prevBlank = true;
        let prevHeading = false;

        const flushParagraph = () => {
            if (!paragraph.length) return;
            const joined = paragraph.reduce((out, line) => {
                if (!out) return line;
                return /[A-Za-z]-$/.test(out) ? out + line : `${out} ${line}`;
            }, "").replace(/\s+/g, " ").trim();
            if (joined) blocks.push({ type: "p", text: joined, page, ocr: options.ocr === true });
            paragraph = [];
        };
        const flushTable = () => {
            if (table) {
                blocks.push(table);
                table = null;
            }
        };
        const flushQa = () => {
            if (!pendingQa) return;
            pendingQa.text = cleanText(`${pendingQa.question} ${pendingQa.answer || ""}`);
            blocks.push(pendingQa);
            pendingQa = null;
        };

        for (let index = 0; index < lines.length; index += 1) {
            const raw = lines[index];
            const line = cleanText(raw);
            if (!line) {
                flushParagraph();
                flushTable();
                flushQa();
                prevBlank = true;
                continue;
            }
            if (/^(?:page\s*)?\d+(?:\s*\/\s*\d+)?$/i.test(line)) {
                flushParagraph();
                flushTable();
                flushQa();
                prevBlank = true;
                continue;
            }
            if (/\bpage\s*\d+\b/i.test(line) && line.length <= 160 && !/[.!?]$/.test(line)) {
                flushParagraph();
                flushTable();
                flushQa();
                prevBlank = true;
                continue;
            }
            const markdown = line.match(/^(#{1,6})\s+(.*)$/);
            if (markdown) {
                flushParagraph();
                flushTable();
                flushQa();
                blocks.push({ type: `h${Math.min(4, markdown[1].length)}`, text: cleanText(markdown[2]), page });
                prevBlank = false;
                prevHeading = true;
                continue;
            }
            if (BULLET_RE.test(line)) {
                flushParagraph();
                flushTable();
                flushQa();
                blocks.push({ type: "li", text: cleanText(line.replace(BULLET_RE, "")), page });
                prevBlank = false;
                prevHeading = false;
                continue;
            }
            const answer = line.match(/^A[.:]\s*(.+)$/i);
            if (answer && pendingQa) {
                pendingQa.answer = cleanText(`${pendingQa.answer || ""} ${answer[1]}`);
                prevBlank = false;
                prevHeading = false;
                continue;
            }
            const qa = line.match(/^(Q\d+[.)])\s*(.*)$/i);
            if (qa) {
                flushParagraph();
                flushTable();
                flushQa();
                const rest = qa[2] || "";
                const mark = rest.indexOf("?");
                if (mark >= 0) {
                    pendingQa = {
                        type: "qa",
                        page,
                        question: cleanText(`${qa[1]} ${rest.slice(0, mark + 1)}`),
                        answer: cleanText(rest.slice(mark + 1))
                    };
                } else {
                    pendingQa = { type: "qa", page, question: cleanText(line), answer: "" };
                }
                prevBlank = false;
                prevHeading = false;
                continue;
            }
            const cells = tableCells(line);
            if (cells) {
                flushParagraph();
                flushQa();
                if (!table) table = { type: "table", rows: [], page };
                table.rows.push(cells);
                prevBlank = false;
                prevHeading = false;
                continue;
            }
            flushTable();
            const nextBlank = !cleanText(lines[index + 1] || "");
            if (looksLikeHeading(line, prevBlank, nextBlank, prevHeading)) {
                flushParagraph();
                flushQa();
                const level = (/^\d/.test(line) || /^[A-Z0-9][A-Z0-9 /&()'’.,:+-]{2,}$/.test(line)) ? "h2" : "h3";
                blocks.push({ type: level, text: line, page });
                prevBlank = false;
                prevHeading = true;
                continue;
            }
            if (pendingQa && !prevBlank) {
                pendingQa.answer = cleanText(`${pendingQa.answer || ""} ${line}`);
                prevBlank = false;
                prevHeading = false;
                continue;
            }
            paragraph.push(line);
            prevBlank = false;
            prevHeading = false;
        }
        flushParagraph();
        flushTable();
        flushQa();
        return blocks;
    }

    return {
        LAYOUT_VERSION,
        cleanText,
        countAlnum,
        buildItems,
        buildLines,
        bodyStyle,
        markTables,
        classifyLine,
        isContactLine,
        splitQaBlocks,
        blocksForPage,
        buildDocumentBlocks,
        blocksFromText,
        blocksToText,
        blocksToMarkdown
    };
}));

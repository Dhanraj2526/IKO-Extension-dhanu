// P2b text compression — structure-preserving, deterministic, local.
// Input is either a block list from pdf-layout.js or plain/Markdown text.
// The compressor never paraphrases facts: it removes page furniture,
// duplicate text and filler, keeps every heading/list/table/Q&A question, and
// protects sentences carrying numbers, formulas, warnings and definitions.
// A final audit re-attaches any numeric/formula fact that did not survive.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else {
        root.IKOTEXTCOMPRESS = root.IKOTEXTCOMPRESS || {};
        Object.assign(root.IKOTEXTCOMPRESS, factory());
    }
}(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const COMPRESS_VERSION = "0.1.0";

    const DEFAULTS = Object.freeze({
        targetRatio: 0.55,
        minRatio: 0.34,
        maxRatio: 0.78,
        dedupeThreshold: 0.8,
        redundancyThreshold: 0.78,
        maxUnits: 2400,
        maxOutputChars: 160000,
        includeNotice: true,
        countTokens: null
    });

    const STOP = new Set((
        "a,an,the,and,or,but,if,then,than,so,such,as,of,in,on,at,to,for,from,by,with,without,into,over,after,before,between,about,under,above,is,are,was,were,be,been,being,am,do,does,did,doing,have,has,had,having,can,could,should,would,will,shall,may,might,must,this,that,these,those,it,its,they,them,their,he,she,his,her,we,our,you,your,i,my,me,us,who,whom,which,what,when,where,why,how,not,no,yes,only,just,also,very,quite,really,actually,basically,simply,more,most,some,any,all,each,other,another,same,own,such,than,too,again,further,once,here,there,whenever,wherever,however,therefore,thus,hence,moreover,furthermore,meanwhile,otherwise,instead,though,although,because,since,while,whether,within,among,per,via,etc,eg,ie,vs"
    ).split(","));

    const BULLET_RE = /^[\u2022\u25e6\u25aa\u2023\u2043\u2219•*+\-\u00ab\u00bb\u2039\u203a]\s*/;
    const HEADING_RE = /^(#{1,6})\s+(.*)$/;
    const NUMBERED_HEADING_RE = /^(\d{1,2}(?:\.\d+)?)[.)]?\s+([A-Z][^\n]{1,90})$/;
    const QA_RE = /^(Q\d+[.)])\s*([\s\S]*)$/i;
    const TABLE_ROW_RE = /^\|(.+)\|$/;

    function cleanSpace(value) {
        return String(value || "")
            .replace(/\u00a0/g, " ")
            .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
            .replace(/[\u00ad]/g, "")
            .replace(/[ \t]+/g, " ")
            .replace(/ *\n */g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    function normalizeUnicode(value) {
        let text = String(value || "");
        try { text = text.normalize("NFC"); } catch { /* ignore */ }
        return text
            .replace(/\ufb00/g, "ff")
            .replace(/\ufb01/g, "fi")
            .replace(/\ufb02/g, "fl")
            .replace(/\ufb03/g, "ffi")
            .replace(/\ufb04/g, "ffl")
            .replace(/\ufb05/g, "st")
            .replace(/\ufb06/g, "st");
    }

    function fallbackCountTokens(text) {
        return Math.max(1, Math.ceil(String(text || "").length / 4));
    }

    function makeCounter(counter) {
        if (typeof counter === "function") {
            return (text) => {
                try {
                    const value = counter(text);
                    if (Array.isArray(value)) return Math.max(1, value.length);
                    if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.round(value));
                    return fallbackCountTokens(text);
                } catch {
                    return fallbackCountTokens(text);
                }
            };
        }
        return fallbackCountTokens;
    }

    function contentWords(text) {
        const words = normalizeUnicode(text)
            .toLowerCase()
            .replace(/[^\p{L}\p{N}%°]+/gu, " ")
            .split(/\s+/)
            .filter(word => word.length > 1 && !STOP.has(word));
        return words.map(word => {
            if (/^\d+(?:\.\d+)?$/.test(word)) return word;
            return word
                .replace(/(?:ization|isation)$/i, "ize")
                .replace(/(?:ational)$/i, "ate")
                .replace(/(?:ingly|edly)$/i, "")
                .replace(/(?:ing|ed|es|s)$/i, "");
        }).filter(Boolean);
    }

    function wordSet(text) {
        return new Set(contentWords(text));
    }

    function similarity(a, b) {
        if (!a || !b || !a.size || !b.size) return 0;
        let intersection = 0;
        for (const word of a) if (b.has(word)) intersection += 1;
        return intersection / Math.max(1, Math.min(a.size, b.size));
    }

    function hasNumber(text) {
        return /(?:\b\d+(?:[.,]\d+)?\b|[₹$€£]\s?\d)/.test(text);
    }

    function hasUnit(text) {
        return /\b\d+(?:[.,]\d+)?\s*(?:%|°C|°F|ppm|ppb|s|ms|seconds?|minutes?|hours?|days?|MB|GB|KB|TB|kg|g|mg|km|m|cm|mm|W|kW|MW|V|A|Hz|kHz|MHz|Pa|hPa|psi)(?![A-Za-z0-9])/i.test(text);
    }

    function hasFormula(text) {
        return /(?:[=<>≤≥×÷Σ≈]|\b(?:plus|minus|divided by|multiplied by)\b)/i.test(text) && /[A-Za-z0-9]/.test(text);
    }

    function hasWarning(text) {
        return /\b(?:do not|don't|does not|doesn't|did not|didn't|must not|mustn't|should not|shouldn't|never|cannot|can't|won't|wouldn't|couldn't|not establish|not prove|not claim|no guarantee|guarantee|limitation|limitations|avoid|unless|except|false alarm|false alarms|false positive|false positives|false negative|false negatives|important)\b/i.test(text);
    }

    function hasDefinition(text) {
        return /^(?:[A-Z][\p{L}\p{N} /()&.'’+-]{1,38})\s+(?:is|are)\s+(?:a|an)\s+\S+/u.test(text)
            || /\b(?:means|refers to|stands for|defined as|is called|are called)\b/i.test(text);
    }

    function hasKeyFact(text) {
        return hasUnit(text) || hasFormula(text) || hasWarning(text) || hasDefinition(text);
    }

    function hasContext(text) {
        return /\b(?:in this|in the)\s+(?:experiment|project|report|simulation|study|implementation)\b|\b(?:represented as|acts as|serves as|used for|intended for|responsible for|designed to)\b/i.test(text);
    }

    function splitSentences(text) {
        let value = normalizeUnicode(text).replace(/\s+/g, " ").trim();
        if (!value) return [];
        const protectedBits = [];
        const protect = (match) => {
            protectedBits.push(match);
            return `\u0000${protectedBits.length - 1}\u0000`;
        };
        value = value
            .replace(/\b(?:e\.g|i\.e|vs|etc|Fig|No|Dr|Mr|Mrs|Ms|Prof|approx|cf|al)\./gi, protect)
            .replace(/\b([A-Z])\.(?=\s*[A-Z][a-z])/g, protect)
            .replace(/(\d)\.(\d)/g, "$1\u0001$2")
            .replace(/\b(https?:\/\/[^\s]+)/gi, protect);
        const parts = value.split(/(?<=[.!?])\s+(?=[A-Z0-9“"'(•\u2022])/g);
        return parts.map(part => part
            .replace(/\u0001/g, ".")
            .replace(/\u0000(\d+)\u0000/g, (_, index) => protectedBits[Number(index)])
            .trim()
        ).filter(part => part && /[\p{L}\p{N}]/u.test(part));
    }

    function parseMarkdown(text) {
        const blocks = [];
        const lines = normalizeUnicode(text).replace(/\r\n?/g, "\n").split("\n");
        let paragraph = [];
        const flush = () => {
            if (!paragraph.length) return;
            blocks.push({ type: "p", text: cleanSpace(paragraph.join(" ")) });
            paragraph = [];
        };
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) { flush(); continue; }
            const heading = line.match(HEADING_RE);
            if (heading) {
                flush();
                blocks.push({ type: `h${Math.min(4, heading[1].length)}`, text: cleanSpace(heading[2]) });
                continue;
            }
            if (BULLET_RE.test(line)) {
                flush();
                blocks.push({ type: "li", text: cleanSpace(line.replace(BULLET_RE, "")) });
                continue;
            }
            const row = line.match(TABLE_ROW_RE);
            if (row) {
                flush();
                const cells = row[1].split("|").map(cell => cleanSpace(cell));
                if (cells.every(cell => /^:?-{2,}:?$/.test(cell))) continue;
                blocks.push({ type: "table-row", cells });
                continue;
            }
            const qa = line.match(QA_RE);
            if (qa) {
                flush();
                const rest = qa[2];
                const mark = rest.indexOf("?");
                if (mark >= 0) {
                    blocks.push({
                        type: "qa",
                        question: cleanSpace(`${qa[1]} ${rest.slice(0, mark + 1)}`),
                        answer: cleanSpace(rest.slice(mark + 1))
                    });
                } else {
                    blocks.push({ type: "qa", question: cleanSpace(line), answer: "" });
                }
                continue;
            }
            paragraph.push(line);
        }
        flush();
        return groupTableRows(blocks);
    }

    function groupTableRows(blocks) {
        const out = [];
        let current = null;
        for (const block of blocks) {
            if (block.type === "table-row") {
                if (!current) { current = { type: "table", rows: [] }; out.push(current); }
                current.rows.push(block.cells);
            } else {
                current = null;
                out.push(block);
            }
        }
        return out;
    }

    function parsePlainText(text) {
        const value = normalizeUnicode(text)
            .replace(/^={3,}\s*PAGE\s+\d+\s*={3,}$/gim, "")
            .replace(/^---+\s*page\s+\d+\s*---+$/gim, "")
            .replace(/\r\n?/g, "\n");
        const rawLines = value.split("\n").map(line => cleanSpace(line));
        const lines = [];
        for (const line of rawLines) {
            if (!line) { lines.push(""); continue; }
            lines.push(line);
        }

        // Repeated running headers/footers: "Title ... Page 3" on every page.
        const counts = new Map();
        for (const line of lines) {
            if (!line || line.length > 140) continue;
            const key = line.toLowerCase().replace(/\bpage\s*\d+\b/g, "page #").replace(/\d+/g, "#").replace(/[^a-z#]+/g, " ").trim();
            if (key) counts.set(key, (counts.get(key) || 0) + 1);
        }
        const dropped = new Set([...counts].filter(([key, count]) => count >= 3 && key.replace(/#/g, "").trim().length >= 8).map(([key]) => key));

        const blocks = [];
        let paragraph = [];
        const flush = () => {
            if (!paragraph.length) return;
            blocks.push({ type: "p", text: cleanSpace(paragraph.join(" ")) });
            paragraph = [];
        };
        for (const line of lines) {
            if (!line) { flush(); continue; }
            const key = line.toLowerCase().replace(/\bpage\s*\d+\b/g, "page #").replace(/\d+/g, "#").replace(/[^a-z#]+/g, " ").trim();
            if (dropped.has(key) || /^(?:page\s*)?\d+(?:\s*\/\s*\d+)?$/i.test(line)) continue;
            const heading = line.match(HEADING_RE);
            if (heading) {
                flush();
                blocks.push({ type: `h${Math.min(4, heading[1].length)}`, text: cleanSpace(heading[2]) });
                continue;
            }
            if (BULLET_RE.test(line)) {
                flush();
                blocks.push({ type: "li", text: cleanSpace(line.replace(BULLET_RE, "")) });
                continue;
            }
            const numbering = line.match(NUMBERED_HEADING_RE);
            if (numbering && line.length <= 110 && !/[.!?].*[.!?]/.test(line.slice(numbering[1].length))) {
                flush();
                blocks.push({ type: numbering[1].includes(".") ? "h2" : "h1", text: line });
                continue;
            }
            const qa = line.match(QA_RE);
            if (qa) {
                flush();
                const rest = qa[2];
                const mark = rest.indexOf("?");
                if (mark >= 0) {
                    blocks.push({
                        type: "qa",
                        question: cleanSpace(`${qa[1]} ${rest.slice(0, mark + 1)}`),
                        answer: cleanSpace(rest.slice(mark + 1))
                    });
                } else {
                    blocks.push({ type: "qa", question: cleanSpace(line), answer: "" });
                }
                continue;
            }
            paragraph.push(line);
        }
        flush();
        const grouped = groupTableRows(blocks);
        return splitLongQa(grouped);
    }

    function splitLongQa(blocks) {
        const out = [];
        for (const block of blocks) {
            if (block.type === "qa" && !block.answer) {
                out.push(block);
                continue;
            }
            if (block.type !== "qa" || !/\bQ\d+\./.test(block.answer)) { out.push(block); continue; }
            out.push({ ...block, answer: block.answer.split(/(?=\bQ\d+\.\s)/)[0] });
            const rest = block.answer.split(/(?=\bQ\d+\.\s)/).slice(1);
            for (const part of rest) {
                const match = part.match(/^(Q\d+[.)])\s*([\s\S]*)$/i);
                if (!match) continue;
                const mark = match[2].indexOf("?");
                if (mark >= 0) out.push({ type: "qa", question: cleanSpace(`${match[1]} ${match[2].slice(0, mark + 1)}`), answer: cleanSpace(match[2].slice(mark + 1)) });
                else out.push({ type: "qa", question: cleanSpace(part), answer: "" });
            }
        }
        return out;
    }

    function normalizeBlocks(input, options) {
        if (Array.isArray(input)) return input;
        if (input && Array.isArray(input.blocks)) return input.blocks;
        if (input && typeof input === "object" && typeof input.structured === "string") {
            return parseMarkdown(input.structured);
        }
        const text = String(input || "");
        if (/^#{1,6}\s+/m.test(text) || /^\|.+\|/m.test(text)) return parseMarkdown(text);
        return parsePlainText(text);
    }

    function buildSections(blocks) {
        const sections = [];
        let current = { heading: null, blocks: [] };
        for (const block of blocks) {
            if (!block || !block.type) continue;
            if (block.type === "h1" || block.type === "h2" || block.type === "h3" || block.type === "h4") {
                if (!current.heading && !current.blocks.length && !sections.length) {
                    current.heading = block;
                } else if (!current.heading && !current.blocks.length) {
                    current.heading = block;
                } else {
                    sections.push(current);
                    current = { heading: block, blocks: [] };
                }
            } else {
                current.blocks.push(block);
            }
        }
        if (current.heading || current.blocks.length) sections.push(current);
        return sections;
    }

    function buildUnits(sections) {
        const units = [];
        let order = 0;
        sections.forEach((section, sectionIndex) => {
            if (section.heading) {
                units.push({
                    id: `h${order}`,
                    kind: "h",
                    sectionIndex,
                    blockId: `b${order}`,
                    sentenceIndex: 0,
                    text: section.heading.text,
                    level: section.heading.type,
                    protected: true,
                    order: order++
                });
            }
            section.blocks.forEach((block, blockIndex) => {
                const blockId = `s${sectionIndex}b${blockIndex}`;
                if (block.type === "li") {
                    units.push({ id: `u${order}`, kind: "li", sectionIndex, blockId, sentenceIndex: 0, text: block.text.replace(BULLET_RE, ""), protected: true, order: order++ });
                } else if (block.type === "table") {
                    units.push({ id: `u${order}`, kind: "table", sectionIndex, blockId, sentenceIndex: 0, rows: block.rows || [], header: block.table?.header === true, text: (block.rows || []).map(row => row.join(" | ")).join("\n"), protected: true, order: order++ });
                } else if (block.type === "qa") {
                    const qaId = `q${order}`;
                    units.push({ id: `u${order}`, kind: "q", sectionIndex, blockId, sentenceIndex: 0, qaId, text: block.question, protected: true, order: order++ });
                    const answers = splitSentences(block.answer || "");
                    answers.forEach((sentence, index) => {
                        units.push({ id: `u${order}`, kind: "a", sectionIndex, blockId, sentenceIndex: index, qaId, text: sentence, protected: true, order: order++ });
                    });
                    if (!answers.length) units.push({ id: `u${order}`, kind: "a", sectionIndex, blockId, sentenceIndex: 0, qaId, text: "", protected: true, order: order++ });
                } else if (block.type === "p") {
                    const sentences = splitSentences(block.text);
                    sentences.forEach((sentence, index) => {
                        units.push({
                            id: `u${order}`,
                            kind: "p",
                            sectionIndex,
                            blockId,
                            sentenceIndex: index,
                            text: sentence,
                            protected: hasUnit(sentence) || hasFormula(sentence) || hasWarning(sentence),
                            order: order++
                        });
                    });
                }
            });
        });
        return units;
    }

    function compactText(text, options = {}) {
        const sentence = options.sentence !== false;
        let value = normalizeUnicode(text).replace(/\s+/g, " ").trim();
        if (!value) return "";
        const question = /\?$/.test(value);
        const phrases = [
            [/\bin order to\b/gi, "to"],
            [/\bdue to the fact that\b/gi, "because"],
            [/\bfor the reason that\b/gi, "because"],
            [/\bfor the purpose of\b/gi, "to"],
            [/\bin the event that\b/gi, "if"],
            [/\bprior to\b/gi, "before"],
            [/\bsubsequent to\b/gi, "after"],
            [/\bwith regard to\b/gi, "about"],
            [/\bwith respect to\b/gi, "about"],
            [/\bin terms of\b/gi, "for"],
            [/\bat this point in time\b/gi, "now"],
            [/\bin the near future\b/gi, "soon"],
            [/\bon a daily basis\b/gi, "daily"],
            [/\bdespite the fact that\b/gi, "although"],
            [/\bin spite of the fact that\b/gi, "although"],
            [/\bis able to\b/gi, "can"],
            [/\bhas the ability to\b/gi, "can"],
            [/\bmake use of\b/gi, "use"],
            [/\ba large number of\b/gi, "many"],
            [/\ba small number of\b/gi, "few"],
            [/\bthe majority of\b/gi, "most"],
            [/\ba majority of\b/gi, "most"],
            [/\ba number of\b/gi, "several"],
            [/\bit is important to note that\b/gi, "note: "],
            [/\bit should be noted that\b/gi, "note: "],
            [/\bas mentioned earlier,?\s*/gi, ""],
            [/\bin other words,?\s*/gi, ""],
            [/\bthat is to say,?\s*/gi, ""],
            [/\bthis means that\b/gi, ""],
            [/\bnote that\b/gi, ""],
            [/\bapproximately\b/gi, "~"],
            [/\bpercent\b/gi, "%"],
            [/\bseconds\b/gi, "s"],
            [/\bversus\b/gi, "vs"],
            [/\bfor example,?\s*/gi, "e.g. "],
            [/\bsuch as\b/gi, "e.g."],
            [/\band so on\b/gi, "etc."],
            [/\bdoes not\b/gi, "doesn't"],
            [/\bdo not\b/gi, "don't"],
            [/\bdid not\b/gi, "didn't"],
            [/\bis not\b/gi, "isn't"],
            [/\bare not\b/gi, "aren't"],
            [/\bwas not\b/gi, "wasn't"],
            [/\bwere not\b/gi, "weren't"],
            [/\bcannot\b/gi, "can't"],
            [/\bwill not\b/gi, "won't"],
            [/\bwould not\b/gi, "wouldn't"],
            [/\bshould not\b/gi, "shouldn't"],
            [/\bcould not\b/gi, "couldn't"],
            [/\bhave not\b/gi, "haven't"],
            [/\bhas not\b/gi, "hasn't"],
            [/\bhad not\b/gi, "hadn't"],
            [/\bit is\b/gi, "it's"],
            [/\bthat is\b/gi, "that's"],
            [/\bthere is\b/gi, "there's"],
            [/\bthey are\b/gi, "they're"],
            [/\bwe are\b/gi, "we're"],
            [/\byou are\b/gi, "you're"],
            [/\bbasically\b/gi, ""]
        ];
        for (const [pattern, replacement] of phrases) value = value.replace(pattern, replacement);

        // Dense definition forms: "IoT is a network ..." -> "IoT: network ..."
        // Questions keep their wording; they are not definitions.
        if (sentence && !question) {
            const rewriteDefinition = (match, subject, predicate, separator) => {
                const raw = subject.trim();
                if (/\b(?:is|are|was|were|be|been|being|means|refers|stands|that|which|who)\b/i.test(raw)) return match;
                if (/^(?:This|It|There|These|Those|He|She|They|We|You|I|What|Which|Who|Why|How|When|Where|Is|Are|Can|Could|Does|Do|Did|Will|Would|Should|Has|Have)$/i.test(raw)) return match;
                const trimmed = raw.replace(/^(?:The|A|An)\s+/i, "").trim();
                if (!trimmed) return match;
                return `${trimmed}${separator}${predicate}`;
            };
            value = value.replace(/^([A-Z][\p{L}\p{N} /()&.'’+-]{1,46})\s+is\s+(?:a|an)\s+(.+)$/u,
                (match, subject, predicate) => rewriteDefinition(match, subject, predicate, ": "));
            value = value.replace(/^([A-Z][\p{L}\p{N} /()&.'’+-]{1,46})\s+(?:means|refers to|stands for)\s+(.+)$/u,
                (match, subject, predicate) => rewriteDefinition(match, subject, predicate, " = "));
            value = value.replace(/^(Benefits|Advantages|Objectives|Components|Ways|Strategies|Metrics|Limitations|Symptoms|Causes)\s+include\s+(.+)$/iu, "$1: $2");
            value = value.replace(/^(.{2,52})\s+includes\s+(.+)$/u, "$1: $2");
        }

        // Compact list punctuation and spacing. A dot followed by a letter is
        // a file extension or decimal, not a sentence boundary.
        value = value.replace(/,\s+and\s+/gi, ", ");
        value = value.replace(/\s+([,;:!?])/g, "$1");
        value = value.replace(/\s+\.(?=\s|$)/g, ".");
        value = value.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
        value = value.replace(/\s{2,}/g, " ").trim();
        if (sentence && /^[a-z]/.test(value) && !/^[a-z][A-Z]/.test(value)) {
            value = value.charAt(0).toUpperCase() + value.slice(1);
        }
        if (sentence && !/[.!?]$/.test(value) && value.split(/\s+/).length > 3) value += ".";
        return value;
    }

    function extractFacts(text) {
        const facts = [];
        const seen = new Set();
        const add = (value, sentence) => {
            const clean = cleanSpace(value);
            const key = clean.toLowerCase().replace(/\s+/g, " ");
            if (!key || seen.has(key)) return;
            seen.add(key);
            facts.push({ value: clean, sentence: cleanSpace(sentence || "") });
        };
        const sentences = splitSentences(text);
        const patterns = [
            /[₹$€£]\s?\d[\d,.]*(?:\s?(?:crore|lakh|million|billion|k|m))?/gi,
            /\b\d+(?:[.,]\d+)?\s*(?:%|°C|°F|ppm|ppb|s|ms|seconds?|minutes?|hours?|days?|MB|GB|KB|TB|kg|g|mg|km|m|cm|mm|W|kW|MW|V|A|Hz|kHz|MHz|Pa|hPa|psi)(?![A-Za-z0-9])/gi,
            /\b\d+\.\d+\b/g,
            /\b[A-Z]{2,}-\d[\w-]*\b/g,
            /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g
        ];
        for (const sentence of sentences) {
            for (const pattern of patterns) {
                pattern.lastIndex = 0;
                let match;
                while ((match = pattern.exec(sentence)) !== null) {
                    add(match[0], sentence);
                }
            }
            const equations = sentence.match(/[A-Za-z_][A-Za-z0-9_]*(?:\s*[=<>≤≥]\s*[^.;\n]+)+/g) || [];
            for (const equation of equations) add(equation, sentence);
        }
        return facts;
    }

    function canonFact(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/\u00a0/g, " ")
            .replace(/\bseconds?\b/g, "s")
            .replace(/\bsecs?\b/g, "s")
            .replace(/\bmilliseconds?\b/g, "ms")
            .replace(/\bminutes?\b/g, "min")
            .replace(/\bhours?\b/g, "h")
            .replace(/\bkilobytes?\b/g, "kb")
            .replace(/\bmegabytes?\b/g, "mb")
            .replace(/\bgigabytes?\b/g, "gb")
            .replace(/\bterabytes?\b/g, "tb")
            .replace(/\bkilowatts?\b/g, "kw")
            .replace(/\bmegawatts?\b/g, "mw")
            .replace(/\bwatts?\b/g, "w")
            .replace(/(\d)\s+(?=(?:s|ms|min|h|%|°c|°f|ppm|ppb|mb|gb|kb|tb|kg|mg|km|cm|mm|w|kw|mw|v|hz|khz|mhz|pa|hpa|psi)\b)/g, "$1")
            .replace(/\s+/g, " ")
            .trim();
    }

    function factPresent(fact, text) {
        const haystack = canonFact(text);
        const needle = canonFact(fact);
        if (!needle) return true;
        if (haystack.includes(needle)) return true;
        // Formulas survive compaction even when filler words change. If every
        // number and operator is still present, the formula is intact.
        if (/[=<>≤≥×÷Σ≈]/.test(needle)) {
            const numbers = needle.match(/\d+(?:\.\d+)?/g) || [];
            const operators = needle.match(/[=<>≤≥×÷Σ≈]/g) || [];
            if (numbers.every(value => haystack.includes(value)) && operators.every(op => haystack.includes(op))) return true;
        }
        const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        try {
            return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "iu").test(haystack);
        } catch {
            return haystack.includes(needle);
        }
    }

    function scoreUnits(units, options) {
        const counter = options.countTokens;
        const docFreq = new Map();
        const contentUnits = units.filter(unit => unit.kind === "p" || unit.kind === "a");
        for (const unit of contentUnits) {
            unit.words = wordSet(unit.text);
            for (const word of unit.words) docFreq.set(word, (docFreq.get(word) || 0) + 1);
        }
        const total = Math.max(1, contentUnits.length);
        for (const unit of contentUnits) {
            let score = 0;
            for (const word of unit.words) {
                const df = docFreq.get(word) || 1;
                score += Math.log((total + 1) / (df + 1)) + 1;
            }
            unit.tokens = counter(compactText(unit.text));
            score /= Math.sqrt(Math.max(2, unit.words.size));
            if (unit.sentenceIndex === 0) score += 0.28;
            if (unit.kind === "a") score += 0.08;
            if (unit.tokens > 48) score -= 0.12;
            if (unit.tokens < 7) score -= 0.08;
            unit.score = score;
        }
        return contentUnits;
    }

    function chooseUnits(units, options) {
        const counter = options.countTokens;
        const inputTokens = options.tokensIn;
        const target = Math.max(300, Math.floor(inputTokens * options.targetRatio));
        const minimum = Math.min(target, Math.max(240, Math.floor(inputTokens * options.minRatio)));
        const selected = [];
        const selectedIds = new Set();
        let used = 0;

        for (const unit of units) {
            if (!unit.protected) continue;
            if (unit.kind === "a" && !unit.text) continue;
            selected.push(unit);
            selectedIds.add(unit.id);
            used += unit.tokens || counter(compactText(unit.text));
        }

        const selectedSets = selected.map(unit => unit.words || wordSet(unit.text));
        const candidates = units
            .filter(unit => !unit.protected && !selectedIds.has(unit.id) && (unit.kind === "p" || unit.kind === "a"))
            .sort((a, b) => (b.score || 0) - (a.score || 0) || a.order - b.order);

        const maxSimilarity = (unit) => {
            let best = 0;
            for (const set of selectedSets) best = Math.max(best, similarity(unit.words || wordSet(unit.text), set));
            return best;
        };

        for (const unit of candidates) {
            if (used >= target) break;
            const tokens = unit.tokens || counter(compactText(unit.text));
            if (used + tokens > target) continue;
            if (maxSimilarity(unit) >= options.redundancyThreshold) continue;
            selected.push(unit);
            selectedIds.add(unit.id);
            selectedSets.push(unit.words || wordSet(unit.text));
            used += tokens;
        }

        // If protection left us below the floor, add the best remaining
        // candidates without the redundancy veto.
        if (used < minimum) {
            for (const unit of candidates) {
                if (used >= minimum) break;
                if (selectedIds.has(unit.id)) continue;
                const tokens = unit.tokens || counter(compactText(unit.text));
                selected.push(unit);
                selectedIds.add(unit.id);
                used += tokens;
            }
        }

        // A heading with no body reads like a broken document. For each leaf
        // section that lost all prose, keep its first sentence as a lead.
        let leads = 0;
        const sections = options.sections || [];
        sections.forEach((section, index) => {
            if (!section.heading) return;
            const level = Number(String(section.heading.type || "h1").slice(1)) || 1;
            const next = sections[index + 1];
            const nextLevel = next?.heading ? (Number(String(next.heading.type || "h1").slice(1)) || 1) : 0;
            if (nextLevel > level) return; // parent heading with child sections
            if (selected.some(unit => unit.sectionIndex === index && unit.kind !== "h")) return;
            const lead = units.find(unit => unit.sectionIndex === index && unit.kind === "p" && !selectedIds.has(unit.id));
            if (!lead) return;
            selected.push(lead);
            selectedIds.add(lead.id);
            used += lead.tokens || counter(compactText(lead.text));
            lead.sectionLead = true;
            leads += 1;
        });

        selected.sort((a, b) => a.order - b.order);
        return { selected, used, target, minimum, leads };
    }

    function renderUnits(selected, sections, options) {
        const out = [];
        const heading = { h1: "#", h2: "##", h3: "###", h4: "####" };
        const bySection = new Map();
        for (const unit of selected) {
            if (!bySection.has(unit.sectionIndex)) bySection.set(unit.sectionIndex, []);
            bySection.get(unit.sectionIndex).push(unit);
        }

        if (options.includeNotice) {
            const notice = options.notice || "[Compressed PDF text — headings, numbers, formulas, warnings, and Q&A preserved.]";
            out.push(notice, "");
        }

        sections.forEach((section, sectionIndex) => {
            const sectionUnits = bySection.get(sectionIndex) || [];
            if (!sectionUnits.length) return;
            const headingUnit = sectionUnits.find(unit => unit.kind === "h");
            if (headingUnit) {
                out.push(`${heading[headingUnit.level] || "##"} ${compactText(headingUnit.text, { sentence: false })}`, "");
            }
            let paragraph = [];
            let qa = null;
            const flushParagraph = () => {
                if (paragraph.length) {
                    out.push(paragraph.join(" "));
                    paragraph = [];
                }
            };
            const flushQa = () => {
                if (!qa) return;
                out.push(qa.question);
                if (qa.answer.length) out.push(`A: ${qa.answer.join(" ")}`);
                qa = null;
            };
            for (const unit of sectionUnits) {
                if (unit.kind === "h") continue;
                if (unit.kind === "p") {
                    flushQa();
                    if (!paragraph.length || paragraph.blockId !== unit.blockId) {
                        flushParagraph();
                        paragraph = [];
                        paragraph.blockId = unit.blockId;
                    }
                    paragraph.push(compactText(unit.text));
                } else if (unit.kind === "a") {
                    flushParagraph();
                    if (!qa || qa.qaId !== unit.qaId) {
                        flushQa();
                        qa = { qaId: unit.qaId, question: "", answer: [] };
                    }
                    if (unit.text) qa.answer.push(compactText(unit.text));
                } else if (unit.kind === "q") {
                    flushParagraph();
                    flushQa();
                    qa = { qaId: unit.qaId, question: compactText(unit.text, { sentence: false }), answer: [] };
                } else if (unit.kind === "li") {
                    flushParagraph();
                    flushQa();
                    out.push(`- ${compactText(unit.text, { sentence: false })}`);
                } else if (unit.kind === "table") {
                    flushParagraph();
                    flushQa();
                    const rows = unit.rows || [];
                    rows.forEach((row, index) => {
                        out.push(`| ${row.map(cell => compactText(cell, { sentence: false })).join(" | ")} |`);
                        if (index === 0 && unit.header) out.push(`| ${row.map(() => "---").join(" | ")} |`);
                    });
                }
            }
            flushParagraph();
            flushQa();
            if (out[out.length - 1] !== "") out.push("");
        });
        return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    function auditFacts(output, sourceText, options) {
        const facts = extractFacts(sourceText);
        const missing = facts.filter(fact => !factPresent(fact.value, output));
        if (!missing.length) return { total: facts.length, kept: facts.length, appended: 0, missing: [] };
        const extra = [];
        const seen = new Set();
        for (const fact of missing) {
            if (fact.sentence.includes("|")) continue;
            const sentence = compactText(fact.sentence);
            const key = sentence.toLowerCase();
            if (!sentence || sentence.length > 300 || seen.has(key)) continue;
            seen.add(key);
            extra.push(`- ${sentence}`);
            if (extra.length >= 40) break;
        }
        if (!extra.length) return { total: facts.length, kept: facts.length - missing.length, appended: 0, missing: missing.map(f => f.value) };
        const text = `${output}\n\n## Key facts kept from the source\n${extra.join("\n")}`;
        return { total: facts.length, kept: facts.length, appended: extra.length, missing: [] , text };
    }

    function compress(input, options = {}) {
        const opts = { ...DEFAULTS, ...options };
        opts.countTokens = makeCounter(opts.countTokens);
        const blocks = normalizeBlocks(input, opts);
        if (!blocks.length) {
            return { text: "", tokensIn: 0, tokensOut: 0, savedPct: 0, ratio: 0, sections: 0, facts: { total: 0, kept: 0, appended: 0, missing: [] }, notes: ["No readable text."] };
        }
        const sourceText = options.sourceText || blocks.map(block => {
            if (block.type === "table") return (block.rows || []).map(row => row.join(" | ")).join("\n");
            if (block.type === "qa") return `${block.question || ""} ${block.answer || ""}`.trim();
            return block.text || "";
        }).filter(Boolean).join("\n\n");
        const tokensIn = Number(options.tokensIn) || opts.countTokens(sourceText);
        const sections = buildSections(blocks);
        const units = buildUnits(sections).slice(0, opts.maxUnits);
        scoreUnits(units, opts);

        // Duplicate detection is limited to prose. Lists, tables, headings,
        // questions and every Q&A answer are already dense and always kept.
        const earlier = [];
        for (const unit of units) {
            if (unit.kind !== "p") continue;
            if (!unit.words || unit.words.size < 5) { earlier.push(unit); continue; }
            let duplicate = null;
            let best = 0;
            for (const other of earlier) {
                if (!other.words || other.words.size < 5) continue;
                const sim = similarity(unit.words, other.words);
                if (sim > best) { best = sim; duplicate = other; }
            }
            if (duplicate && best >= opts.dedupeThreshold) {
                const newFacts = [...unit.words].filter(word => /\d/.test(word) && !duplicate.words.has(word));
                if (!newFacts.length) {
                    unit.duplicateOf = duplicate.id;
                    unit.protected = false;
                }
            }
            earlier.push(unit);
        }

        const { selected, used, target, leads } = chooseUnits(units, { ...opts, tokensIn, sections });
        let text = renderUnits(selected, sections, opts);
        const sourceForAudit = options.sourceText || sourceText;
        const audit = auditFacts(text, sourceForAudit, opts);
        if (audit.text) text = audit.text;

        const tokensOut = opts.countTokens(text);
        const ratio = tokensIn > 0 ? tokensOut / tokensIn : 0;
        const notes = [];
        if (used > target) notes.push("protected facts exceeded the target; kept for fidelity");
        if (leads) notes.push(`${leads} section lead sentence(s) kept for readability`);
        if (audit.appended) notes.push(`re-attached ${audit.appended} fact sentence(s)`);
        if (tokensOut > Math.ceil(tokensIn * opts.maxRatio)) notes.push("output is above the requested ratio; facts were protected");
        if (text.length > opts.maxOutputChars) notes.push("output truncated at the character cap");
        if (text.length > opts.maxOutputChars) text = text.slice(0, opts.maxOutputChars);
        return {
            text,
            tokensIn,
            tokensOut,
            ratio: Number(ratio.toFixed(3)),
            savedPct: tokensIn ? Math.max(0, Math.round((1 - ratio) * 100)) : 0,
            sections: sections.length,
            units: units.length,
            kept: selected.length,
            target,
            facts: { total: audit.total, kept: audit.kept, appended: audit.appended, missing: audit.missing },
            notes
        };
    }

    return {
        COMPRESS_VERSION,
        compress,
        compressText: compress,
        compactText,
        splitSentences,
        extractFacts,
        parsePlainText,
        parseMarkdown,
        contentWords,
        similarity,
        hasNumber,
        hasUnit,
        hasFormula,
        hasWarning,
        hasDefinition,
        hasKeyFact,
        hasContext,
        buildSections,
        buildUnits,
        scoreUnits,
        chooseUnits,
        renderUnits,
        auditFacts
    };
}));

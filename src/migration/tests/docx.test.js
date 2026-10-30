const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const DOCX = require("../sir/docx.js");

// Minimal ZIP writer so the tests exercise real central-directory parsing and
// both entry methods (stored + deflate) without committing a binary fixture.
function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buffer.length; i += 1) {
        let c = (crc ^ buffer[i]) & 0xFF;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const file of files) {
        const name = Buffer.from(file.name);
        const data = Buffer.from(file.content);
        const method = file.method || 0;
        const payload = method === 8 ? zlib.deflateRawSync(data) : data;
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);

        locals.push(Buffer.concat([local, name, payload]));
        centrals.push(Buffer.concat([central, name]));
        offset += local.length + name.length + payload.length;
    }
    const directory = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(directory.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, eocd]);
}

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
  <w:p><w:r><w:t>IKO Word Test</w:t></w:r></w:p>
  <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>
  <w:p><w:r><w:t>Invoice: INV-2026-0042 &amp; GST 12.5%</w:t></w:r></w:p>
  <w:p><w:r><w:t>Item</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Price</w:t></w:r></w:p>
</w:body>
</w:document>`;

test("docxXmlToText keeps runs, paragraphs, entities and tabs", () => {
    const text = DOCX.docxXmlToText(DOCUMENT_XML);
    assert.ok(text.includes("IKO Word Test"));
    assert.ok(text.includes("Hello world"));
    assert.ok(text.includes("INV-2026-0042 & GST 12.5%"));
    assert.ok(text.includes("Item") && text.includes("Price"));
    assert.ok(!text.includes("<w:"), "markup must be stripped");
    assert.ok(text.split("\n").length >= 4, "paragraphs must become newlines");
});

test("extractDocxText reads a stored (method 0) word/document.xml", async () => {
    const zip = makeZip([
        { name: "[Content_Types].xml", content: "<Types/>" },
        { name: "word/document.xml", content: DOCUMENT_XML, method: 0 }
    ]);
    const text = await DOCX.extractDocxText(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));
    assert.ok(text.includes("Hello world"));
    assert.ok(text.includes("IKO Word Test"));
});

test("extractDocxText inflates a deflated (method 8) entry", async () => {
    const zip = makeZip([
        { name: "word/document.xml", content: DOCUMENT_XML, method: 8 }
    ]);
    const text = await DOCX.extractDocxText(zip);
    assert.ok(text.includes("INV-2026-0042"));
});

test("extractDocxText rejects non-zip input with a readable error", async () => {
    const buffer = Buffer.from("this is a legacy .doc or a text file");
    await assert.rejects(() => DOCX.extractDocxText(buffer), /Not a valid \.docx/);
});

test("extractDocxText reports a missing document part", async () => {
    const zip = makeZip([{ name: "word/styles.xml", content: "<styles/>" }]);
    await assert.rejects(() => DOCX.extractDocxText(zip), /word\/document\.xml not found/);
});

test("estimateWordTokens is a bounded fallback", () => {
    assert.equal(DOCX.estimateWordTokens(0), 500);
    assert.equal(DOCX.estimateWordTokens(18000), 1000);
    assert.ok(DOCX.estimateWordTokens(50000) > 500);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const OCR = require("../sir/ocr.js");
const SIR = require("../sir/sir.js");

function fakeImageData(w, h, fn) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const [r, g, b] = fn(x, y);
            const o = (y * w + x) * 4;
            data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
        }
    }
    return { width: w, height: h, data };
}

test("preprocess is deterministic + 2x + grayscale", () => {
    const src = fakeImageData(4, 2, (x) => [x * 60, 100, 200]);
    const a = OCR.preprocessImageData(src);
    const b = OCR.preprocessImageData(src);
    assert.equal(a.width, 8);
    assert.equal(a.height, 4);
    assert.deepEqual([...a.data], [...b.data]);
    // gray: r==g==b, alpha 255
    assert.equal(a.data[0], a.data[1]);
    assert.equal(a.data[1], a.data[2]);
    assert.equal(a.data[3], 255);
});

test("recognize without engine routes honestly (never garbage)", async () => {
    const src = fakeImageData(8, 8, () => [255, 255, 255]);
    const r = await OCR.recognize(src);
    assert.equal(r.text, "");
    assert.ok(["ocr-engine-missing", "ocr-empty", "ocr-failed"].includes(r.route));
    assert.equal(r.engine === "none" ? "none" : r.engine, r.engine);
});

test("peer engine plugs in universal interface", async () => {
    global.window = global.window || {};
    global.window.IKOOCR = global.window.IKOOCR || {};
    global.window.IKOOCR.peer = {
        recognize: async () => ({ text: "BUILDER robot headphones", confidence: 92 })
    };
    const src = fakeImageData(4, 4, () => [0, 0, 0]);
    const r = await OCR.recognize(src);
    assert.equal(r.route, "ocr-text");
    assert.ok(r.text.includes("BUILDER"));
    assert.ok(r.confidence > 0.9 && r.confidence <= 1);
    delete global.window.IKOOCR.peer;
});

test("scannedToSIR wraps OCR text in SIR with confidence", async () => {
    global.window = global.window || {};
    global.window.IKOOCR = global.window.IKOOCR || {};
    global.window.IKOOCR.peer = {
        recognize: async () => ({ text: "Invoice INV-1029 Total Rs.54000", confidence: 90 })
    };
    const src = fakeImageData(4, 4, () => [0, 0, 0]);
    const res = await OCR.scannedToSIR(src, { id: "scan1", title: "Scan" }, SIR);
    assert.equal(res.route, "sir");
    assert.ok(res.l3.includes("@DOC"));
    assert.ok(res.l3.includes("@CONF"));
    assert.ok(res.ocr.confidence > 0);
    delete global.window.IKOOCR.peer;
});

test("scannedToSIR marks low-confidence OCR in @CONF", async () => {
    global.window = global.window || {};
    global.window.IKOOCR = global.window.IKOOCR || {};
    global.window.IKOOCR.peer = {
        recognize: async () => ({ text: "blurry invoice 42", confidence: 65, lowConfidence: true })
    };
    const res = await OCR.scannedToSIR(fakeImageData(4, 4, () => [0, 0, 0]), {}, SIR);
    assert.equal(res.route, "sir");
    assert.ok(res.l3.includes("warning=low-confidence"));
    delete global.window.IKOOCR.peer;
});

test("bundled offscreen engine is used when no peer/global exists", async () => {
    global.chrome = {
        runtime: {
            id: "iko-test",
            sendMessage: async (message) => {
                assert.equal(message.type, "IKO_OCR_RECOGNIZE");
                assert.ok(message.image.startsWith("data:image/png;base64,"));
                return { success: true, text: "OFFSCREEN invoice 42", confidence: 88 };
            }
        }
    };
    const r = await OCR.recognize("data:image/png;base64,AAAA");
    assert.equal(r.route, "ocr-text");
    assert.equal(r.engine, "tesseract-offscreen");
    assert.ok(r.text.includes("OFFSCREEN"));
    assert.ok(r.confidence > 0.8 && r.confidence <= 1);
    delete global.chrome;
});

test("offscreen low-confidence results carry the warning through", async () => {
    global.chrome = {
        runtime: {
            id: "iko-test",
            sendMessage: async () => ({
                success: true,
                text: "blurry invoice 42",
                confidence: 65,
                lowConfidence: true,
                passes: [{ pass: "raw-psm3", confidence: 65, chars: 18 }]
            })
        }
    };
    const r = await OCR.recognize("data:image/png;base64,AAAA");
    assert.equal(r.route, "ocr-text");
    assert.equal(r.lowConfidence, true);
    assert.equal(r.passes.length, 1);
    assert.ok(r.confidence > 0.6 && r.confidence < 0.7);
    delete global.chrome;
});

test("offscreen failure is reported honestly", async () => {
    global.chrome = {
        runtime: {
            id: "iko-test",
            sendMessage: async () => ({ success: false, error: "worker failed" })
        }
    };
    const r = await OCR.recognize("data:image/png;base64,AAAA");
    assert.equal(r.route, "ocr-failed");
    assert.equal(r.engine, "tesseract-offscreen");
    assert.ok(r.error.includes("worker failed"));
    delete global.chrome;
});

test("empty OCR normalizes to ocr-empty, not fake text", async () => {
    global.window = global.window || {};
    global.window.IKOOCR = global.window.IKOOCR || {};
    global.window.IKOOCR.peer = { recognize: async () => ({ text: "   ", confidence: 10 }) };
    const src = fakeImageData(2, 2, () => [255, 255, 255]);
    const r = await OCR.recognize(src);
    assert.equal(r.route, "ocr-empty");
    delete global.window.IKOOCR.peer;
});

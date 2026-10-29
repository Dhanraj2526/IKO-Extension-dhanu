const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

function copyAsset(source, destination) {
    if (!fs.existsSync(source)) {
        throw new Error(`Missing build asset: ${source}. Run npm install first.`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
}

async function build() {
    fs.mkdirSync("dist", {
        recursive: true
    });

    // Existing ChatGPT build — unchanged
    await esbuild.build({
        entryPoints: ["src/content/main.js"],
        bundle: true,
        format: "iife",
        outfile: "dist/content.js",
        target: ["chrome120"],
        sourcemap: false
    });

    // Claude content scripts combined through claude-entry.js
    await esbuild.build({
        entryPoints: ["src/content/claude-entry.js"],
        bundle: true,
        format: "iife",
        outfile: "dist/claude-content.js",
        target: ["chrome120"],
        sourcemap: false
    });

    // Claude MAIN-world bridge
    await esbuild.build({
        entryPoints: ["src/injected/claude-bridge.js"],
        bundle: true,
        format: "iife",
        outfile: "dist/claude-bridge.js",
        target: ["chrome120"],
        sourcemap: false
    });

    // ChatGPT MAIN-world bridge (backend-api capture)
    await esbuild.build({
        entryPoints: ["src/injected/chatgpt-bridge.js"],
        bundle: true,
        format: "iife",
        outfile: "dist/chatgpt-bridge.js",
        target: ["chrome120"],
        sourcemap: false
    });

    // One-click Session Migration
    await esbuild.build({
        entryPoints: ["src/content/migration/migration-entry.js"],
        bundle: true,
        format: "iife",
        outfile: "dist/migration.js",
        target: ["chrome120"],
        sourcemap: false
    });

    // Copy main stylesheet
    const cssSource = path.join(
        "src",
        "content",
        "style.css"
    );

    const cssDestination = path.join(
        "dist",
        "style.css"
    );

    if (fs.existsSync(cssSource)) {
        fs.copyFileSync(
            cssSource,
            cssDestination
        );
    }

    // Copy migration stylesheet
    const migrationCssSource = path.join(
        "src",
        "content",
        "migration",
        "migration.css"
    );

    const migrationCssDestination = path.join(
        "dist",
        "migration.css"
    );

    if (fs.existsSync(migrationCssSource)) {
        fs.copyFileSync(
            migrationCssSource,
            migrationCssDestination
        );
    }

    // Bundled OCR engine — Tesseract.js, its WASM core, and the English
    // traineddata all ship inside the extension. No CDN/remote code.
    const tesseractDist = path.join("node_modules", "tesseract.js", "dist");
    const tesseractVendor = path.join("dist", "vendor", "tesseract");
    copyAsset(
        path.join(tesseractDist, "tesseract.min.js"),
        path.join(tesseractVendor, "tesseract.min.js")
    );
    copyAsset(
        path.join(tesseractDist, "worker.min.js"),
        path.join(tesseractVendor, "worker.min.js")
    );
    copyAsset(
        path.join(tesseractDist, "tesseract.min.js.LICENSE.txt"),
        path.join(tesseractVendor, "LICENSE-tesseract.js.txt")
    );
    copyAsset(
        path.join("node_modules", "tesseract.js-core", "tesseract-core-lstm.wasm.js"),
        path.join(tesseractVendor, "tesseract-core-lstm.wasm.js")
    );
    copyAsset(
        path.join("node_modules", "tesseract.js-core", "LICENSE"),
        path.join(tesseractVendor, "LICENSE-tesseract.js-core.txt")
    );
    copyAsset(
        path.join("node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int", "eng.traineddata.gz"),
        path.join(tesseractVendor, "lang", "eng.traineddata.gz")
    );

    console.log(
        "IKO GPT, Claude, bridge, migration, and OCR builds completed."
    );
}

build().catch((error) => {
    console.error(error);
    process.exit(1);
});
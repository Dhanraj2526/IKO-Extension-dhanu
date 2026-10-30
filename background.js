"use strict";

const DESTINATIONS = Object.freeze({
    claude: "https://claude.ai/new",
    chatgpt: "https://chatgpt.com/",
    gemini: "https://gemini.google.com/",
    perplexity: "https://www.perplexity.ai/",
    copilot: "https://copilot.microsoft.com/",
    grok: "https://grok.com/",
    deepseek: "https://chat.deepseek.com/",
    mistral: "https://chat.mistral.ai/chat",
    poe: "https://poe.com/"
});

const SOURCE_HOSTS = [
    "claude.ai",
    "chatgpt.com",
    "chat.openai.com",
    "gemini.google.com",
    "perplexity.ai",
    "copilot.microsoft.com",
    "m365.cloud.microsoft",
    "grok.com",
    "x.com",
    "chat.deepseek.com",
    "deepseek.com",
    "chat.mistral.ai",
    "mistral.ai",
    "poe.com"
];

function isAllowedSender(sender) {
    const raw = sender?.url || "";
    try {
        const url = new URL(raw);
        return url.protocol === "https:" && SOURCE_HOSTS.some(host =>
            url.hostname === host || url.hostname.endsWith(`.${host}`)
        );
    } catch {
        return false;
    }
}

function reply(sendResponse, payload) {
    try {
        sendResponse(payload);
    } catch {
        // Sender disappeared while the service worker was responding.
    }
}

let offscreenCreating = null;

async function hasOffscreenDocument() {
    try {
        return typeof chrome.offscreen?.hasDocument === "function" && await chrome.offscreen.hasDocument();
    } catch {
        return false;
    }
}

async function createOffscreenDocument() {
    if (typeof chrome.offscreen?.createDocument !== "function") {
        throw new Error("This browser does not support extension offscreen documents (chrome.offscreen is missing).");
    }
    const options = {
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification: "Run the bundled Tesseract OCR engine locally."
    };
    try {
        await chrome.offscreen.createDocument(options);
    } catch (error) {
        const detail = String(error?.message || error);
        // Two callers can race here: if the other one won, reuse its document.
        if (/single offscreen|already (exists|created|open)/i.test(detail) && await hasOffscreenDocument()) {
            return;
        }
        // Brave can keep a hidden/stale document that hasDocument() cannot see.
        // Clear it and try exactly once more before reporting the failure.
        await closeOffscreenDocument();
        await sleep(200);
        try {
            await chrome.offscreen.createDocument(options);
        } catch (retryError) {
            throw new Error(`Could not start the OCR offscreen document: ${String(retryError?.message || retryError)}`);
        }
    }
}

async function ensureOffscreenDocument() {
    if (await hasOffscreenDocument()) {
        return;
    }
    if (!offscreenCreating) {
        offscreenCreating = createOffscreenDocument().finally(() => {
            offscreenCreating = null;
        });
    }
    await offscreenCreating;
}

async function closeOffscreenDocument() {
    try {
        if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
    } catch { /* ignore — a missing document is already the goal */ }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function pingOffscreen() {
    try {
        const response = await Promise.race([
            chrome.runtime.sendMessage({ target: "offscreen", type: "IKO_OCR_OFFSCREEN_PING" }),
            sleep(1000).then(() => null)
        ]);
        return response?.ready === true;
    } catch {
        return false;
    }
}

// createDocument resolves before the offscreen page has loaded its scripts.
// Wait for the actual listener instead of relying on a fixed short delay.
async function waitForOffscreen(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await pingOffscreen()) return true;
        await sleep(100);
    }
    return false;
}

async function sendToOffscreen(payload) {
    let lastError = null;
    // The listener can disappear between the readiness ping and the request
    // (browser discards an idle offscreen page); retry briefly.
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            return await chrome.runtime.sendMessage(payload);
        } catch (error) {
            lastError = error;
            await sleep(100);
        }
    }
    throw lastError || new Error("The OCR offscreen document did not respond.");
}

async function ensureReadyOffscreen() {
    await ensureOffscreenDocument();
    if (await waitForOffscreen()) return;
    // A document that exists but never answers is wedged (failed script load
    // or a crashed worker). Recreate it once before giving up.
    await closeOffscreenDocument();
    await ensureOffscreenDocument();
    if (!await waitForOffscreen()) {
        throw new Error("The local engine offscreen document is not answering. Check chrome://extensions for an IKO error, then reload the extension.");
    }
}

async function handleOcrRequest(message) {
    if (!message.image || typeof message.image !== "string") {
        return { success: false, error: "OCR image payload is missing." };
    }
    await ensureReadyOffscreen();
    return sendToOffscreen({
        target: "offscreen",
        type: "IKO_OCR_OFFSCREEN",
        image: message.image,
        lang: message.lang || "eng"
    });
}

async function handlePdfTextRequest(message) {
    if (!message.data || typeof message.data !== "string") {
        return { success: false, error: "PDF payload is missing." };
    }
    await ensureReadyOffscreen();
    return sendToOffscreen({
        target: "offscreen",
        type: "IKO_PDF_TEXT",
        data: message.data,
        name: String(message.name || "document.pdf").slice(0, 200),
        ocr: ["auto", "never", "force"].includes(message.ocr) ? message.ocr : "auto"
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;

    // Messages addressed to the offscreen document must not be answered here.
    if (message.target === "offscreen") return false;

    if (!isAllowedSender(sender)) {
        reply(sendResponse, { success: false, error: "Unsupported or unauthorized sender page." });
        return false;
    }

    if (message.type === "IKO_SAVE_MIGRATION") {
        if (!message.package || typeof message.package !== "object") {
            reply(sendResponse, { success: false, error: "Migration package is missing." });
            return false;
        }

        const record = {
            package: message.package,
            savedAt: Date.now(),
            sourceTabId: sender.tab?.id ?? null
        };

        chrome.storage.local.set({ ikoPendingMigration: record }, () => {
            const error = chrome.runtime.lastError;
            reply(sendResponse, error
                ? { success: false, error: error.message }
                : { success: true });
        });
        return true;
    }

    if (message.type === "IKO_GET_MIGRATION") {
        chrome.storage.local.get(["ikoPendingMigration"], result => {
            const error = chrome.runtime.lastError;
            if (error) {
                reply(sendResponse, { success: false, error: error.message });
                return;
            }

            const record = result?.ikoPendingMigration || null;
            reply(sendResponse, {
                success: true,
                package: record?.package || null,
                savedAt: record?.savedAt || null
            });
        });
        return true;
    }

    if (message.type === "IKO_CLEAR_MIGRATION") {
        chrome.storage.local.remove(["ikoPendingMigration"], () => {
            const error = chrome.runtime.lastError;
            reply(sendResponse, error
                ? { success: false, error: error.message }
                : { success: true });
        });
        return true;
    }

    if (message.type === "IKO_PDF_TEXT") {
        handlePdfTextRequest(message).then(
            result => reply(sendResponse, result),
            error => reply(sendResponse, {
                success: false,
                error: String(error?.message || error).slice(0, 300)
            })
        );
        return true;
    }

    if (message.type === "IKO_OCR_RECOGNIZE") {
        handleOcrRequest(message).then(
            result => reply(sendResponse, result),
            error => reply(sendResponse, {
                success: false,
                error: String(error?.message || error).slice(0, 300)
            })
        );
        return true;
    }

    if (message.type === "IKO_OPEN_MIGRATION_DESTINATION") {
        const destination = message.destination;
        const url = DESTINATIONS[destination];
        if (!url) {
            reply(sendResponse, { success: false, error: `Unsupported destination: ${destination}` });
            return false;
        }

        chrome.tabs.create({ url, active: true }, tab => {
            const error = chrome.runtime.lastError;
            if (error) {
                console.error("[IKO Background] tabs.create failed:", error.message);
                reply(sendResponse, { success: false, error: error.message });
                return;
            }

            reply(sendResponse, {
                success: true,
                destination,
                url,
                tabId: tab?.id ?? null
            });
        });
        return true;
    }

    return false;
});

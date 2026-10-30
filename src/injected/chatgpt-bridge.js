(function () {
    "use strict";
    if (window.__IKO_CHATGPT_BRIDGE_INSTALLED__) return;
    window.__IKO_CHATGPT_BRIDGE_INSTALLED__ = true;
    const SRC = "IKO_CHATGPT_BRIDGE";
    function publish(type, payload) {
        try { window.postMessage({ source: SRC, type, payload }, "*"); } catch { /* ignore */ }
    }
    function urlOf(input) {
        try {
            if (typeof input === "string") return input;
            if (input instanceof URL) return input.href;
            if (input && typeof input.url === "string") return input.url;
            return String(input || "");
        } catch { return ""; }
    }
    function isConvUrl(u) {
        const s = String(u || "").toLowerCase();
        return s.includes("/backend-api/conversation") || s.includes("/backend-api/conversations");
    }
    function findActualUsage(data) {
        if (!data || typeof data !== "object") return null;
        if (data.usage && typeof data.usage === "object") {
            const u = data.usage;
            if (typeof u.total_tokens === "number" || typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number") {
                return u;
            }
        }
        if (typeof data.total_tokens === "number" || typeof data.prompt_tokens === "number") {
            return {
                prompt_tokens: data.prompt_tokens,
                completion_tokens: data.completion_tokens,
                total_tokens: data.total_tokens
            };
        }
        if (data.message?.metadata?.usage) {
            return data.message.metadata.usage;
        }
        if (data.mapping && typeof data.mapping === "object") {
            for (const id in data.mapping) {
                const u = data.mapping[id]?.message?.metadata?.usage;
                if (u && (typeof u.total_tokens === "number" || typeof u.prompt_tokens === "number")) {
                    return u;
                }
            }
        }
        return null;
    }

    function publishActualUsage(data, u) {
        try {
            const usage = findActualUsage(data);
            if (usage) {
                publish("ACTUAL_USAGE", { url: u, usage, data });
            }
        } catch { /* ignore */ }
    }

    const origFetch = window.fetch;

    window.fetch = async function (...args) {
        const resp = await origFetch.apply(this, args);
        const u = urlOf(args[0]);

        try {
            rememberConversationUrl(u);
            const clone = resp.clone();

            clone.json().then((data) => {
                if (isConvUrl(u)) {
                    publish("CONVERSATION_DATA", { url: u, data });
                }

                // Capture actual usage if the response exposes it.
                publishActualUsage(data, u);
            }).catch(() => {});
        } catch (error) {
            console.warn("[IKO] Response inspection failed:", error);
        }

        return resp;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u, ...r) {
        this.__ikoUrl = String(u || "");
        return origOpen.call(this, m, u, ...r);
    };

    XMLHttpRequest.prototype.send = function (...a) {
        const xhr = this;
        const u = xhr.__ikoUrl || "";

        xhr.addEventListener("load", function () {
            try {
                rememberConversationUrl(u);
                const data = JSON.parse(xhr.responseText);

                if (isConvUrl(u)) {
                    publish("CONVERSATION_DATA", { url: u, data });
                }

                publishActualUsage(data, u);
            } catch {
                // Ignore non-JSON responses.
            }
        });

        return origSend.apply(this, a);
    };

    // The conversation the page last loaded (detail URL with a real id). Used
    // only to remember which conversation id we last saw — so we never count
    // another conversation's payload after SPA navigation.
    let lastConversationId = "";

    function rememberConversationUrl(url) {
        const s = String(url || "");
        if (!s) return;
        try {
            const u = new URL(s, location.href);
            const m = u.pathname.match(/^\/backend-api\/conversations?\/([0-9a-zA-Z-]+)/);
            if (!m) return;
            lastConversationId = m[1];
        } catch { /* ignore */ }
    }

    // ChatGPT's conversation endpoint 404s/422s on isolated-world fetches, so
    // we never call it directly. The page itself re-fetches the conversation
    // after every follow-up, and the bridge captures that payload via the
    // fetch/XHR hooks above. A refresh request just tells the content world to
    // re-count whatever the bridge already holds.
    window.addEventListener("message", function (event) {
        try {
            if (event.source !== window) return;
            const msg = event.data;
            if (!msg || msg.source !== "IKO_CHATGPT_CONTENT" || msg.type !== "REQUEST_REFRESH") return;
            // Invalidate on the content side is handled there; here we just
            // make sure a capture is pending by re-publishing the last known
            // payload if we have one.
            const bridge = window.IKO?.chatgptBridge;
            if (bridge?.latestValidConversation) {
                const payload = bridge.latestValidConversation;
                const id = String(payload?.conversation_id || "");
                if (id && id === lastConversationId) {
                    publish("CONVERSATION_DATA", { url: location.href, data: payload });
                }
            }
        } catch { /* never break the page */ }
    });

    publish("BRIDGE_READY", { href: location.href });
})();

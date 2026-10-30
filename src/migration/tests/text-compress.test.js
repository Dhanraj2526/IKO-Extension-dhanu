const test = require("node:test");
const assert = require("node:assert/strict");
const COMPRESS = require("../sir/text-compress.js");

function estimateTokens(text) {
    return Math.max(1, Math.ceil(String(text || "").length / 4));
}

test("compactText removes filler phrases but keeps meaning words", () => {
    assert.equal(COMPRESS.compactText("In order to solve it, you must act."), "To solve it, you must act.");
    assert.equal(COMPRESS.compactText("The report does not specify exact values."), "The report doesn't specify exact values.");
});

test("compress keeps headings, lists, tables, Q&A and numeric facts", () => {
    const input = [
        "# Goal",
        "",
        "It is important to note that the detection latency is 12.40 seconds.",
        "",
        "- Keep sensors alive.",
        "",
        "| Term | Meaning |",
        "| JDK | Java Development Kit |",
        "",
        "Q1. What is the latency?",
        "Latency is the delay between a sensor event and an alert.",
        ""
    ].join("\n");
    const result = COMPRESS.compress(input, { countTokens: estimateTokens, tokensIn: estimateTokens(input) });
    assert.ok(result.text.includes("# Goal"));
    assert.ok(result.text.includes("12.40 s"));
    assert.ok(result.text.includes("- Keep sensors alive."));
    assert.ok(result.text.includes("| JDK | Java Development Kit |"));
    assert.ok(result.text.includes("Q1. What is the latency?"));
    assert.ok(result.text.includes("Latency is the delay between a sensor event and an alert."));
    assert.equal(result.facts.missing.length, 0);
});

test("compress preserves every Q&A answer while deduplicating prose", () => {
    const input = [
        "# Safety",
        "",
        "The system can fire without a fire. Edge/fog reduces latency.",
        "",
        "Q1. Is the system safe?",
        "The system can fire without a fire.",
        "",
        "Q2. Does edge/fog help?",
        "Edge/fog reduces latency."
    ].join("\n");
    const result = COMPRESS.compress(input, { countTokens: estimateTokens, tokensIn: estimateTokens(input) });
    assert.ok(result.text.includes("Q1. Is the system safe?"));
    assert.ok(result.text.includes("The system can fire without a fire."));
    assert.ok(result.text.includes("Q2. Does edge/fog help?"));
    assert.ok(result.text.includes("Edge/fog reduces latency."));
});

test("compress returns a deterministic result and reports facts", () => {
    const input = "# Report\n\nThe report does not prove that sensors were deployed. Energy was measured at 45% and 67% savings.\n";
    const a = COMPRESS.compress(input, { countTokens: estimateTokens });
    const b = COMPRESS.compress(input, { countTokens: estimateTokens });
    assert.equal(a.text, b.text);
    assert.ok(a.facts.kept > 0);
});

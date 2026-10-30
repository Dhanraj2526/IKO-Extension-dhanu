const test = require("node:test");
const assert = require("node:assert/strict");
const LAYOUT = require("../sir/pdf-layout.js");

test("cleanText normalizes unicode and repeated whitespace", () => {
    assert.equal(LAYOUT.cleanText("  Hello\u00a0\u200b world \t world  "), "Hello world world");
});

test("blocksFromText keeps numbered headings, bullets, Q&A and tables", () => {
    const blocks = LAYOUT.blocksFromText(
        [
            "1. Experiment Overview",
            "Aim",
            "To study a Smart Wildfire Detection and Early Warning System.",
            "",
            "Objectives",
            "• Understand the sensor logic.",
            "",
            "Q1. What is the aim?",
            "The aim is to study wildfires.",
            "",
            "| Term | Meaning |",
            "| JDK | Java Development Kit |"
        ].join("\n"),
        { page: 1, ocr: true }
    );
    const types = blocks.map(block => block.type);
    assert.ok(types.includes("h2"));
    assert.ok(types.includes("h3"));
    assert.ok(types.includes("li"));
    assert.ok(types.includes("qa"));
    assert.ok(types.includes("table"));
    const heading = blocks.find(block => block.type === "h2");
    assert.match(heading?.text || "", /Experiment Overview/);
});

test("blocksFromText drops running page headers", () => {
    const blocks = LAYOUT.blocksFromText(
        [
            "Company: XYZ Pvt Ltd",
            "Page 3",
            "Total: Rs.54000"
        ].join("\n"),
        { page: 3, ocr: true }
    );
    const text = blocks.map(block => block.text).join("\n");
    assert.ok(!/page 3/i.test(text));
    assert.ok(text.includes("Company: XYZ Pvt Ltd"));
});

test("blocksFromText keeps Q&A answers together", () => {
    const blocks = LAYOUT.blocksFromText(
        ["Q1. What is the aim?", "The aim is to study wildfires."].join("\n"),
        { page: 1 }
    );
    const qa = blocks.find(block => block.type === "qa");
    assert.ok(qa);
    assert.match(qa.question || "", /Q1\./);
    assert.match(qa.answer || "", /aim is to study wildfires/);
});

test("isContactLine filters emails, phones and social handles", () => {
    assert.equal(LAYOUT.isContactLine("raj@example.com"), true);
    assert.equal(LAYOUT.isContactLine("LinkedIn: linkedin.com/in/x"), true);
    assert.equal(LAYOUT.isContactLine("Phone: +91 98765 43210"), true);
    assert.equal(LAYOUT.isContactLine("To study a wildfire system."), false);
});

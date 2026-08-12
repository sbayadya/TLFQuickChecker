/* Gemini provider for TLF validation.
   Sends PDF #1 (final TLF output) and optionally PDF #2 (shell/template) to
   Gemini and asks for a structured JSON verdict. The dataset is NEVER sent —
   patient-level data stays on-device. */

window.Gemini = (() => {
  "use strict";

  // Gemini structured-output schema (OpenAPI subset).
  const RESPONSE_SCHEMA = {
    type: "OBJECT",
    properties: {
      outputType: { type: "STRING", description: "Table, Listing, or Figure" },
      structure: {
        type: "OBJECT",
        properties: {
          hasHeader: { type: "BOOLEAN" },
          headerText: { type: "STRING" },
          hasTitles: { type: "BOOLEAN" },
          titles: { type: "ARRAY", items: { type: "STRING" } },
          hasFootnotes: { type: "BOOLEAN" },
          footnotes: { type: "ARRAY", items: { type: "STRING" } },
          notes: { type: "STRING" },
        },
      },
      bigNs: {
        type: "ARRAY",
        description: "One entry per treatment-group column header that carries a big N.",
        items: {
          type: "OBJECT",
          properties: {
            columnLabel: { type: "STRING", description: "Treatment column label without the (N=...) part, e.g. 'Placebo'." },
            rawText: { type: "STRING", description: "Exact N text as printed, e.g. 'N=54' or 'N=xx'." },
            value: { type: "STRING", description: "Just the value after N=, e.g. '54' or 'xx'." },
          },
        },
      },
      templateMatch: {
        type: "OBJECT",
        properties: {
          evaluated: { type: "BOOLEAN", description: "True only if a shell/template PDF was provided." },
          headerMatch: { type: "BOOLEAN" },
          titleMatch: { type: "BOOLEAN" },
          footnoteMatch: { type: "BOOLEAN" },
          differences: { type: "ARRAY", items: { type: "STRING" } },
        },
      },
      summary: { type: "STRING" },
    },
    required: ["structure", "bigNs", "summary"],
  };

  function buildPrompt({ hasShell, instructions }) {
    let p =
`You are a QC reviewer for clinical-trial TLFs (Tables, Listings, Figures), following
standard industry / PHUSE-style display conventions.

PDF #1 is the FINAL TLF OUTPUT. Evaluate it:

1. STRUCTURE — determine whether it has:
   - a HEADER (top-of-page: sponsor / protocol / CSR designation / page numbering),
   - TITLE lines (standard structure: output number, then title, then analysis population),
   - FOOTNOTES (bottom, often a "NOTE:" line; abbreviations defined; program/date).
   Extract the actual header text, each title line, and each footnote line.

2. BIG Ns — find every treatment-group column header that shows a subject count,
   e.g. "Placebo (N=54)". For EACH such column return: the column label (without the
   "(N=...)"), the exact printed N text (rawText, e.g. "N=54" or "N=xx"), and the value
   after "N=". Report the value EXACTLY as printed — if it is a placeholder like "x",
   "xx", "X", or "N", return that verbatim (do NOT invent a number). Whole-integer
   values like "54" are correct; placeholders indicate the output was not populated.`;

    if (hasShell) {
      p += `

3. TEMPLATE MATCH — PDF #2 is the SHELL/TEMPLATE for PDF #1. Set templateMatch.evaluated=true
   and compare mainly the HEADER, TITLES, and FOOTNOTES between the two. The shell legitimately
   uses placeholders (e.g. "(N=xx)", "xx.x", "Table x.x") while the final output has real values —
   so ignore differences that are only placeholder-vs-value. Report headerMatch / titleMatch /
   footnoteMatch (structure & wording aligned), and list concrete differences that are NOT just
   placeholder resolution.`;
    } else {
      p += `

3. TEMPLATE MATCH — no shell/template PDF was provided. Set templateMatch.evaluated=false.`;
    }

    if (instructions && instructions.trim()) {
      p += `\n\nADDITIONAL USER INSTRUCTIONS:\n${instructions.trim()}`;
    }
    p += `\n\nReturn ONLY the JSON described by the schema. Do not send patient-level data back.`;
    return p;
  }

  async function evaluate({ settings, pdf1, pdf2, instructions }) {
    if (!pdf1) throw new Error("PDF #1 is required.");
    const model = settings.model.trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;

    const parts = [];
    parts.push({ text: "=== PDF #1 — FINAL TLF OUTPUT ===" });
    parts.push({ inlineData: { mimeType: "application/pdf", data: pdf1.base64 } });
    if (pdf2) {
      parts.push({ text: "=== PDF #2 — SHELL / TEMPLATE ===" });
      parts.push({ inlineData: { mimeType: "application/pdf", data: pdf2.base64 } });
    }
    parts.push({ text: buildPrompt({ hasShell: !!pdf2, instructions }) });

    const body = {
      systemInstruction: {
        parts: [{ text: settings.systemPrompt || "You are a precise clinical-trial TLF QC reviewer." }],
      },
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: Number(settings.temperature),
        maxOutputTokens: Number(settings.maxTokens) || 4096,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Request failed (HTTP ${res.status})`);
    }
    const cand = data?.candidates?.[0];
    if (cand?.finishReason === "SAFETY") throw new Error("Response blocked by safety filters.");
    const text = (cand?.content?.parts || []).map((p) => p.text || "").join("").trim();
    if (!text) {
      if (cand?.finishReason === "MAX_TOKENS")
        throw new Error("Output cut off (max tokens). Increase Max output tokens in Settings.");
      throw new Error("The model returned no text.");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Could not parse the model's JSON response.");
    }
    return parsed;
  }

  return { evaluate };
})();

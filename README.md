# TLF Quick Checker

A zero-backend browser app for QC-ing clinical-trial **TLFs** (Tables, Listings,
Figures). Drop in up to three files and get a structured validation report. Your
API key and history stay in `localStorage`; the SAS dataset is parsed **locally**
and never leaves your browser.

## Inputs

| # | File | Required | What it does |
|---|------|----------|--------------|
| 1 | **TLF output** PDF | ✅ | Checks it has a header, title(s) and footnote(s), and validates **big-N** format. |
| 2 | **Shell / template** PDF | optional | Confirms PDF #1 matches the shell's header, titles and footnotes. |
| 3 | **ADSL dataset** (`.sas7bdat`, `.xpt`, or `.csv`) | optional | Filters by population flag, groups by treatment, counts subjects, and reconciles against the big-Ns in PDF #1. |

## The checks

1. **Structure** — header (sponsor/protocol/CSR/pagination), the standard 3-line
   title block (number / title / population), and footnotes.
2. **Big-N format** — every treatment column must show a *resolved integer*, e.g.
   `Placebo (N=54)`. Placeholders like `N=xx` / `N=x` / `N=X` **fail** (this is the
   industry / PHUSE-style TLF-shell convention: shells carry placeholders, final
   outputs carry real counts).
3. **Template match** — header / titles / footnotes of PDF #1 vs the shell (PDF #2),
   ignoring differences that are only placeholder-vs-value.
4. **Count reconciliation** — subjects are counted from the dataset (by `TRT01PN` or
   `TRT01AN`, filtered to a population flag such as `SAFFL=Y`) and **auto-matched by
   label** to the PDF's big-N columns. Each column is flagged match / mismatch.

## Run it

**Just open the file** — double-click `index.html`, or:

```bash
python3 server.py
```

then visit http://127.0.0.1:8777 (a local server avoids `file://` quirks with the
Python/WASM runtime).

## First-time setup

1. Free Gemini key: https://aistudio.google.com/app/apikey
2. **Settings** → paste the key, pick a model (default `gemini-3.5-flash`), and
   optionally tune the reviewer prompt, temperature, and max tokens.

## How it works under the hood

- **PDFs** → sent to Google **Gemini** (reads PDFs natively) which returns a
  structured JSON verdict. Big-N integer validity is re-checked deterministically
  in JS, not trusted to the model.
- **Dataset** → parsed with **Pyodide + `pandas.read_sas`** entirely in the browser.
  Supported formats: `.sas7bdat`, `.xpt` (SAS transport), and `.csv`.
  The first time you add a dataset, the Python/WASM runtime downloads
  (~10-15 MB, cached afterwards). Patient-level data is **never** sent to the AI.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Layout |
| `styles.css` | Styling (dark + light, responsive) |
| `app.js` | UI, orchestration, big-N validation, label-matching, reporting |
| `gemini.js` | Gemini structured-output call (PDFs only) |
| `sas.js` | Pyodide + pandas `.sas7bdat` reader / counter (local) |
| `server.py` | Optional static file server |

## Notes & limits

- History stores results + filenames only — **not** the files. Re-add files to re-run.
- Inline PDF limit ≈ 18 MB (Gemini request cap).
- `.sas7bdat` reading uses pandas' native reader (handles RLE compression). If a
  dataset fails to load, it may use an unusual compression/encoding.

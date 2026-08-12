/* SAS dataset reader — runs entirely in the browser via Pyodide + pandas.
   The .sas7bdat is parsed locally; patient-level data never leaves the device. */

window.SAS = (() => {
  "use strict";

  const PYODIDE_VER = "0.26.2";
  const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VER}/full/`;

  let pyodide = null;
  let loadingPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  async function ensureReady(onProgress) {
    if (pyodide) return pyodide;
    if (loadingPromise) return loadingPromise;
    loadingPromise = (async () => {
      onProgress?.("Loading Python runtime (first time only)…");
      if (!window.loadPyodide) await loadScript(PYODIDE_BASE + "pyodide.js");
      pyodide = await window.loadPyodide({ indexURL: PYODIDE_BASE });
      onProgress?.("Loading pandas…");
      await pyodide.loadPackage("pandas");
      onProgress?.("");
      return pyodide;
    })();
    return loadingPromise;
  }

  // Read a .sas7bdat / .xpt / .csv into Pyodide and return column names + row count.
  async function parseMeta(file, onProgress) {
    const py = await ensureReady(onProgress);
    onProgress?.("Reading dataset…");
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const path = "/tmp/data." + (ext || "dat");
    const buf = new Uint8Array(await file.arrayBuffer());
    py.FS.writeFile(path, buf);
    py.globals.set("_path", path);
    py.globals.set("_ext", ext);

    const code = `
import pandas as pd, json
_df = None
_err = None
if _ext == "csv":
    for enc in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            _df = pd.read_csv(_path, encoding=enc)
            break
        except Exception as e:
            _err = str(e)
elif _ext == "xpt":
    for enc in ("latin-1", "utf-8"):
        try:
            _df = pd.read_sas(_path, format="xport", encoding=enc)
            break
        except Exception as e:
            _err = str(e)
else:  # sas7bdat
    for enc in ("latin-1", "utf-8"):
        try:
            _df = pd.read_sas(_path, format="sas7bdat", encoding=enc)
            break
        except Exception as e:
            _err = str(e)
if _df is None:
    raise RuntimeError(_err or "Could not read dataset")
_df.columns = [str(c).strip().upper() for c in _df.columns]
globals()["_DF"] = _df
json.dumps({"columns": list(_df.columns), "nrows": int(len(_df))})
`;
    let metaJson;
    try {
      metaJson = py.runPython(code);
    } catch (e) {
      throw new Error("Failed to read dataset: " + (e.message || e));
    }
    onProgress?.("");
    return JSON.parse(metaJson);
  }

  // Filter by population flag, group by treatment var, count subjects.
  async function computeCounts({ trtVar, popFlag, popValue }) {
    if (!pyodide) throw new Error("Dataset not loaded.");
    pyodide.globals.set("trt_var", String(trtVar || "").toUpperCase());
    pyodide.globals.set("pop_flag", String(popFlag || "").toUpperCase());
    pyodide.globals.set("pop_value", String(popValue == null ? "Y" : popValue));

    const code = `
import pandas as pd, numpy as np, math, json

df = globals()["_DF"].copy()

def clean(v):
    if v is None: return None
    if isinstance(v, (np.floating, float)):
        if math.isnan(v): return None
        return int(v) if float(v).is_integer() else float(v)
    if isinstance(v, (np.integer,)): return int(v)
    if isinstance(v, bytes):
        try: return v.decode("latin-1").strip()
        except Exception: return str(v)
    return str(v).strip()

result = {"trtVar": trt_var, "groups": [], "total": 0, "warnings": []}

# Population filter
if pop_flag:
    if pop_flag in df.columns:
        col = df[pop_flag].map(clean).astype(str).str.strip()
        df = df[col == str(pop_value).strip()]
    else:
        result["warnings"].append("Population flag '%s' not found; no population filter applied." % pop_flag)

# Numeric -> character decode map for treatment labels
num2char = {"TRT01PN": "TRT01P", "TRT01AN": "TRT01A", "TRTPN": "TRTP", "TRTAN": "TRTA"}
label_col = num2char.get(trt_var)
if label_col not in df.columns:
    label_col = None

sid = "USUBJID" if "USUBJID" in df.columns else ("SUBJID" if "SUBJID" in df.columns else None)

if trt_var not in df.columns:
    result["warnings"].append("Treatment variable '%s' not found in dataset." % trt_var)
else:
    if sid:
        grp = df.groupby(trt_var)[sid].nunique()
        result["countBasis"] = "distinct " + sid
    else:
        grp = df.groupby(trt_var).size()
        result["countBasis"] = "rows"
    for code_val, cnt in grp.items():
        label = None
        if label_col:
            sub = df[df[trt_var] == code_val][label_col].dropna()
            if len(sub): label = clean(sub.iloc[0])
        result["groups"].append({"code": clean(code_val), "label": label, "count": int(cnt)})
    result["groups"].sort(key=lambda x: (x["code"] is None, x["code"] if x["code"] is not None else 0))
    result["total"] = int(sum(g["count"] for g in result["groups"]))

json.dumps(result)
`;
    let out;
    try {
      out = pyodide.runPython(code);
    } catch (e) {
      throw new Error("Counting failed: " + (e.message || e));
    }
    return JSON.parse(out);
  }

  return { ensureReady, parseMeta, computeCounts };
})();

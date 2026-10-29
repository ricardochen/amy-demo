#!/usr/bin/env python3
"""
build_kb.py — Rebuild the knowledge base JSON from the original Excel file.

The backend indexes `kb_data.json` (not the Excel file), so the edge function
can load embedded data without needing `pandas` or a filesystem.

Usage:
    python3 scripts/build_kb.py path/to/knowledge_base.xls
"""
import json
import os
import sys

import pandas as pd

OUT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "supabase",
    "functions",
    "amy-api",
    "kb_data.json",
)


def main():
    if len(sys.argv) < 2:
        print("usage: python3 scripts/build_kb.py <excel>")
        sys.exit(1)

    src = sys.argv[1]
    df = pd.read_excel(src)
    df.columns = [str(c).lower() for c in df.columns]

    for required in ("question", "answer"):
        if required not in df.columns:
            print(f"ERROR: missing column '{required}'. Found: {list(df.columns)}")
            sys.exit(1)

    out = []
    for _, row in df.iterrows():
        q = str(row.get("question", "")).strip()
        a = str(row.get("answer", "")).strip()
        if not q or not a or q.lower() == "nan":
            continue
        out.append({
            "q": q,
            "a": a,
            "s": str(row.get("similar questions", "")).strip(),
            "k": str(row.get("keywords", "")).strip(),
        })

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    print(f"[build_kb] {len(out)} entries -> {os.path.relpath(OUT)}")


if __name__ == "__main__":
    main()

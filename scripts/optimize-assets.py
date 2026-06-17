#!/usr/bin/env python3
"""Downscale + recompress console screenshots for inlining into the deck."""
import os
from PIL import Image

SRC = "presentation/assets"
DST = "presentation/assets/opt"
os.makedirs(DST, exist_ok=True)

MAX_W = 1500  # display width is ~1100px; 1500 keeps it crisp

for name in sorted(os.listdir(SRC)):
    if not name.lower().endswith((".png", ".jpeg", ".jpg")):
        continue
    src = os.path.join(SRC, name)
    if os.path.isdir(src):
        continue
    im = Image.open(src).convert("RGB")
    w, h = im.size
    if w > MAX_W:
        im = im.resize((MAX_W, round(h * MAX_W / w)), Image.LANCZOS)
    base = os.path.splitext(name)[0]
    out = os.path.join(DST, base + ".jpg")
    im.save(out, "JPEG", quality=86, optimize=True)
    print(f"{name} {w}x{h} -> {im.size[0]}x{im.size[1]}  {os.path.getsize(out)//1024}KB")

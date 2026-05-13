#!/usr/bin/env python3
"""
Thicken the gold strokes of the capybara logo cleanly:
  1. Convert to grayscale
  2. Threshold → binary mask (gold pixels = white)
  3. Dilate (configurable thickness)
  4. Recolor: composite pure gold over black using the dilated mask

This avoids the pink/rose tint that per-channel max produces on the JPEG source,
because we discard the noisy color channels before dilating and paint a clean
gold (#d0ad5c) back at the end.
"""

import sys
from PIL import Image, ImageFilter, ImageOps

GOLD = (208, 173, 92)  # base gold tone — matches the wordmark gradient mid-stop
BG = (0, 0, 0)


def thicken(src_path: str, dst_path: str, dilate_passes: int, threshold: int = 50):
    img = Image.open(src_path).convert("RGB")
    w, h = img.size

    # 1. Grayscale (luminance)
    gray = img.convert("L")

    # 2. Threshold — anything above `threshold` becomes 255 (the gold)
    mask = gray.point(lambda p: 255 if p > threshold else 0).convert("L")

    # 3. Dilate the mask by `dilate_passes` pixels using a 3x3 MaxFilter
    for _ in range(dilate_passes):
        mask = mask.filter(ImageFilter.MaxFilter(3))

    # 4. Build the recolored image: gold where mask is bright, black elsewhere
    gold_layer = Image.new("RGB", (w, h), GOLD)
    bg_layer = Image.new("RGB", (w, h), BG)
    out = Image.composite(gold_layer, bg_layer, mask)

    # 5. Re-anti-alias the edges so the lines aren't blocky.
    #    Blur the mask just slightly, then re-composite at fractional opacity.
    soft_mask = mask.filter(ImageFilter.GaussianBlur(radius=0.6))
    out = Image.composite(gold_layer, bg_layer, soft_mask)

    out.save(dst_path)
    print(f"wrote {dst_path} (dilate={dilate_passes})")


if __name__ == "__main__":
    src = "raw.png"
    for passes in (1, 2, 3, 4):
        thicken(src, f"clean-bold{passes}.png", dilate_passes=passes)

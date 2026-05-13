#!/usr/bin/env python3
"""
Thicken the gold strokes of the capybara logo cleanly.

Two output modes:
  - opaque:      gold strokes over solid black (for favicons, app icons, social cards)
  - transparent: gold strokes with alpha = mask, background fully transparent
                 (for floating placements over any color)

Pipeline:
  1. Convert source to grayscale
  2. Threshold → binary mask (gold pixels = white)
  3. Dilate (configurable thickness)
  4. Light gaussian blur on the mask for anti-aliasing
  5. Either composite over black (opaque) or output RGBA with mask as alpha
"""

from PIL import Image, ImageFilter

GOLD = (208, 173, 92)  # base gold tone — matches the wordmark gradient mid-stop
BG = (0, 0, 0)


def _build_mask(img: Image.Image, dilate_passes: int, threshold: int) -> Image.Image:
    gray = img.convert("L")
    mask = gray.point(lambda p: 255 if p > threshold else 0).convert("L")
    for _ in range(dilate_passes):
        mask = mask.filter(ImageFilter.MaxFilter(3))
    return mask.filter(ImageFilter.GaussianBlur(radius=0.6))


def thicken(src_path: str, dst_path: str, dilate_passes: int, threshold: int = 50):
    """Opaque output: gold over solid black."""
    img = Image.open(src_path).convert("RGB")
    w, h = img.size
    mask = _build_mask(img, dilate_passes, threshold)
    gold_layer = Image.new("RGB", (w, h), GOLD)
    bg_layer = Image.new("RGB", (w, h), BG)
    out = Image.composite(gold_layer, bg_layer, mask)
    out.save(dst_path)
    print(f"wrote {dst_path} (dilate={dilate_passes}, opaque)")


def thicken_transparent(src_path: str, dst_path: str, dilate_passes: int, threshold: int = 50):
    """Transparent output: gold strokes with the mask as alpha, no background."""
    img = Image.open(src_path).convert("RGB")
    w, h = img.size
    mask = _build_mask(img, dilate_passes, threshold)
    out = Image.new("RGBA", (w, h), (*GOLD, 0))
    out.putalpha(mask)
    # Bake the gold RGB everywhere — pixels with alpha=0 still need consistent
    # RGB to avoid halos when downscaled.
    gold_solid = Image.new("RGBA", (w, h), (*GOLD, 255))
    gold_solid.putalpha(mask)
    out = gold_solid
    out.save(dst_path)
    print(f"wrote {dst_path} (dilate={dilate_passes}, transparent)")


def crop_to_content(img: Image.Image, padding: int = 16) -> Image.Image:
    """Crop a transparent image to its non-transparent bounding box plus padding."""
    bbox = img.getchannel("A").getbbox()
    if not bbox:
        return img
    x0, y0, x1, y1 = bbox
    w, h = img.size
    x0 = max(0, x0 - padding)
    y0 = max(0, y0 - padding)
    x1 = min(w, x1 + padding)
    y1 = min(h, y1 + padding)
    return img.crop((x0, y0, x1, y1))


if __name__ == "__main__":
    src = "raw.png"

    # Sweep for visual comparison
    for passes in (3, 4, 5, 6):
        thicken(src, f"clean-bold{passes}.png", dilate_passes=passes)

    # Transparent variants
    #
    #  - lines (passes=0): preserves the line-art outline aesthetic. Inside
    #    of the capybara stays transparent.
    #  - filled (passes=5): dilation merges adjacent strokes into a solid gold
    #    silhouette. More iconic / poster-like.
    for tag, passes in (("lines", 0), ("filled", 5)):
        thicken_transparent(src, f"logo-trans-{tag}-full.png", dilate_passes=passes)
        img = Image.open(f"logo-trans-{tag}-full.png")
        tight = crop_to_content(img, padding=24)
        w, h = tight.size
        side = max(w, h)
        square = Image.new("RGBA", (side, side), (*GOLD, 0))
        square.paste(tight, ((side - w) // 2, (side - h) // 2))
        square.save(f"logo-trans-{tag}.png")
        print(f"wrote logo-trans-{tag}.png ({side}x{side})")

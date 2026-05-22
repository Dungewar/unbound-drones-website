from pathlib import Path
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parents[1]
OUT_ROOT = ROOT / "public" / "assets" / "earth-tiles"

ROWS = 12
COLS = 24
LODS = [
    ("far-256", 256),
    ("orbit-512", 512),
    ("surface-1024", 1024),
]
SOURCES = [
    ("day", ROOT / "public" / "assets" / "43k.jpg"),
    ("night", ROOT / "public" / "assets" / "night-16384.jpg"),
]


def crop_box(width, height, row, col):
    left = round(width * col / COLS)
    right = round(width * (col + 1) / COLS)
    top = round(height * row / ROWS)
    bottom = round(height * (row + 1) / ROWS)
    return left, top, right, bottom


def main():
    for kind, source in SOURCES:
        with Image.open(source) as image:
            image = image.convert("RGB")
            width, height = image.size
            for lod_name, tile_size in LODS:
                out_dir = OUT_ROOT / lod_name / kind
                out_dir.mkdir(parents=True, exist_ok=True)
                for row in range(ROWS):
                    for col in range(COLS):
                        tile = image.crop(crop_box(width, height, row, col))
                        tile = tile.resize((tile_size, tile_size), Image.Resampling.LANCZOS)
                        out_path = out_dir / f"tile-r{row}-c{col}.jpg"
                        tile.save(out_path, "JPEG", quality=88, optimize=True, progressive=True)
                print(f"{kind} {lod_name}: wrote {ROWS * COLS} tiles to {out_dir.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

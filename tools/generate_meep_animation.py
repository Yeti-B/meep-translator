from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageSequence


CANVAS_SIZE = 256
FRAME_COUNT = 18
FRAME_DURATION_MS = 50


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        raise ValueError("source image has no visible pixels")
    return bbox


def fit_source(source_path: Path) -> Image.Image:
    image = Image.open(source_path).convert("RGBA")
    bird = image.crop(alpha_bbox(image))

    margin = 5
    scale = min(
        (CANVAS_SIZE - margin * 2) / bird.width,
        (CANVAS_SIZE - margin * 2) / bird.height,
    )
    size = (round(bird.width * scale), round(bird.height * scale))
    bird = bird.resize(size, Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    x = (CANVAS_SIZE - size[0]) // 2
    y = round((CANVAS_SIZE - size[1]) * 0.54)
    canvas.alpha_composite(bird, (x, y))
    return canvas


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    if edge0 == edge1:
        return 1.0 if value >= edge1 else 0.0
    value = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return value * value * (3.0 - 2.0 * value)


def make_body_motion_mask(base: Image.Image) -> Image.Image:
    alpha = base.getchannel("A")
    mask = Image.new("L", base.size, 0)
    pixels = mask.load()

    for y in range(CANVAS_SIZE):
        lower_body = smoothstep(104, 154, y)
        for x in range(CANVAS_SIZE):
            alpha_value = alpha.getpixel((x, y))
            if not alpha_value:
                continue

            body_left = 1.0 - smoothstep(144, 194, x)
            front_leg_zone = lower_body * (1.0 - smoothstep(214, 246, x))
            weight = max(body_left, front_leg_zone)
            pixels[x, y] = round(alpha_value * weight)

    return mask.filter(ImageFilter.GaussianBlur(3.2))


def shift_image(image: Image.Image, dx: float, dy: float) -> Image.Image:
    return image.transform(
        image.size,
        Image.Transform.AFFINE,
        (1, 0, -dx, 0, 1, -dy),
        resample=Image.Resampling.BICUBIC,
    )


def build_frames(base: Image.Image) -> list[Image.Image]:
    body_motion_mask = make_body_motion_mask(base)
    frames: list[Image.Image] = []

    # Classic woodcock "meep" motion: the bill/head read as steady while the
    # plump body rocks smoothly forward and back. This uses a feathered mask
    # instead of cut layers, so the neck stays continuous without protrusions.
    for index in range(FRAME_COUNT):
        phase = (math.tau * index) / FRAME_COUNT
        body_dx = 8.2 * math.sin(phase)
        body_dy = 1.8 * math.cos(phase + math.pi * 0.15)
        shifted_body = shift_image(base, body_dx, body_dy)
        frame = Image.composite(shifted_body, base, body_motion_mask)
        frames.append(frame)
    return frames


def save_preview(frames: list[Image.Image], preview_path: Path) -> None:
    frame_w, frame_h = frames[0].size
    sheet = Image.new("RGBA", (frame_w * len(frames), frame_h), (255, 255, 255, 0))
    for index, frame in enumerate(frames):
        sheet.alpha_composite(frame, (index * frame_w, 0))
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(preview_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("extension/icons/woodcock-transparent.png"),
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("extension/icons/woodcock-meep.webp"),
    )
    parser.add_argument(
        "--preview",
        type=Path,
        default=Path("extension/icons/woodcock-meep-preview.png"),
    )
    args = parser.parse_args()

    source = args.source
    if not source.exists():
        source = Path("extension/icons/woodcock-128.png")

    base = fit_source(source)
    frames = build_frames(base)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        args.out,
        save_all=True,
        append_images=frames[1:],
        duration=FRAME_DURATION_MS,
        loop=0,
        lossless=True,
        method=6,
        disposal=2,
    )
    save_preview(frames, args.preview)

    with Image.open(args.out) as animated:
        frame_count = sum(1 for _ in ImageSequence.Iterator(animated))
    print(f"wrote {args.out} ({frame_count} frames)")
    print(f"wrote {args.preview}")


if __name__ == "__main__":
    main()

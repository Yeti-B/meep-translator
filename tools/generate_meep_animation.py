from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageSequence


CANVAS_SIZE = 192
MASK_SCALE = 4
FRAME_DURATION_MS = 50
PAUSE_DURATION_MS = 500
SWING_CYCLES = 3
CYCLE_FRAMES = 8
BODY_SWING_PX = 9.0
BODY_BOB_PX = 0.5


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    bbox = image.getchannel("A").getbbox()
    if not bbox:
        raise ValueError("source image has no visible pixels")
    return bbox


def fit_source(source_path: Path) -> Image.Image:
    image = Image.open(source_path).convert("RGBA")
    bird = image.crop(alpha_bbox(image))

    margin = 4
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


def scaled_points(points: list[tuple[float, float]]) -> list[tuple[int, int]]:
    return [(round(x * MASK_SCALE), round(y * MASK_SCALE)) for x, y in points]


def draw_scaled_ellipse(
    draw: ImageDraw.ImageDraw,
    box: tuple[float, float, float, float],
    fill: int,
) -> None:
    draw.ellipse(tuple(round(value * MASK_SCALE) for value in box), fill=fill)


def make_static_head_mask() -> Image.Image:
    size = CANVAS_SIZE * MASK_SCALE
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)

    # Pin only the head, eye, bill, and bill root. The front chest and both
    # legs remain in the moving region so the meep reads as a whole-body bob.
    draw_scaled_ellipse(draw, (121, 37, 163, 91), 255)
    draw.polygon(scaled_points([(141, 56), (191, 80), (192, 137), (138, 92)]), fill=255)
    draw.polygon(scaled_points([(131, 69), (182, 88), (181, 134), (128, 112)]), fill=255)
    draw.polygon(scaled_points([(114, 55), (151, 49), (160, 105), (116, 107), (106, 84)]), fill=255)

    return mask.resize((CANVAS_SIZE, CANVAS_SIZE), Image.Resampling.LANCZOS)


def make_motion_weight(base: Image.Image) -> Image.Image:
    static_head = np.asarray(make_static_head_mask(), dtype=np.float32) / 255.0
    static_head = np.asarray(
        Image.fromarray(np.uint8(static_head * 255)).filter(ImageFilter.GaussianBlur(0.7)),
        dtype=np.float32,
    ) / 255.0

    alpha = np.asarray(base.getchannel("A"), dtype=np.float32) / 255.0
    weight = 1.0 - static_head
    weight = np.clip(weight * alpha, 0.0, 1.0)
    return Image.fromarray(np.uint8(np.round(weight * 255)), "L")


def bilinear_sample(image_array: np.ndarray, sample_x: np.ndarray, sample_y: np.ndarray) -> np.ndarray:
    height, width, _ = image_array.shape
    sample_x = np.clip(sample_x, 0.0, width - 1.001)
    sample_y = np.clip(sample_y, 0.0, height - 1.001)

    x0 = np.floor(sample_x).astype(np.int32)
    y0 = np.floor(sample_y).astype(np.int32)
    x1 = np.clip(x0 + 1, 0, width - 1)
    y1 = np.clip(y0 + 1, 0, height - 1)

    wx = sample_x - x0
    wy = sample_y - y0

    top = image_array[y0, x0] * (1.0 - wx[..., None]) + image_array[y0, x1] * wx[..., None]
    bottom = image_array[y1, x0] * (1.0 - wx[..., None]) + image_array[y1, x1] * wx[..., None]
    return top * (1.0 - wy[..., None]) + bottom * wy[..., None]


def warp_frame(base: Image.Image, weight: Image.Image, dx: float, dy: float) -> Image.Image:
    image_array = np.asarray(base, dtype=np.float32)
    motion = np.asarray(weight, dtype=np.float32) / 255.0
    yy, xx = np.mgrid[0:CANVAS_SIZE, 0:CANVAS_SIZE].astype(np.float32)

    sample_x = xx - dx * motion
    sample_y = yy - dy * motion
    warped = bilinear_sample(image_array, sample_x, sample_y)
    warped = np.clip(np.round(warped), 0, 255).astype(np.uint8)
    return Image.fromarray(warped)


def make_offsets() -> list[tuple[float, float]]:
    offsets: list[tuple[float, float]] = []
    for _ in range(SWING_CYCLES):
        for frame in range(CYCLE_FRAMES):
            phase = math.tau * frame / CYCLE_FRAMES
            dx = BODY_SWING_PX * math.sin(phase)
            dy = BODY_BOB_PX * math.cos(phase)
            offsets.append((dx, dy))
    offsets.append((0.0, 0.0))
    return offsets


def make_durations(frame_count: int) -> list[int]:
    if frame_count < 2:
        return [PAUSE_DURATION_MS]
    return [FRAME_DURATION_MS] * (frame_count - 1) + [PAUSE_DURATION_MS]


def build_frames(base: Image.Image) -> tuple[list[Image.Image], Image.Image]:
    weight = make_motion_weight(base)
    frames = [warp_frame(base, weight, dx, dy) for dx, dy in make_offsets()]
    return frames, weight


def save_preview(frames: list[Image.Image], preview_path: Path) -> None:
    frame_w, frame_h = frames[0].size
    sheet = Image.new("RGBA", (frame_w * len(frames), frame_h), (255, 255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    tile = 12
    for y in range(0, sheet.height, tile):
        for x in range(0, sheet.width, tile):
            if (x // tile + y // tile) % 2:
                draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill=(238, 242, 247, 255))
    for index, frame in enumerate(frames):
        sheet.alpha_composite(frame, (index * frame_w, 0))
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(preview_path)


def save_weight_preview(weight: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    weight.save(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("extension/icons/woodcock-master.png"),
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
    parser.add_argument(
        "--weight-preview",
        type=Path,
        default=Path("extension/icons/woodcock-meep-weight.png"),
    )
    args = parser.parse_args()

    if not args.source.exists():
        raise FileNotFoundError(f"missing animation source: {args.source}")

    base = fit_source(args.source)
    frames, weight = build_frames(base)
    durations = make_durations(len(frames))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        args.out,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        lossless=True,
        method=6,
        disposal=2,
    )
    save_preview(frames, args.preview)
    save_weight_preview(weight, args.weight_preview)

    with Image.open(args.out) as animated:
        frame_count = sum(1 for _ in ImageSequence.Iterator(animated))

    print(f"wrote {args.out} ({frame_count} frames)")
    print(f"wrote {args.preview}")
    print(f"wrote {args.weight_preview}")
    print(f"timing: {frame_count - 1} motion frames @ {FRAME_DURATION_MS}ms + 1 pause @ {PAUSE_DURATION_MS}ms")


if __name__ == "__main__":
    main()

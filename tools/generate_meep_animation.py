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
BODY_SWING_PX = 6.0
BODY_BOB_PX = 0.0
ELASTIC_NECK_FOLLOW = 0.45
ELASTIC_NECK_ALPHA = 0.62


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


def make_head_pin_mask() -> Image.Image:
    size = CANVAS_SIZE * MASK_SCALE
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)

    # Fixed cover for the face and full bill. Keep the lower-left edge tight so
    # the front chest remains part of the moving body layer.
    draw_scaled_ellipse(draw, (122, 38, 163, 88), 255)
    draw.polygon(scaled_points([(105, 56), (121, 45), (151, 48), (163, 67), (154, 88), (132, 94), (112, 77)]), fill=255)
    draw.polygon(scaled_points([(136, 57), (192, 92), (192, 113), (132, 81)]), fill=255)
    draw.line(scaled_points([(139, 60), (192, 100)]), fill=255, width=round(13 * MASK_SCALE))
    draw.line(scaled_points([(134, 73), (188, 127)]), fill=255, width=round(11 * MASK_SCALE))
    draw.polygon(scaled_points([(132, 62), (147, 58), (153, 74), (135, 82)]), fill=255)

    return mask.resize((CANVAS_SIZE, CANVAS_SIZE), Image.Resampling.LANCZOS).filter(
        ImageFilter.GaussianBlur(0.45)
    )


def make_neck_blend_mask() -> Image.Image:
    size = CANVAS_SIZE * MASK_SCALE
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)

    # A feathered bridge over the head/body joint. This local layer follows the
    # body partway, which softens the seam without breaking whole-body motion.
    draw.polygon(
        scaled_points([(94, 50), (116, 42), (148, 58), (150, 82), (131, 104), (99, 84)]),
        fill=255,
    )

    return mask.resize((CANVAS_SIZE, CANVAS_SIZE), Image.Resampling.LANCZOS).filter(
        ImageFilter.GaussianBlur(2.0)
    )


def clean_transparent_pixels(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA")).copy()
    rgba[rgba[..., 3] == 0, :3] = 0
    return Image.fromarray(rgba, "RGBA")


def apply_alpha_mask(image: Image.Image, mask: np.ndarray) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.float32).copy()
    rgba[..., 3] *= np.clip(mask, 0.0, 1.0)
    return clean_transparent_pixels(
        Image.fromarray(np.clip(np.round(rgba), 0, 255).astype(np.uint8), "RGBA")
    )


def make_layer_masks(base: Image.Image) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    alpha = np.asarray(base.convert("RGBA").getchannel("A"), dtype=np.float32) / 255.0
    head = np.asarray(make_head_pin_mask(), dtype=np.float32) / 255.0
    neck = np.asarray(make_neck_blend_mask(), dtype=np.float32) / 255.0

    head = np.clip(head * alpha, 0.0, 1.0)
    neck = np.clip(neck * alpha * ELASTIC_NECK_ALPHA, 0.0, 1.0)
    body = np.clip(alpha * (1.0 - head), 0.0, 1.0)
    return body, neck, head


def make_motion_weight(base: Image.Image) -> Image.Image:
    body, _, _ = make_layer_masks(base)
    return Image.fromarray(np.uint8(np.round(body * 255)), "L")


def offset_layer(layer: Image.Image, dx: float, dy: float) -> Image.Image:
    x_offset = round(dx)
    y_offset = round(dy)
    canvas = Image.new("RGBA", layer.size, (0, 0, 0, 0))

    src_left = max(0, -x_offset)
    src_top = max(0, -y_offset)
    src_right = min(layer.width, layer.width - x_offset)
    src_bottom = min(layer.height, layer.height - y_offset)
    if src_left >= src_right or src_top >= src_bottom:
        return canvas

    crop = layer.crop((src_left, src_top, src_right, src_bottom))
    canvas.alpha_composite(crop, (max(0, x_offset), max(0, y_offset)))
    return clean_transparent_pixels(canvas)


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
    body_mask, neck_mask, head_mask = make_layer_masks(base)
    body_layer = apply_alpha_mask(base, body_mask)
    neck_layer = apply_alpha_mask(base, neck_mask)
    head_layer = apply_alpha_mask(base, head_mask)
    frames: list[Image.Image] = []
    for dx, dy in make_offsets():
        frame = offset_layer(body_layer, dx, dy)
        frame.alpha_composite(
            offset_layer(neck_layer, dx * ELASTIC_NECK_FOLLOW, dy * ELASTIC_NECK_FOLLOW)
        )
        frame.alpha_composite(head_layer)
        frames.append(clean_transparent_pixels(frame))
    weight = Image.fromarray(np.uint8(np.round(body_mask * 255)), "L")
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
        default=None,
        help="Optional path for a frame-strip preview.",
    )
    parser.add_argument(
        "--weight-preview",
        type=Path,
        default=None,
        help="Optional path for the body motion mask preview.",
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
        exact=True,
    )
    if args.preview:
        save_preview(frames, args.preview)
    if args.weight_preview:
        save_weight_preview(weight, args.weight_preview)

    with Image.open(args.out) as animated:
        frame_count = sum(1 for _ in ImageSequence.Iterator(animated))

    print(f"wrote {args.out} ({frame_count} frames)")
    if args.preview:
        print(f"wrote {args.preview}")
    if args.weight_preview:
        print(f"wrote {args.weight_preview}")
    print(f"timing: {frame_count - 1} motion frames @ {FRAME_DURATION_MS}ms + 1 pause @ {PAUSE_DURATION_MS}ms")


if __name__ == "__main__":
    main()

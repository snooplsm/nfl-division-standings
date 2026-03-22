#!/usr/bin/env python3
"""
Remove video background frame-by-frame and export transparent WebM.

Requirements:
  - ffmpeg + ffprobe available on PATH
  - rembg CLI available on PATH (`pip install rembg`)

Usage:
  python3 scripts/remove_bg_video.py /path/to/input.mp4
  python3 scripts/remove_bg_video.py /path/to/input.mp4 -o /path/to/output.webm
"""

from __future__ import annotations

import argparse
import pathlib
import shutil
import subprocess
import sys
import tempfile
from typing import Sequence


def run(cmd: Sequence[str]) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True)


def require_bin(name: str) -> None:
    if shutil.which(name):
        return
    print(f"Missing required binary: {name}", file=sys.stderr)
    sys.exit(2)


def parse_fps(input_path: pathlib.Path) -> str:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate",
        "-of",
        "default=nokey=1:noprint_wrappers=1",
        str(input_path),
    ]
    try:
        out = subprocess.check_output(cmd, text=True).strip()
        if "/" in out:
            num_s, den_s = out.split("/", 1)
            num = float(num_s)
            den = float(den_s)
            if den > 0:
                return f"{(num / den):.6f}"
        if out:
            val = float(out)
            if val > 0:
                return f"{val:.6f}"
    except Exception:
        pass
    return "30"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Remove background from video and export transparent WebM."
    )
    parser.add_argument("input", help="Input video path")
    parser.add_argument(
        "-o",
        "--output",
        help="Output WebM path (default: <input-stem>-transparent.webm)",
    )
    parser.add_argument(
        "--crf",
        type=int,
        default=30,
        help="VP9 CRF quality (lower = better quality, larger file). Default: 30",
    )
    args = parser.parse_args()

    require_bin("ffmpeg")
    require_bin("ffprobe")
    require_bin("rembg")

    input_path = pathlib.Path(args.input).expanduser().resolve()
    if not input_path.exists():
        print(f"Input not found: {input_path}", file=sys.stderr)
        return 1

    if args.output:
        output_path = pathlib.Path(args.output).expanduser().resolve()
    else:
        output_path = input_path.with_name(f"{input_path.stem}-transparent.webm")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    fps = parse_fps(input_path)
    print(f"Using FPS: {fps}")

    with tempfile.TemporaryDirectory(prefix="removebg_video_") as tmp:
        tmp_path = pathlib.Path(tmp)
        frames_in = tmp_path / "frames_in"
        frames_out = tmp_path / "frames_out"
        frames_in.mkdir(parents=True, exist_ok=True)
        frames_out.mkdir(parents=True, exist_ok=True)

        # 1) Extract frames
        run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(input_path),
                "-an",
                "-vsync",
                "0",
                str(frames_in / "frame_%06d.png"),
            ]
        )

        # 2) Remove background on all frames
        run(["rembg", "p", str(frames_in), str(frames_out)])

        # 3) Encode transparent WebM (VP9 + alpha)
        run(
            [
                "ffmpeg",
                "-y",
                "-framerate",
                fps,
                "-i",
                str(frames_out / "frame_%06d.png"),
                "-c:v",
                "libvpx-vp9",
                "-pix_fmt",
                "yuva420p",
                "-auto-alt-ref",
                "0",
                "-b:v",
                "0",
                "-crf",
                str(args.crf),
                str(output_path),
            ]
        )

    print(f"Done: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


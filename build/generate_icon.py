"""Generate ClaudeBoard app icon."""

import os
from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
PAD = 100
R = 180  # corner radius

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Dark rounded rectangle background
draw.rounded_rectangle(
    [PAD, PAD, SIZE - PAD, SIZE - PAD],
    radius=R,
    fill=(17, 17, 17, 255),
)

# Subtle border
draw.rounded_rectangle(
    [PAD, PAD, SIZE - PAD, SIZE - PAD],
    radius=R,
    outline=(50, 50, 50, 255),
    width=3,
)

# Three "session" rows as rounded bars
bar_x = PAD + 100
bar_w = SIZE - 2 * PAD - 200
bar_h = 64
bar_r = 16
bar_colors = [
    ((74, 222, 128), "idle"),    # green
    ((239, 68, 68), "working"),  # red
    ((74, 222, 128), "idle"),    # green
]

start_y = PAD + 200
gap = 100

for i, (color, _label) in enumerate(bar_colors):
    y = start_y + i * (bar_h + gap)

    # Bar background
    draw.rounded_rectangle(
        [bar_x, y, bar_x + bar_w, y + bar_h],
        radius=bar_r,
        fill=(30, 30, 30, 255),
    )

    # Status dot with glow
    dot_x = bar_x + 44
    dot_y = y + bar_h // 2
    dot_r = 16

    # Glow
    for gr in range(dot_r + 12, dot_r, -1):
        alpha = int(40 * (1 - (gr - dot_r) / 12))
        draw.ellipse(
            [dot_x - gr, dot_y - gr, dot_x + gr, dot_y + gr],
            fill=(*color, alpha),
        )

    # Solid dot
    draw.ellipse(
        [dot_x - dot_r, dot_y - dot_r, dot_x + dot_r, dot_y + dot_r],
        fill=(*color, 255),
    )

    # Text-like bar (simulating session label)
    text_x = dot_x + 40
    text_w = bar_w - 130
    draw.rounded_rectangle(
        [text_x, y + 22, text_x + text_w, y + 42],
        radius=6,
        fill=(*color, 60),
    )

# "CB" letters at top
try:
    font = ImageFont.truetype("/System/Library/Fonts/SFCompact.ttf", 80)
except OSError:
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 80)
    except OSError:
        font = ImageFont.load_default()

draw.text(
    (SIZE // 2, PAD + 120),
    "CB",
    fill=(102, 102, 102, 255),
    font=font,
    anchor="mm",
)

img.save(os.path.join(os.path.dirname(__file__), "icon.png"))
print("icon.png saved")

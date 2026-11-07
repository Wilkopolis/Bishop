from PIL import Image

im = Image.open('compare.png')
print("Image size:", im.size)

# The card sections:
# We know the card background is #252322 (approx 37, 35, 34)
# Let's find rows where cards are located.
# Let's scan y from 0 to 700 at x = 200 to see backgrounds:
card_bg = (37, 35, 34)
# Let's crop each card and analyze
# We know the width is 550px, card starts around x=20, ends around x=570
# Let's find the cards by looking at background color
cards = []
in_card = False
card_start = 0
for y in range(im.height):
    p = im.getpixel((100, y))
    is_card = abs(p[0] - 37) < 3 and abs(p[1] - 35) < 3 and abs(p[2] - 34) < 3
    if is_card and not in_card:
        in_card = True
        card_start = y
    elif not is_card and in_card:
        in_card = False
        cards.append((card_start, y))

print("Found cards at:", cards)

for idx, (cy1, cy2) in enumerate(cards):
    print(f"\n--- Card {idx + 1} (y={cy1} to {cy2}) ---")
    # In each card, there are 2 rows.
    # First row: "Align the first line of task text with the status bullet"
    # Second row: "the alignment is a bit off still..."
    # The bullet is roughly at x between 50 and 85
    # The text is roughly at x between 85 and 500
    # Let's find bullet pixels in card
    for row_num, y_range in enumerate([(cy1 + 5, cy1 + 45), (cy1 + 40, cy2 - 5)]):
        b_pixels = []
        for y in range(y_range[0], y_range[1]):
            for x in range(50, 85):
                p = im.getpixel((x, y))
                if sum(abs(p[i] - 37) for i in range(3)) > 30:
                    b_pixels.append((x, y))
        
        t_pixels = []
        for y in range(y_range[0], y_range[1]):
            for x in range(90, 250):
                p = im.getpixel((x, y))
                if sum(abs(p[i] - 37) for i in range(3)) > 30:
                    t_pixels.append((x, y))
        
        if b_pixels and t_pixels:
            by_min, by_max = min(y for x, y in b_pixels), max(y for x, y in b_pixels)
            ty_min, ty_max = min(y for x, y in t_pixels), max(y for x, y in t_pixels)
            print(f"Row {row_num + 1}:")
            print(f"  Bullet: y=[{by_min}, {by_max}], height={by_max - by_min + 1}, center={(by_min + by_max)/2:.1f}")
            print(f"  Text L1: y=[{ty_min}, {ty_max}], height={ty_max - ty_min + 1}, center={(ty_min + ty_max)/2:.1f}")
            print(f"  Top delta (Text - Bullet): {ty_min - by_min}")
            print(f"  Center delta (Text - Bullet): {(ty_min + ty_max)/2 - (by_min + by_max)/2:.1f}")
            print(f"  Bottom delta (Text - Bullet): {ty_max - by_max}")

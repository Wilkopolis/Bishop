from PIL import Image

im = Image.open('C:/Projects/Repos/Bishop/test.png')
# Background is #252322 = (37, 35, 34)
# Let's crop around x: 80 to 250, y: 55 to 110
bg = im.getpixel((80, 55))
print(f"Background color: {bg}")

# Let's find visible pixels for the bullet (x between 86 and 102)
bullet_pixels = []
for y in range(55, 95):
    for x in range(85, 103):
        p = im.getpixel((x, y))
        # check distance from bg
        if sum(abs(p[i] - bg[i]) for i in range(3)) > 30:
            bullet_pixels.append((x, y))

# Let's find visible pixels for the first line of text (x between 110 and 200, y between 55 and 85)
text_pixels = []
for y in range(55, 85):
    for x in range(110, 200):
        p = im.getpixel((x, y))
        if sum(abs(p[i] - bg[i]) for i in range(3)) > 30:
            text_pixels.append((x, y))

bullet_ys = [y for x, y in bullet_pixels]
text_ys = [y for x, y in text_pixels]

print(f"Bullet Y min: {min(bullet_ys)}, max: {max(bullet_ys)}, center: {(min(bullet_ys) + max(bullet_ys))/2}")
print(f"Text line 1 Y min: {min(text_ys)}, max: {max(text_ys)}, center: {(min(text_ys) + max(text_ys))/2}")

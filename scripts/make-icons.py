#!/usr/bin/env python3
"""重新生成所有图标（需要 Pillow）：python3 scripts/make-icons.py
输出：app/assets/{trayTemplate,trayTemplate@2x,tray,tray-win,icon}.png，scripts/res/{icon_1024.png,app.icns}"""
import io, struct, pathlib
from PIL import Image, ImageDraw, ImageFilter
ROOT = pathlib.Path(__file__).resolve().parent.parent
A, RES = ROOT / "app" / "assets", ROOT / "scripts" / "res"
SS = 4

def tray(sz):  # macOS 模板图标：黑色 + 透明，系统自动适配深浅色菜单栏
    S = sz * SS; im = Image.new("RGBA", (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    w = int(S * 0.44); x0 = (S - w) // 2
    d.rounded_rectangle([x0, int(S * .04), x0 + w, int(S * .96)], radius=w // 2, outline=(0, 0, 0, 255), width=max(SS, int(S * .075)))
    r = int(w * .26); cx = S // 2
    for cy, arc in ((int(S * .33), 270), (int(S * .67), 150)):
        lw = max(SS, int(S * .07))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(0, 0, 0, 110), width=lw)
        d.arc([cx - r, cy - r, cx + r, cy + r], -90, -90 + arc, fill=(0, 0, 0, 255), width=lw)
    return im.resize((sz, sz), Image.LANCZOS)

def app_icon():
    S = 2048; im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sh = Image.new("RGBA", (S, S), (0, 0, 0, 0)); ImageDraw.Draw(sh).rounded_rectangle([200, 236, 1848, 1884], radius=370, fill=(0, 0, 0, 120))
    im = Image.alpha_composite(im, sh.filter(ImageFilter.GaussianBlur(40)))
    body = Image.new("RGBA", (S, S), (0, 0, 0, 0)); bd = ImageDraw.Draw(body)
    bd.rounded_rectangle([200, 200, 1848, 1848], radius=370, fill=(0, 0, 0, 255))
    bx0, bx1, f, top, bot = 1080, 1848, 110, 380, 1668
    g = (28, 28, 30, 255)
    bd.rounded_rectangle([bx0, top, bx1 + 200, bot], radius=150, fill=g)
    bd.rectangle([bx1 - f, top - f, bx1, top], fill=g); bd.ellipse([bx1 - 2 * f, top - 2 * f, bx1, top], fill=(0, 0, 0, 255))
    bd.rectangle([bx1 - f, bot, bx1, bot + f], fill=g); bd.ellipse([bx1 - 2 * f, bot, bx1, bot + 2 * f], fill=(0, 0, 0, 255))
    cx = (bx0 + bx1) // 2 - 10
    for cy, p, col in ((640, .73, (255, 90, 31)), (1024, .21, (48, 209, 88)), (1408, .52, (255, 214, 10))):
        r = 150
        bd.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(58, 58, 60, 255), width=34)
        bd.arc([cx - r, cy - r, cx + r, cy + r], -90, -90 + 360 * p, fill=col + (255,), width=34)
        bd.ellipse([cx - 46, cy - 46, cx + 46, cy + 46], fill=(255, 255, 255, 255))
    bd.rounded_rectangle([330, 480, 980, 880], radius=80, fill=g)
    bd.polygon([(978, 600), (1040, 640), (978, 680)], fill=g)
    for y, w2, col in ((640, 765, (255, 90, 31, 255)), (770, 440, (48, 209, 88, 255))):
        bd.rounded_rectangle([400, y, 900, y + 36], radius=18, fill=(58, 58, 60, 255)); bd.rounded_rectangle([400, y, w2, y + 36], radius=18, fill=col)
    bd.rounded_rectangle([400, 548, 700, 584], radius=18, fill=(235, 235, 245, 200))
    mask = Image.new("L", (S, S), 0); ImageDraw.Draw(mask).rounded_rectangle([200, 200, 1848, 1848], radius=370, fill=255)
    body.putalpha(Image.composite(body.split()[3], Image.new("L", (S, S), 0), mask))
    return Image.alpha_composite(im, body).resize((1024, 1024), Image.LANCZOS)

def icns(im, path):
    def png(sz):
        b = io.BytesIO(); im.resize((sz, sz), Image.LANCZOS).save(b, "PNG"); return b.getvalue()
    ents = [(b"ic07", 128), (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024), (b"ic11", 32), (b"ic12", 64), (b"ic13", 256), (b"ic14", 512)]
    data = b"".join(t + struct.pack(">I", 8 + len(p)) + p for t, p in ((t, png(s)) for t, s in ents))
    path.write_bytes(b"icns" + struct.pack(">I", 8 + len(data)) + data)

if __name__ == "__main__":
    A.mkdir(parents=True, exist_ok=True); RES.mkdir(parents=True, exist_ok=True)
    tray(18).save(A / "trayTemplate.png"); tray(36).save(A / "trayTemplate@2x.png")
    t = tray(32); w = Image.new("RGBA", t.size, (0, 0, 0, 0)); w.paste(Image.new("RGBA", t.size, (255, 255, 255, 255)), mask=t.split()[3]); w.save(A / "tray.png")
    ic = app_icon(); ic.save(RES / "icon_1024.png")
    ic.resize((256, 256), Image.LANCZOS).save(A / "icon.png"); ic.resize((32, 32), Image.LANCZOS).save(A / "tray-win.png")
    ic.resize((256, 256), Image.LANCZOS).save(RES / "icon_256.png")  # Windows exe 图标（最大 256）
    icns(ic, RES / "app.icns")
    print("icons ok")

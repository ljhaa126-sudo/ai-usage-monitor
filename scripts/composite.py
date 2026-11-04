import sys
from PIL import Image, ImageDraw, ImageFilter
import random
def wall(w,h):
    im=Image.new("RGB",(w,h)); d=ImageDraw.Draw(im)
    for y in range(h):
        t=y/h
        d.line([(0,y),(w,y)],fill=(int(40+60*t),int(140-40*t),int(170-60*t)))
    # 彩色流光
    ov=Image.new("RGBA",(w,h),(0,0,0,0)); od=ImageDraw.Draw(ov)
    for i in range(14):
        x=random.Random(i).randint(0,w); col=[(255,140,60,90),(255,220,120,70),(40,200,220,80)][i%3]
        od.ellipse([x-200,-100,x+60,h+100],fill=col)
    ov=ov.filter(ImageFilter.GaussianBlur(70))
    return Image.alpha_composite(im.convert("RGBA"),ov)
src=sys.argv[1]; out=sys.argv[2]; crop=sys.argv[3] if len(sys.argv)>3 else "right"
o=Image.open(src).convert("RGBA")
bg=wall(o.width,o.height)
c=Image.alpha_composite(bg,o)
if crop=="right": c=c.crop((o.width-560,0,o.width,o.height))
elif crop=="left": c=c.crop((0,0,560,o.height))
c.convert("RGB").save(out)

import asyncio, json, time
from playwright.async_api import async_playwright
now = int(time.time()*1000)
W = lambda key,label,p,ms,mins=0,detail="": dict(key=key,label=label,usedPercent=p,resetsAt=now+ms,windowMinutes=mins,detail=detail)
def S(id,name,**x):
    b=dict(id=id,name=name,short=name,tagline="",color="#fff",dashboard="https://x",login="",keyKind="",enabled=True,state="ok",message="",plan="",account="",source="",primary=None,secondary=None,extra=[],headline=0,headlineKey="",resetCount=0,planEndsAt=0,credits="",history=[],historyUnit="峰值 %",activeDays=[],updatedAt=now-5000,lagging=False)
    b.update(x); return b
lst=[S("claude","Claude",headline=73,primary=W("5h","当前会话",73,51*60000+8000,300),secondary=W("week","所有模型 · 本周",7,3*864e5,10080)),
     S("codex","Codex",headline=21,lagging=True,primary=W("5h","当前会话",21,3600e3,300)),
     S("gemini","Gemini",state="nologin",message="x"),S("kimi","Kimi",state="loading",updatedAt=0)]
cfg=dict(style="minimal",hideIdle=True,dock=dict(mode="edge",edge="right",y=0.3,x=0.5))
init = "window.aimon={state:async()=>({cfg:%s,list:%s}),onUpdate:f=>{window.__push=f},onConfig:f=>{},setIgnore:()=>{},refresh:async()=>{},openUrl:async()=>{},openSettings:async()=>{},contextMenu:async()=>{},dragEnd:async p=>p.dock};" % (json.dumps(cfg), json.dumps(lst))
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={"width":1200,"height":800})
        errs=[]; pg.on("pageerror",lambda e:errs.append(str(e))); pg.on("console",lambda m: m.type=="error" and errs.append(m.text))
        await pg.add_init_script(init)
        await pg.goto("" + __import__("pathlib").Path(__file__).resolve().parent.parent.joinpath("app/renderer/overlay.html").as_uri() + ""); await pg.wait_for_timeout(400)
        ids=await pg.eval_on_selector_all(".item","els=>els.map(e=>e.dataset.id)")
        print("竖条显示:",ids,"(应只有 claude, codex)")
        await pg.evaluate("window.__test.showPop('claude')"); await pg.wait_for_timeout(300)
        await pg.evaluate("window.__pc=document.querySelector('#pop .pc'); window.__tail=document.querySelector('#pop .tail')")
        t1=await pg.text_content("#pop [data-cd]"); await pg.wait_for_timeout(2100); t2=await pg.text_content("#pop [data-cd]")
        same=await pg.evaluate("document.querySelector('#pop .pc')===window.__pc && document.querySelector('#pop .tail')===window.__tail")
        print("倒计时:",t1,"→",t2,"| 气泡/尾巴未重建:",same)
        # 推送一次相同数据，竖条结构不应重建
        await pg.evaluate("window.__it=document.querySelector('.item')")
        await pg.evaluate("window.__push(%s)" % json.dumps(lst))
        print("推送更新后竖条 DOM 未重建:", await pg.evaluate("document.querySelector('.item')===window.__it"))
        await pg.evaluate("window.__test.hidePop(true); window.__test.showPop('codex')"); await pg.wait_for_timeout(300)
        print("Codex 气泡底部:", await pg.text_content("#pop .foot"))
        print("JS 错误:", errs or "无")
        await b.close()
asyncio.run(main())

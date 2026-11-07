import asyncio, json, base64, subprocess, urllib.request, websockets, time

async def main():
    edge = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
    p = subprocess.Popen([edge, '--headless=new', '--remote-debugging-port=9222', 'about:blank'])
    time.sleep(1)
    try:
        pages = json.loads(urllib.request.urlopen('http://127.0.0.1:9222/json').read())
        page = [p for p in pages if p['type'] == 'page'][0]
        ws_url = page['webSocketDebuggerUrl']

        async with websockets.connect(ws_url) as ws:
            await ws.send(json.dumps({'id': 1, 'method': 'Page.enable'}))
            await ws.recv()
            
            await ws.send(json.dumps({
                'id': 2,
                'method': 'Page.navigate',
                'params': {'url': 'file:///C:/Projects/Repos/Bishop/dist/assets/compare.html'}
            }))
            await ws.recv()
            await asyncio.sleep(1)

            await ws.send(json.dumps({'id': 3, 'method': 'Page.captureScreenshot'}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get('id') == 3:
                    resp = msg
                    break

            data = base64.b64decode(resp['result']['data'])
            with open('compare.png', 'wb') as f:
                f.write(data)
            print("Successfully saved compare.png")
    finally:
        p.terminate()

asyncio.run(main())

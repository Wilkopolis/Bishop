import http.server, socketserver, threading, subprocess, json, time, os

data = {}
class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers['Content-Length'])
        body = self.rfile.read(length)
        data['metrics'] = json.loads(body.decode('utf-8'))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')

server = socketserver.TCPServer(('127.0.0.1', 45999), Handler)
def serve():
    while not data:
        server.handle_request()
t = threading.Thread(target=serve)
t.start()

html = '''<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="http://127.0.0.1:45999/dist/assets/index-BEAD14Iw.css">
<style>
body { background: #151413; color: #e7e5e4; padding: 40px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif; }
</style>
</head>
<body class="dark">
  <div style="width: 500px; background: #252322; padding: 16px; border-radius: 8px;">
    <ul class="flex flex-col">
      <li id="row" class="group flex items-start gap-2 px-2 py-1.5 rounded hover:bg-[var(--card)]">
        <button id="grip" class="shrink-0 -ml-1 p-0.5 rounded cursor-grab active:cursor-grabbing opacity-30 group-hover:opacity-70 focus-visible:opacity-100 mt-0.5">
          <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor"><circle cx="96" cy="60" r="16"/><circle cx="160" cy="60" r="16"/><circle cx="96" cy="128" r="16"/><circle cx="160" cy="128" r="16"/><circle cx="96" cy="196" r="16"/><circle cx="160" cy="196" r="16"/></svg>
        </button>
        <button id="bullet" class="shrink-0 w-4 h-4 rounded border grid place-items-center mt-0.5 border-[var(--task-unassigned)]">
        </button>
        <span id="text" style="margin-top: -3px;" class="flex-1 min-w-0 text-sm break-words select-text">Align the first line of task text with the status bullet</span>
      </li>
    </ul>
  </div>
  <script>
    window.addEventListener('load', () => {
      const bullet = document.getElementById('bullet').getBoundingClientRect();
      const text = document.getElementById('text').getBoundingClientRect();
      const grip = document.getElementById('grip').getBoundingClientRect();
      const range = document.createRange();
      const textNode = document.getElementById('text').firstChild;
      range.setStart(textNode, 0);
      range.setEnd(textNode, 13); // "the alignment"
      const wordRect = range.getBoundingClientRect();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.font = window.getComputedStyle(document.getElementById('text')).font;
      const textMetrics = ctx.measureText("Align the first line");
      const fontInfo = {
        actualBoundingBoxAscent: textMetrics.actualBoundingBoxAscent,
        actualBoundingBoxDescent: textMetrics.actualBoundingBoxDescent,
        fontBoundingBoxAscent: textMetrics.fontBoundingBoxAscent,
        fontBoundingBoxDescent: textMetrics.fontBoundingBoxDescent,
      };
      fetch('http://127.0.0.1:45999', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ bullet, text, grip, wordRect, fontInfo })
      });
    });
  </script>
</body>
</html>'''

open('dist/assets/measure.html', 'w', encoding='utf-8').write(html)
edge = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
proc = subprocess.Popen([edge, '--headless', 'http://127.0.0.1:45999/dist/assets/measure.html'])
t.join(timeout=5)
proc.terminate()
server.server_close()
print(json.dumps(data.get('metrics', {}), indent=2))

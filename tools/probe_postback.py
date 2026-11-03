"""Maintenance helper for the probe workflow: run an ASP.NET export postback (Oregon) and save
what comes back to out/. Usage: python tools/probe_postback.py URL EVENTTARGET [EVENTTARGET ...]"""
import http.cookiejar
import re
import sys
import urllib.parse
import urllib.request

url, targets = sys.argv[1], sys.argv[2:]
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
UA = {"User-Agent": "election-night-tracker (watch party; github.com/hantsiakiann)"}
html = op.open(urllib.request.Request(url, headers=UA), timeout=60).read().decode("utf-8", "replace")
fields = dict(re.findall(r'<input type="hidden" name="([^"]+)" id="[^"]*" value="([^"]*)"', html))
for i, t in enumerate(targets, 1):
    form = dict(fields, __EVENTTARGET=t, __EVENTARGUMENT="")
    form["ctl00$MainContent$rblTypes"] = "1"
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(), headers=dict(UA, **{
        "Content-Type": "application/x-www-form-urlencoded", "Referer": url}))
    try:
        r = op.open(req, timeout=60)
        body = r.read()
        info = f"status={r.status} type={r.headers.get('Content-Type')} disp={r.headers.get('Content-Disposition')} size={len(body)}"
    except Exception as e:
        body, info = b"", f"error {e}"
    print(t, info)
    with open(f"out/post{i}.txt", "wb") as f:
        f.write(body[:8000000])
    with open("out/summary.txt", "a") as f:
        f.write(f"### POST {t}\n{info}\n")

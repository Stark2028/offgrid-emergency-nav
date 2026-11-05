"""Check an installed optimized pilot through Android accessibility, without CDP.

Requires an explicitly selected, authorized phone. Never clears data, grants
permissions, changes system settings, or captures screens/location coordinates.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
APP = "org.offgrid.navigation"
SERIAL = os.environ.get("OFFGRID_ADB_SERIAL")
if not SERIAL:
    raise SystemExit("Select the authorized phone with OFFGRID_ADB_SERIAL.")
SDK = Path(os.environ.get("ANDROID_HOME", str(Path(os.environ.get("LOCALAPPDATA", "")) / "Android/Sdk")))
ADB = SDK / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")
TEMP = "/data/local/tmp/offgrid-release-window.xml"


def adb(*args):
    return subprocess.check_output([str(ADB), "-s", SERIAL, *args], timeout=40)


def screen():
    focus = next((line for line in adb("shell", "dumpsys", "window").decode().splitlines() if "mCurrentFocus=" in line), "")
    if APP not in focus:
        raise RuntimeError("OFFGRID must be foreground; refusing another app's screen.")
    try:
        adb("shell", "uiautomator", "dump", TEMP)
        return list(ET.fromstring(adb("exec-out", "cat", TEMP)).iter("node"))
    finally:
        adb("shell", "rm", "-f", TEMP)


def matches(nodes, text):
    return [n for n in nodes if text in (n.get("text", "") or n.get("content-desc", ""))]


def wait_for(text, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        nodes = screen()
        if matches(nodes, text):
            return nodes
        time.sleep(1)
    raise RuntimeError(f"OFFGRID did not show {text!r}.")


def click(text):
    for _ in range(10):
        candidates = matches(screen(), text)
        for node in candidates:
            x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.get("bounds", "[0,0][0,0]")))
            if x2 - x1 > 10 and y2 - y1 > 10:
                adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
                return
        # Android clips offscreen HTML nodes to the nearest viewport edge.
        above = candidates and int(re.findall(r"\d+", candidates[0].get("bounds"))[1]) < height // 2
        start, end = (height * 0.3, height * 0.75) if above else (height * 0.75, height * 0.3)
        adb("shell", "input", "swipe", str(width // 2), str(int(start)), str(width // 2), str(int(end)), "350")
    raise RuntimeError(f"OFFGRID button {text!r} was not reachable.")


size = adb("shell", "wm", "size").decode()
width, height = map(int, re.findall(r"(\d+)x(\d+)", size)[-1])
report = {"model": adb("shell", "getprop", "ro.product.model").decode().strip(), "android": adb("shell", "getprop", "ro.build.version.release").decode().strip(), "checks": {}}
try:
    apk = adb("shell", "pm", "path", APP).decode().strip().splitlines()[0].removeprefix("package:")
    report["installedApkSha256"] = hashlib.sha256(adb("exec-out", "cat", apk)).hexdigest()
    pid = adb("shell", "pidof", APP).decode().strip()
    sockets = adb("shell", "cat", "/proc/net/unix").decode()
    if f"webview_devtools_remote_{pid}" in sockets:
        raise RuntimeError("Expected an optimized build with WebView debugging disabled.")
    report["checks"]["webViewDebuggingDisabled"] = True
    wait_for("Saved on this device")
    report["checks"]["existingPrayagrajPreserved"] = True
    click("Check offline files")
    wait_for("Offline file check passed")
    report["checks"]["nativeFileVerification"] = True
    click("Open walking navigation")
    wait_for("Where are you heading?")
    report["checks"]["navigationOpened"] = True
    adb("shell", "input", "keyevent", "4")
    wait_for("Open walking navigation")
    report["checks"]["nativeBack"] = True
    report["passed"] = True
    print(json.dumps(report, indent=2))
except Exception:
    report["passed"] = False
    raise
finally:
    output = ROOT / ".impeccable/review/samsung-optimized-smoke.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

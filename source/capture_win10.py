"""Win10 visual smoke test: open File Bridge, press PrintScreen, save clipboard PNG."""
import ctypes
import os
import subprocess
import time
from pathlib import Path

from PIL import ImageGrab

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "artifacts" / "file-bridge-win10-fullscreen.png"
URL = os.environ.get('FILE_BRIDGE_TEST_URL', '')
if not URL:
    raise SystemExit('Set FILE_BRIDGE_TEST_URL to your private local File Bridge URL')
OUT.parent.mkdir(parents=True, exist_ok=True)

def key_press(vk: int) -> None:
    user32 = ctypes.windll.user32
    user32.keybd_event(vk, 0, 0, 0)
    time.sleep(0.08)
    user32.keybd_event(vk, 0, 2, 0)

browser_candidates = [
    os.environ.get("FILE_BRIDGE_BROWSER", ""),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Users\Administrator\AppData\Local\ms-playwright\chromium-1228\chrome-win64\chrome.exe",
]
browser = next((p for p in browser_candidates if p and Path(p).exists()), None)
if not browser:
    raise SystemExit("No Chromium-based browser found")
subprocess.Popen([browser, "--new-window", URL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(4)
key_press(0x2C)  # VK_SNAPSHOT / PrintScreen: full desktop on Win10
time.sleep(1)
image = ImageGrab.grabclipboard()
if image is None:
    raise SystemExit("PrintScreen did not produce a clipboard image")
image.convert("RGB").save(OUT, "PNG")
w, h = image.size
if w < 800 or h < 600:
    raise SystemExit(f"Unexpected screenshot size: {w}x{h}")
if len(image.getbbox() or ()) != 4:
    raise SystemExit("Screenshot is empty")
print(f"SCREENSHOT_OK={OUT}")
print(f"SIZE={w}x{h}")

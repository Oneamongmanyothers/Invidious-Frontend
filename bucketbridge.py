import os
import json
import sys
import ctypes
import threading
import subprocess
import glob
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import pystray
from PIL import Image, ImageDraw

app = Flask(__name__)
CORS(app, origins=["http://127.0.0.1:3000", "http://localhost:3000"])

# --- CONFIGURATION ---
# Replace this with the path to where you want your buckets.json saved globally
PROTON_PATH = r"C:\Path\To\Your\Cloud\Drive\buckets.json"

# --- HELPER: PYINSTALLER PATHS ---
def get_resource_path(relative_path):
    """ Get absolute path to resource, works for dev and for PyInstaller """
    try:
        # PyInstaller creates a temp folder and stores path in _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

ICON_FILE = get_resource_path("sync.png")

# --- MUTEX ---
MUTEX_NAME = "Local\\BucketBridge_Sync_Mutex_Unique_ID"
kernel32 = ctypes.windll.kernel32
_mutex = kernel32.CreateMutexW(None, False, MUTEX_NAME)
last_error = kernel32.GetLastError()

def is_already_running():
    return last_error == 183

# --- STORAGE ---
def load_from_disk():
    if not os.path.exists(PROTON_PATH):
        return {}
    try:
        with open(PROTON_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"[Error] Reading: {e}")
        return {}

def save_to_disk(data):
    try:
        if os.path.exists(PROTON_PATH):
            bak_path = PROTON_PATH + ".bak"
            if os.path.exists(bak_path):
                try:
                    os.remove(bak_path)
                except OSError:
                    pass
            os.rename(PROTON_PATH, bak_path)
        with open(PROTON_PATH, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)
        return True
    except Exception as e:
        print(f"[Error] Writing: {e}")
        return False

# --- ROUTES ---
@app.route('/get-transcript', methods=['GET'])
def get_transcript():
    video_id = request.args.get('v')
    if not video_id:
        return jsonify({"error": "No video ID provided"}), 400

    try:
        startupinfo = None
        if os.name == 'nt':
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

        exe_path = get_resource_path("yt-dlp.exe")
        temp_filename = f"transcript_{video_id}"

        for old_file in glob.glob(f"{temp_filename}*.vtt"):
            try:
                os.remove(old_file)
            except:
                pass

        command =[
            exe_path,
            '--write-auto-sub',
            '--skip-download',
            '--convert-subs', 'vtt',
            '--output', temp_filename,
            f'https://www.youtube.com/watch?v={video_id}'
        ]

        subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='ignore',
            startupinfo=startupinfo
        )

        found_files = glob.glob(f"{temp_filename}*.vtt")

        if not found_files:
            return jsonify({"error": "yt-dlp did not create a subtitle file"}), 500

        file_path = found_files[0]
        with open(file_path, 'r', encoding='utf-8') as f:
            vtt_content = f.read()

        try:
            os.remove(file_path)
        except:
            pass

        return jsonify({"vtt_content": vtt_content})

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/get-buckets', methods=['GET'])
def get_buckets():
    return jsonify(load_from_disk())

@app.route('/save-buckets', methods=['POST'])
def save_buckets():
    if save_to_disk(request.json):
        return jsonify({"status": "success"}), 200
    return jsonify({"status": "error"}), 500

@app.route('/icon.png')
def get_icon():
    if os.path.exists(ICON_FILE):
        return send_file(ICON_FILE, mimetype='image/png')
    return "Not Found", 404

# --- SYSTEM TRAY ---
def run_flask_wrapper():
    app.run(port=5001, host='127.0.0.1', debug=False, use_reloader=False)

def on_quit_callback(icon, item):
    icon.stop()
    os._exit(0)

def get_tray_icon_image():
    if os.path.exists(ICON_FILE):
        return Image.open(ICON_FILE)
    img = Image.new('RGB', (64, 64), (0, 120, 215))
    dc = ImageDraw.Draw(img)
    dc.rectangle((16, 16, 48, 48), fill="white")
    return img

if __name__ == '__main__':
    if is_already_running():
        ctypes.windll.user32.MessageBoxW(0, "BucketBridge is already running.", "Instance Manager", 0x40 | 0x1000)
        sys.exit(0)

    print("--- BucketBridge Cloud Sync Active ---")
    server_thread = threading.Thread(target=run_flask_wrapper)
    server_thread.daemon = True
    server_thread.start()

    menu = pystray.Menu(pystray.MenuItem("Quit BucketBridge", on_quit_callback))
    icon = pystray.Icon("BucketBridge", get_tray_icon_image(), "Invidious Cloud Sync", menu)
    icon.run()
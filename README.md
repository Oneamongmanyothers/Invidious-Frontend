# 🪣 BucketBridge: Invidious Cloud Sync & Transcript Backend

**BucketBridge** is the companion backend server for the [Invidious Context Buckets frontend script. 

Because privacy-hardened browsers (like LibreWolf) aggressively delete local storage and cache when closed, your custom Invidious categories and settings would normally be wiped out every time you exit your browser. **BucketBridge solves this.** 

It runs quietly in your Windows system tray, acting as a bridge between your web browser and your local hard drive. It saves your configurations to a local file (which you can drop into Proton Drive, Google Drive, or Nextcloud) to perfectly sync your YouTube dashboard across all your computers.

## ✨ What It Does

*   **☁️ Persistent Cloud Sync:** Listens for your browser to send category updates and securely saves them to a local `buckets.json` file. 
*   **📝 Transcript Fetching:** The browser can't bypass YouTube's CORS restrictions to download video subtitles. BucketBridge acts as a proxy, using `yt-dlp` to instantly grab video transcripts and send them back to the frontend for 1-click copying.
*   **👻 Stealth Tray App:** It runs completely in the background as a lightweight system tray icon. 
*   **🔒 Single Instance Lock:** Built-in safeguards ensure you can't accidentally run multiple instances of the server at the same time.

---

## 📦 What's in the Box? (File Breakdown)

Here is exactly what is included in this repository and what it does:

*   **`bucket_bridge.py`**: The brain of the operation. This is a lightweight Python Flask server. It listens on `http://127.0.0.1:5001` for requests from your Tampermonkey script to save your categories or fetch transcripts.
*   **`yt-dlp.exe`**: An open-source command-line tool. BucketBridge triggers this program in the background to safely and quickly download video transcripts directly from YouTube's servers.
*   **`sync.png` & `sync.ico`**: The visual assets for the Windows system tray. 
*   **`BucketBridge.spec`**: A configuration file used by `PyInstaller`. If you want to compile this entire Python project into a single, clickable `.exe` file (so you don't have to run it through a terminal), this file tells PyInstaller how to bundle it all together.

---

## 🛠️ Setup & Installation

### 1. Prerequisites
You will need Python installed on your system. You will also need to install the required Python libraries. Open your terminal/command prompt and run:
\`\`\`bash
pip install flask flask-cors pystray Pillow
\`\`\`

### 2. Set Your Save Location (Crucial!)
Before you run the script, you **must** tell BucketBridge where you want your categories saved. 
1. Open `bucket_bridge.py` in a text editor.
2. Find line 16: `PROTON_PATH = r"C:\Path\To\Your\Cloud\Drive\buckets.json"`
3. Change that path to wherever you want your data saved. If you want it to sync across computers, point it to a folder synced by your cloud provider (Proton Drive, OneDrive, etc.).

### 3. Run It
Simply run `bucket_bridge.py`. A small cloud icon will appear in your Windows system tray, meaning the server is active and listening. Your Tampermonkey script will now automatically detect it and save your settings!

To close the server, just right-click the cloud icon in your system tray and select **"Quit BucketBridge"**.

---

## ⚖️ License & Credits

This project is open-source and licensed under the [MIT License](LICENSE).

**Third-Party Tools & Assets:**
*   **[yt-dlp](https://github.com/yt-dlp/yt-dlp):** Used for fetching video transcripts. Licensed under the[Unlicense](https://unlicense.org/) (Public Domain).
*   **Icons (`sync.png` / `sync.ico`):** Sourced from Material Design Icons. Licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

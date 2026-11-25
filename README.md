# Local File Viewer

A small browser-only app for importing a local folder and viewing text-based files, including XML, in the page.

## Run

Open `index.html` in a modern browser, choose **Import folder**, select a folder, then choose **Load**. The browser asks for permission through its normal folder picker; files stay on your device.

Text files are read through `XMLHttpRequest` using temporary object URLs. Common text formats are previewed; other files show their file size. No dependencies or build step are needed.

Folder selection (`webkitdirectory`) is supported by current Chromium-based browsers and Safari. Browser support and behavior may vary.

# Local Website Preview

A small browser-only tool for previewing a local website from an imported folder.

## Use

Open `index.html` in a modern browser, choose **Import folder**, select the website folder, then choose **Load**. The app looks for `index.html` (or `index.htm`) and displays it in a sandboxed iframe. Local script, stylesheet, image, and other linked file URLs are mapped to files from the selected folder. No files are uploaded and there are no dependencies or build step.

For safety, the preview is sandboxed and cannot access the viewer page. Browser support for folder selection (`webkitdirectory`) may vary. Previews relying on server-side behavior, server-relative routes, or JavaScript `fetch()` requests may not work when loaded directly from local files.

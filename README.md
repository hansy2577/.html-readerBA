# Local Website Preview

A small browser-only tool for previewing a local website from an imported folder.

## Use

Open `index.html` in a modern browser, choose **Import folder**, select the website folder, then choose **Load**. The app finds `index.html` or `index.htm` and displays it in a sandboxed iframe. Local scripts, stylesheets, images, fonts, and other linked files are embedded as data URLs so they work inside the isolated preview without blob-origin 404s. No files are uploaded and there are no dependencies or build step.

For safety, the preview is sandboxed and cannot access the viewer page. Browser support for folder selection (`webkitdirectory`) may vary. Previews relying on server-side behavior, server routes, or JavaScript `fetch()` requests may not work when loaded from local files.

const importButton = document.querySelector("#import-button");
const loadButton = document.querySelector("#load-button");
const folderInput = document.querySelector("#folder-input");
const status = document.querySelector("#status");
const output = document.querySelector("#output");

let selectedFiles = [];
let activeUrls = [];

importButton.addEventListener("click", () => folderInput.click());

folderInput.addEventListener("change", () => {
  selectedFiles = Array.from(folderInput.files);
  output.replaceChildren();
  const count = selectedFiles.length;
  if (!count) {
    status.textContent = "No folder selected.";
    loadButton.disabled = true;
    return;
  }
  status.textContent = `${count} file${count === 1 ? "" : "s"} selected. Press Load to preview index.html.`;
  loadButton.disabled = false;
});

loadButton.addEventListener("click", async () => {
  const entry = selectedFiles.find((file) => /(^|\/)index\.html?$/i.test(file.webkitRelativePath));
  if (!entry) {
    status.textContent = "No index.html was found in the selected folder.";
    return;
  }

  loadButton.disabled = true;
  importButton.disabled = true;
  status.textContent = "Preparing website preview…";
  output.replaceChildren();
  revokeActiveUrls();

  try {
    const urlByPath = new Map();
    for (const file of selectedFiles) {
      const path = normalizePath(file.webkitRelativePath);
      urlByPath.set(path, URL.createObjectURL(file));
      activeUrls.push(urlByPath.get(path));
    }

    const html = await entry.text();
    const previewHtml = await prepareHtml(html, entry.webkitRelativePath, urlByPath);
    const frame = document.createElement("iframe");
    frame.title = `Preview of ${entry.webkitRelativePath}`;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = previewHtml;
    output.append(frame);
    status.textContent = `Previewing ${entry.webkitRelativePath}. The page runs in a sandbox.`;
  } catch (error) {
    status.textContent = `Could not prepare preview: ${error.message}`;
  } finally {
    loadButton.disabled = false;
    importButton.disabled = false;
  }
});

async function prepareHtml(html, entryPath, urlByPath) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const entryDirectory = directoryOf(entryPath);

  for (const element of document.querySelectorAll("[src], [href], [poster], [srcset], [style]")) {
    for (const attribute of ["src", "href", "poster"]) {
      if (element.hasAttribute(attribute)) {
        element.setAttribute(attribute, resolveLocalUrl(element.getAttribute(attribute), entryDirectory, urlByPath));
      }
    }
    if (element.hasAttribute("srcset")) {
      element.setAttribute("srcset", rewriteSrcset(element.getAttribute("srcset"), entryDirectory, urlByPath));
    }
    if (element.hasAttribute("style")) {
      element.setAttribute("style", rewriteCss(element.getAttribute("style"), entryDirectory, urlByPath));
    }
  }

  for (const style of document.querySelectorAll("style")) {
    style.textContent = rewriteCss(style.textContent, entryDirectory, urlByPath);
  }

  for (const stylesheet of selectedFiles.filter((file) => /\.css$/i.test(file.name))) {
    const path = normalizePath(stylesheet.webkitRelativePath);
    const originalUrl = urlByPath.get(path);
    const css = await stylesheet.text();
    const rewrittenCss = rewriteCss(css, directoryOf(path), urlByPath);
    const cssUrl = URL.createObjectURL(new Blob([rewrittenCss], { type: "text/css" }));
    activeUrls.push(cssUrl);
    urlByPath.set(path, cssUrl);
    // Keep an untouched fallback available for CSS @imports that refer to this file.
    if (!originalUrl) urlByPath.set(path, cssUrl);
  }

  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

function rewriteCss(css, baseDirectory, urlByPath) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, value) => {
    const resolved = resolveLocalUrl(value, baseDirectory, urlByPath);
    return `url(${quote}${resolved}${quote})`;
  }).replace(/@import\s+(['"])(.*?)\1/gi, (match, quote, value) => {
    return `@import ${quote}${resolveLocalUrl(value, baseDirectory, urlByPath)}${quote}`;
  });
}

function rewriteSrcset(srcset, baseDirectory, urlByPath) {
  return srcset.split(",").map((candidate) => {
    const parts = candidate.trim().split(/\s+/);
    if (parts[0]) parts[0] = resolveLocalUrl(parts[0], baseDirectory, urlByPath);
    return parts.join(" ");
  }).join(", ");
}

function resolveLocalUrl(value, baseDirectory, urlByPath) {
  const trimmed = value.trim();
  if (!trimmed || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(trimmed)) return value;

  let path;
  try {
    path = decodeURIComponent(new URL(trimmed, `https://local-preview.invalid/${baseDirectory}`).pathname)
      .replace(/^\//, "");
  } catch {
    return value;
  }
  return urlByPath.get(normalizePath(path)) || value;
}

function normalizePath(path) {
  const parts = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function directoryOf(path) {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : `${normalized.slice(0, slash)}/`;
}

function revokeActiveUrls() {
  for (const url of activeUrls) URL.revokeObjectURL(url);
  activeUrls = [];
}

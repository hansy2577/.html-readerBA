const importButton = document.querySelector("#import-button");
const loadButton = document.querySelector("#load-button");
const folderInput = document.querySelector("#folder-input");
const status = document.querySelector("#status");
const output = document.querySelector("#output");

alert("hello2")
let selectedFiles = [];

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

  try {
    const dataUrlByPath = new Map();
    for (const file of selectedFiles) {
      dataUrlByPath.set(normalizePath(file.webkitRelativePath), await fileToDataUrl(file));
    }

    const html = await entry.text();
    const previewHtml = await prepareHtml(html, entry.webkitRelativePath, dataUrlByPath);
    const frame = document.createElement("iframe");
    frame.title = `Preview of ${entry.webkitRelativePath}`;
    // Do not add allow-same-origin: imported scripts must remain isolated from
    // the viewer page. Data URLs avoid cross-origin blob URL failures here.
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

async function prepareHtml(html, entryPath, dataUrlByPath) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const entryDirectory = directoryOf(entryPath);
  const folderRoot = rootOf(entryPath);

  // Convert stylesheets to data URLs too, after rewriting their relative
  // images, fonts, and @imports against the selected folder.
  for (const stylesheet of selectedFiles.filter((file) => /\.css$/i.test(file.name))) {
    const path = normalizePath(stylesheet.webkitRelativePath);
    const css = await stylesheet.text();
    const rewrittenCss = rewriteCss(css, directoryOf(path), folderRoot, dataUrlByPath);
    dataUrlByPath.set(path, `data:text/css;charset=utf-8,${encodeURIComponent(rewrittenCss)}`);
  }

  // Remove <base> so it cannot override local path handling or navigate assets
  // outside the imported site. Relative and site-root local paths are mapped.
  parsed.querySelectorAll("base").forEach((base) => base.remove());
  for (const element of parsed.querySelectorAll("[src], [href], [poster], [srcset], [style]")) {
    for (const attribute of ["src", "href", "poster"]) {
      if (element.hasAttribute(attribute)) {
        element.setAttribute(attribute, resolveLocalUrl(element.getAttribute(attribute), entryDirectory, folderRoot, dataUrlByPath));
      }
    }
    if (element.hasAttribute("srcset")) {
      element.setAttribute("srcset", rewriteSrcset(element.getAttribute("srcset"), entryDirectory, folderRoot, dataUrlByPath));
    }
    if (element.hasAttribute("style")) {
      element.setAttribute("style", rewriteCss(element.getAttribute("style"), entryDirectory, folderRoot, dataUrlByPath));
    }
  }

  for (const style of parsed.querySelectorAll("style")) {
    style.textContent = rewriteCss(style.textContent, entryDirectory, folderRoot, dataUrlByPath);
  }

  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function rewriteCss(css, baseDirectory, folderRoot, dataUrlByPath) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, value) => {
    const resolved = resolveLocalUrl(value, baseDirectory, folderRoot, dataUrlByPath);
    return `url(${quote}${resolved}${quote})`;
  }).replace(/@import\s+(['"])(.*?)\1/gi, (match, quote, value) => {
    return `@import ${quote}${resolveLocalUrl(value, baseDirectory, folderRoot, dataUrlByPath)}${quote}`;
  });
}

function rewriteSrcset(srcset, baseDirectory, folderRoot, dataUrlByPath) {
  return srcset.split(",").map((candidate) => {
    const parts = candidate.trim().split(/\s+/);
    if (parts[0]) parts[0] = resolveLocalUrl(parts[0], baseDirectory, folderRoot, dataUrlByPath);
    return parts.join(" ");
  }).join(", ");
}

function resolveLocalUrl(value, baseDirectory, folderRoot, dataUrlByPath) {
  const trimmed = value.trim();
  if (!trimmed || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(trimmed)) {
    // Root-relative URLs belong to the imported site's root. Keep other
    // schemes (https:, data:, mailto:, etc.) as-is.
    if (!trimmed.startsWith("/")) return value;
  }

  let url;
  try {
    url = new URL(trimmed, `https://local-preview.invalid/${baseDirectory}`);
  } catch {
    return value;
  }
  if (url.origin !== "https://local-preview.invalid") return value;

  let path;
  try {
    path = normalizePath(decodeURIComponent(url.pathname).replace(/^\//, ""));
  } catch {
    return value;
  }

  const fileDataUrl = dataUrlByPath.get(path) || dataUrlByPath.get(normalizePath(`${folderRoot}${path}`));
  if (fileDataUrl) return `${fileDataUrl}${url.hash}`;
  return value;
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

function rootOf(path) {
  const normalized = normalizePath(path);
  const slash = normalized.indexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash + 1);
}

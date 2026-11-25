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
      const url = URL.createObjectURL(file);
      urlByPath.set(path, url);
      activeUrls.push(url);
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
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const entryDirectory = directoryOf(entryPath);
  const folderRoot = rootOf(entryPath);

  // Rewrite stylesheets into new blob URLs so their relative image/font URLs can
  // also be mapped to files from the imported folder.
  for (const stylesheet of selectedFiles.filter((file) => /\.css$/i.test(file.name))) {
    const path = normalizePath(stylesheet.webkitRelativePath);
    const css = await stylesheet.text();
    const rewrittenCss = rewriteCss(css, directoryOf(path), folderRoot, urlByPath);
    const cssUrl = URL.createObjectURL(new Blob([rewrittenCss], { type: "text/css" }));
    activeUrls.push(cssUrl);
    urlByPath.set(path, cssUrl);
  }

  // The paths above are now mapped to the rewritten CSS blob URLs. Rewrite HTML
  // only after creating them, otherwise its stylesheet links keep the old URLs.
  parsed.querySelectorAll("base").forEach((base) => base.remove());
  for (const element of parsed.querySelectorAll("[src], [href], [poster], [srcset], [style]")) {
    for (const attribute of ["src", "href", "poster"]) {
      if (element.hasAttribute(attribute)) {
        element.setAttribute(attribute, resolveLocalUrl(element.getAttribute(attribute), entryDirectory, folderRoot, urlByPath));
      }
    }
    if (element.hasAttribute("srcset")) {
      element.setAttribute("srcset", rewriteSrcset(element.getAttribute("srcset"), entryDirectory, folderRoot, urlByPath));
    }
    if (element.hasAttribute("style")) {
      element.setAttribute("style", rewriteCss(element.getAttribute("style"), entryDirectory, folderRoot, urlByPath));
    }
  }

  for (const style of parsed.querySelectorAll("style")) {
    style.textContent = rewriteCss(style.textContent, entryDirectory, folderRoot, urlByPath);
  }

  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

function rewriteCss(css, baseDirectory, folderRoot, urlByPath) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, value) => {
    const resolved = resolveLocalUrl(value, baseDirectory, folderRoot, urlByPath);
    return `url(${quote}${resolved}${quote})`;
  }).replace(/@import\s+(['"])(.*?)\1/gi, (match, quote, value) => {
    return `@import ${quote}${resolveLocalUrl(value, baseDirectory, folderRoot, urlByPath)}${quote}`;
  });
}

function rewriteSrcset(srcset, baseDirectory, folderRoot, urlByPath) {
  return srcset.split(",").map((candidate) => {
    const parts = candidate.trim().split(/\s+/);
    if (parts[0]) parts[0] = resolveLocalUrl(parts[0], baseDirectory, folderRoot, urlByPath);
    return parts.join(" ");
  }).join(", ");
}

function resolveLocalUrl(value, baseDirectory, folderRoot, urlByPath) {
  const trimmed = value.trim();
  if (!trimmed || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(trimmed)) {
    // Root-relative site URLs (for example /assets/site.css) refer to the
    // selected project folder, not the viewer application's origin.
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

  const fileUrl = urlByPath.get(path) || urlByPath.get(normalizePath(`${folderRoot}${path}`));
  if (fileUrl) return fileUrl;

  // Absolute paths are commonly written from the website's root. Try that
  // interpretation as well as the browser-root interpretation above.
  if (trimmed.startsWith("/")) {
    const rootedUrl = urlByPath.get(normalizePath(`${folderRoot}${path}`));
    if (rootedUrl) return rootedUrl;
  }
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

function revokeActiveUrls() {
  for (const url of activeUrls) URL.revokeObjectURL(url);
  activeUrls = [];
}

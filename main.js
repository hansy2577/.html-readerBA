const importButton = document.querySelector("#import-button");
const loadButton = document.querySelector("#load-button");
const folderInput = document.querySelector("#folder-input");
const status = document.querySelector("#status");
const output = document.querySelector("#output");

alert("hello4")

let selectedFiles = [];
let dataUrlByPath = new Map();
let previewFrame = null;

importButton.addEventListener("click", () => folderInput.click());

folderInput.addEventListener("change", () => {
  selectedFiles = Array.from(folderInput.files);
  output.replaceChildren();
  previewFrame = null;

  if (!selectedFiles.length) {
    status.textContent = "No folder selected.";
    loadButton.disabled = true;
    return;
  }

  status.textContent =
    `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} selected. Press Load to preview index.html.`;
  loadButton.disabled = false;
});

loadButton.addEventListener("click", async () => {
  const entry = selectedFiles.find((file) =>
    /(^|\/)index\.html?$/i.test(file.webkitRelativePath)
  );

  if (!entry) {
    status.textContent = "No index.html was found in the selected folder.";
    return;
  }

  importButton.disabled = true;
  loadButton.disabled = true;
  output.replaceChildren();
  status.textContent = "Preparing website preview…";

  try {
    dataUrlByPath = new Map();

    for (const file of selectedFiles) {
      dataUrlByPath.set(
        normalizePath(file.webkitRelativePath),
        await fileToDataUrl(file)
      );
    }

    const previewHtml = await prepareHtml(
      await entry.text(),
      entry.webkitRelativePath,
      {},
      0
    );

    previewFrame = document.createElement("iframe");
    previewFrame.title = `Preview of ${entry.webkitRelativePath}`;
    previewFrame.setAttribute("sandbox", "allow-scripts");
    output.append(previewFrame);
    previewFrame.srcdoc = previewHtml;

    status.textContent =
      `Previewing ${entry.webkitRelativePath}. The page runs in a sandbox.`;
  } catch (error) {
    status.textContent = `Could not prepare preview: ${error.message}`;
  } finally {
    importButton.disabled = false;
    loadButton.disabled = false;
  }
});

// A local page can request navigation through postMessage. Validate that the
// requested destination is an imported HTML file before loading it.
window.addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || message.type !== "local-preview:navigate" || !previewFrame) return;

  const targetPath = normalizePath(message.path);
  const target = selectedFiles.find(
    (file) => normalizePath(file.webkitRelativePath) === targetPath
  );

  if (!target || !/\.html?$/i.test(target.name)) {
    status.textContent = `Local page not found: ${targetPath}`;
    return;
  }

  try {
    status.textContent = `Loading ${targetPath}…`;
    const html = await prepareHtml(
      await target.text(),
      targetPath,
      message.session || {},
      0
    );
    previewFrame.srcdoc = html;
    status.textContent = `Previewing ${targetPath}.`;
  } catch (error) {
    status.textContent = `Could not load ${targetPath}: ${error.message}`;
  }
});

async function prepareHtml(html, pagePath, session = {}, depth = 0) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const pageDirectory = directoryOf(pagePath);
  const folderRoot = rootOf(pagePath);

  // Convert imported CSS to data URLs after resolving its local assets.
  for (const file of selectedFiles.filter((item) => /\.css$/i.test(item.name))) {
    const path = normalizePath(file.webkitRelativePath);
    const css = rewriteCss(
      await file.text(),
      directoryOf(path),
      folderRoot
    );
    dataUrlByPath.set(
      path,
      `data:text/css;charset=utf-8,${encodeURIComponent(css)}`
    );
  }

  parsed.querySelectorAll("base").forEach((base) => base.remove());

  // Inline imported scripts so redirects can be routed to local HTML files.
  for (const script of Array.from(parsed.querySelectorAll("script[src]"))) {
    const src = script.getAttribute("src");
    const path = resolvePath(src, pageDirectory, folderRoot);
    const file = findFile(path);

    if (!file) {
      // Preserve external scripts; leave missing local scripts alone so they
      // don't accidentally load a same-named viewer URL.
      if (isExternalUrl(src)) continue;
      script.remove();
      continue;
    }

    const replacement = parsed.createElement("script");
    for (const attribute of Array.from(script.attributes)) {
      if (attribute.name !== "src" && attribute.name !== "async" && attribute.name !== "defer") {
        replacement.setAttribute(attribute.name, attribute.value);
      }
    }
    replacement.textContent = rewriteNavigation(await file.text());
    script.replaceWith(replacement);
  }

  // Rewrite inline navigation statements such as:
  // window.location = "game.html"
  for (const script of parsed.querySelectorAll("script:not([src])")) {
    if (script.textContent) {
      script.textContent = rewriteNavigation(script.textContent);
    }
  }

  // Rewrite static local assets and links.
  for (const element of parsed.querySelectorAll(
    "[src], [href], [poster], [srcset], [style]"
  )) {
    if (element.matches("iframe[src]") && depth < 5) {
      const src = element.getAttribute("src");
      if (!isExternalUrl(src)) {
        const childPath = resolvePath(src, pageDirectory, folderRoot);
        const childFile = findFile(childPath);
        if (childFile && /\.html?$/i.test(childFile.name)) {
          const childHtml = await prepareHtml(
            await childFile.text(),
            normalizePath(childFile.webkitRelativePath),
            session,
            depth + 1
          );
          element.removeAttribute("src");
          element.setAttribute("srcdoc", childHtml);
          continue;
        }
      }
    }

    for (const attribute of ["src", "href", "poster"]) {
      if (!element.hasAttribute(attribute)) continue;

      const value = element.getAttribute(attribute);
      if (element.matches("a[href]") && !isExternalUrl(value)) {
        element.dataset.localTarget = resolvePath(value, pageDirectory, folderRoot);
        element.setAttribute("href", "#");
      } else {
        element.setAttribute(
          attribute,
          resolveAssetUrl(value, pageDirectory, folderRoot)
        );
      }
    }

    if (element.hasAttribute("srcset")) {
      element.setAttribute(
        "srcset",
        rewriteSrcset(element.getAttribute("srcset"), pageDirectory, folderRoot)
      );
    }

    if (element.hasAttribute("style")) {
      element.setAttribute(
        "style",
        rewriteCss(element.getAttribute("style"), pageDirectory, folderRoot)
      );
    }
  }

  for (const style of parsed.querySelectorAll("style")) {
    style.textContent = rewriteCss(
      style.textContent,
      pageDirectory,
      folderRoot
    );
  }

  const runtime = parsed.createElement("script");
  runtime.textContent =
    `(${installPreviewRuntime.toString()})` +
    `(${safeJson(Object.fromEntries(dataUrlByPath))},` +
    `${JSON.stringify(normalizePath(pagePath))},` +
    `${safeJson(session)});`;

  parsed.head.prepend(runtime);
  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

function installPreviewRuntime(files, pagePath, initialSession) {
  const nativeXHR = window.XMLHttpRequest;
  const sessionValues = { ...initialSession };

  // srcdoc documents have no useful directory URL. Use the imported page path
  // as the base for requests made by the preview.
  function normalize(path) {
    const parts = [];
    for (const part of String(path).replaceAll("\\", "/").split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return parts.join("/");
  }

  function root() {
    const slash = pagePath.indexOf("/");
    return slash < 0 ? "" : pagePath.slice(0, slash + 1);
  }

  function localPath(value) {
    if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return null;

    try {
      const base = `https://preview.invalid/${pagePath}`;
      const url = new URL(value, base);
      if (url.origin !== "https://preview.invalid") return null;

      const path = normalize(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
      return {
        path: files[path] ? path : normalize(`${root()}${path}`),
        query: url.search,
        hash: url.hash
      };
    } catch {
      return null;
    }
  }

  function lookup(value) {
    const result = localPath(value);
    if (!result || !files[result.path]) return null;
    return { ...result, dataUrl: files[result.path] };
  }

  function dataUrlText(dataUrl) {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return "";
    const meta = dataUrl.slice(0, comma);
    const payload = dataUrl.slice(comma + 1);

    if (/;base64/i.test(meta)) {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }

    return decodeURIComponent(payload);
  }

  // Virtual sessionStorage survives preview navigation through the host.
  window.sessionStorage = {
    get length() {
      return Object.keys(sessionValues).length;
    },
    key(index) {
      return Object.keys(sessionValues)[index] ?? null;
    },
    getItem(key) {
      return Object.hasOwn(sessionValues, key) ? sessionValues[key] : null;
    },
    setItem(key, value) {
      sessionValues[String(key)] = String(value);
    },
    removeItem(key) {
      delete sessionValues[String(key)];
    },
    clear() {
      for (const key of Object.keys(sessionValues)) delete sessionValues[key];
    }
  };

  function navigate(path) {
    const target = localPath(path);
    if (!target || !files[target.path] || !/\.html?$/i.test(target.path)) {
      return;
    }

    parent.postMessage({
      type: "local-preview:navigate",
      path: target.path,
      session: sessionValues
    }, "*");
  }

  window.__localNavigate = navigate;

  // Route ordinary local links through the preview host.
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-local-target]");
    if (!link) return;
    event.preventDefault();
    navigate(link.dataset.localTarget);
  }, true);

  // Rewrite dynamically assigned local asset URLs (the simulator creates many
  // images and scripts after its HTML has loaded).
  function rewriteDynamicUrl(value) {
    const found = lookup(String(value));
    return found ? found.dataUrl : value;
  }

  for (const Constructor of [
    window.HTMLImageElement,
    window.HTMLScriptElement,
    window.HTMLAudioElement,
    window.HTMLSourceElement,
    window.HTMLIFrameElement
  ]) {
    if (!Constructor) continue;
    const descriptor = Object.getOwnPropertyDescriptor(Constructor.prototype, "src");
    if (!descriptor || !descriptor.set || !descriptor.get) continue;

    Object.defineProperty(Constructor.prototype, "src", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        if (this instanceof HTMLIFrameElement) {
          const target = localPath(String(value));
          if (target && files[target.path] && /\.html?$/i.test(target.path)) {
            navigate(target.path);
            return;
          }
        }
        descriptor.set.call(this, rewriteDynamicUrl(value));
      }
    });
  }

  function LocalXMLHttpRequest() {
    this.native = new nativeXHR();
    this.listeners = new Map();
    this.localRequest = null;
    this.readyState = 0;
    this.status = 0;
    this.statusText = "";
    this.responseText = "";
    this.response = null;
    this.responseXML = null;
    this.responseType = "";
    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
    this.onloadend = null;
    this.onabort = null;
    this.onloadstart = null;

    for (const type of ["readystatechange", "load", "error", "loadend", "abort", "loadstart"]) {
      this.native.addEventListener(type, (event) => {
        if (typeof this[`on${type}`] === "function") this[`on${type}`].call(this, event);
        for (const listener of this.listeners.get(type) || []) {
          typeof listener === "function" ? listener.call(this, event) : listener.handleEvent(event);
        }
      });
    }
  }

  LocalXMLHttpRequest.UNSENT = 0;
  LocalXMLHttpRequest.OPENED = 1;
  LocalXMLHttpRequest.HEADERS_RECEIVED = 2;
  LocalXMLHttpRequest.LOADING = 3;
  LocalXMLHttpRequest.DONE = 4;

  LocalXMLHttpRequest.prototype.addEventListener = function (type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  };

  LocalXMLHttpRequest.prototype.removeEventListener = function (type, listener) {
    this.listeners.get(type)?.delete(listener);
  };

  LocalXMLHttpRequest.prototype.open = function (method, url, async = true, ...rest) {
    this.method = String(method).toUpperCase();
    this.localRequest = lookup(String(url));

    if (!this.localRequest) {
      this.native.open(method, url, async, ...rest);
      this._nativeMode = true;
    } else {
      this._nativeMode = false;
      this.async = async !== false;
      this.readyState = LocalXMLHttpRequest.OPENED;
      this.onreadystatechange?.call(this, new Event("readystatechange"));
    }
  };

  LocalXMLHttpRequest.prototype.send = function (body = null) {
    if (this._nativeMode) {
      this.native.send(body);
      return;
    }

    if (this.async === false) {
      throw new DOMException("Synchronous local XHR is not supported.", "InvalidAccessError");
    }

    this.onloadstart?.call(this, new Event("loadstart"));

    setTimeout(() => {
      if (this.method !== "GET" && this.method !== "HEAD") {
        this.status = 405;
        this.statusText = "Method Not Allowed";
        this.readyState = LocalXMLHttpRequest.DONE;
        this.onreadystatechange?.call(this, new Event("readystatechange"));
        this.onerror?.call(this, new Event("error"));
        this.onloadend?.call(this, new Event("loadend"));
        return;
      }

      this.status = 200;
      this.statusText = "OK";
      this.readyState = LocalXMLHttpRequest.HEADERS_RECEIVED;
      this.onreadystatechange?.call(this, new Event("readystatechange"));

      this.readyState = LocalXMLHttpRequest.LOADING;
      this.onreadystatechange?.call(this, new Event("readystatechange"));

      this.responseText = this.method === "HEAD"
        ? ""
        : dataUrlText(this.localRequest.dataUrl);

      if (this.responseType === "json") {
        try {
          this.response = JSON.parse(this.responseText);
        } catch {
          this.response = null;
        }
      } else if (this.responseType === "document") {
        this.responseXML = new DOMParser().parseFromString(this.responseText, "application/xml");
        this.response = this.responseXML;
      } else {
        this.response = this.responseText;
        if (/\.xml$/i.test(this.localRequest.path)) {
          this.responseXML = new DOMParser().parseFromString(this.responseText, "application/xml");
        }
      }

      this.readyState = LocalXMLHttpRequest.DONE;
      this.onreadystatechange?.call(this, new Event("readystatechange"));
      this.onload?.call(this, new Event("load"));
      this.onloadend?.call(this, new Event("loadend"));
    }, 0);
  };

  LocalXMLHttpRequest.prototype.abort = function () {
    if (this._nativeMode) return this.native.abort();
    this.status = 0;
    this.readyState = LocalXMLHttpRequest.DONE;
    this.onabort?.call(this, new Event("abort"));
  };

  LocalXMLHttpRequest.prototype.setRequestHeader = function (...args) {
    if (this._nativeMode) this.native.setRequestHeader(...args);
  };

  LocalXMLHttpRequest.prototype.getResponseHeader = function (name) {
    if (this._nativeMode) return this.native.getResponseHeader(name);
    if (String(name).toLowerCase() === "content-type") {
      return this.localRequest.dataUrl.match(/^data:([^;,]*)/)?.[1] || "text/plain";
    }
    return null;
  };

  LocalXMLHttpRequest.prototype.getAllResponseHeaders = function () {
    if (this._nativeMode) return this.native.getAllResponseHeaders();
    return `content-type: ${this.getResponseHeader("content-type")}\r\n`;
  };

  window.XMLHttpRequest = LocalXMLHttpRequest;
}

function rewriteNavigation(source) {
  return source
    .replace(
      /\b(?:window\.)?location(?:\.href)?\s*=\s*(["'`])([^"'`]+)\1/g,
      (_match, _quote, path) => `window.__localNavigate(${JSON.stringify(path)})`
    )
    .replace(
      /\b(?:window\.)?location\.(?:assign|replace)\(\s*(["'`])([^"'`]+)\1\s*\)/g,
      (_match, _quote, path) => `window.__localNavigate(${JSON.stringify(path)})`
    );
}

function rewriteCss(css, baseDirectory, folderRoot) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, value) => {
    const rewritten = resolveAssetUrl(value, baseDirectory, folderRoot);
    return `url(${quote}${rewritten}${quote})`;
  });
}

function rewriteSrcset(value, baseDirectory, folderRoot) {
  return value.split(",").map((candidate) => {
    const parts = candidate.trim().split(/\s+/);
    if (parts[0]) parts[0] = resolveAssetUrl(parts[0], baseDirectory, folderRoot);
    return parts.join(" ");
  }).join(", ");
}

function resolveAssetUrl(value, baseDirectory, folderRoot) {
  const path = resolvePath(value, baseDirectory, folderRoot);
  return dataUrlByPath.get(path) || value;
}

function resolvePath(value, baseDirectory, folderRoot) {
  const trimmed = String(value).trim();
  if (!trimmed || isExternalUrl(trimmed) || trimmed.startsWith("#")) return "";

  try {
    const url = new URL(trimmed, `https://preview.invalid/${baseDirectory}`);
    if (url.origin !== "https://preview.invalid") return "";
    const path = normalizePath(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    if (dataUrlByPath.has(path)) return path;
    const rooted = normalizePath(`${folderRoot}${path}`);
    return dataUrlByPath.has(rooted) ? rooted : path;
  } catch {
    return "";
  }
}

function isExternalUrl(value) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(String(value).trim());
}

function findFile(path) {
  return selectedFiles.find(
    (file) => normalizePath(file.webkitRelativePath) === normalizePath(path)
  );
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

function normalizePath(path) {
  const parts = [];
  for (const part of String(path).replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

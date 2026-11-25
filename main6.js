const importButton = document.querySelector("#import-button");
const loadButton = document.querySelector("#load-button");
const folderInput = document.querySelector("#folder-input");
const status = document.querySelector("#status");
const output = document.querySelector("#output");

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
    `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} selected.`;
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
  status.textContent = "Preparing preview...";
  output.replaceChildren();

  try {
    dataUrlByPath = new Map();

    for (const file of selectedFiles) {
      dataUrlByPath.set(
        normalizePath(file.webkitRelativePath),
        await fileToDataUrl(file)
      );
    }

    const previewEntry = await findInitialPreviewFile(entry);
    const html = await prepareHtml(
      await previewEntry.text(),
      normalizePath(previewEntry.webkitRelativePath),
      {},
      0
    );

    previewFrame = document.createElement("iframe");
    previewFrame.title = `Preview of ${previewEntry.webkitRelativePath}`;
    previewFrame.setAttribute("sandbox", "allow-scripts");
    previewFrame.srcdoc = html;
    output.append(previewFrame);

    document.body.classList.add("preview-mode");
    status.textContent =
      `Previewing ${previewEntry.webkitRelativePath}. Press Escape to return.`;
  } catch (error) {
    status.textContent = `Could not prepare preview: ${error.message}`;
  } finally {
    importButton.disabled = false;
    loadButton.disabled = false;
  }
});

window.addEventListener("message", async (event) => {
  const message = event.data;

  if (
    !message ||
    message.type !== "local-preview:navigate" ||
    !previewFrame
  ) {
    return;
  }

  const target = selectedFiles.find(
    (file) => normalizePath(file.webkitRelativePath) === normalizePath(message.path)
  );

  if (!target || !/\.html?$/i.test(target.name)) {
    status.textContent = `Local page not found: ${message.path}`;
    return;
  }

  try {
    const html = await prepareHtml(
      await target.text(),
      normalizePath(target.webkitRelativePath),
      message.session || {},
      0
    );

    previewFrame.srcdoc = html;
    status.textContent = `Previewing ${target.webkitRelativePath}.`;
  } catch (error) {
    status.textContent = `Could not load ${target.webkitRelativePath}: ${error.message}`;
  }
});

async function findInitialPreviewFile(entry) {
  const parsed = new DOMParser().parseFromString(
    await entry.text(),
    "text/html"
  );

  const wrapperFrame = parsed.querySelector("iframe[src]");
  if (!wrapperFrame) return entry;

  const path = resolvePath(
    wrapperFrame.getAttribute("src"),
    directoryOf(normalizePath(entry.webkitRelativePath)),
    rootOf(normalizePath(entry.webkitRelativePath))
  );

  const file = findFile(path);
  return file && /\.html?$/i.test(file.name) ? file : entry;
}

async function prepareHtml(html, pagePath, session = {}, depth = 0) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const pageDirectory = directoryOf(pagePath);
  const folderRoot = rootOf(pagePath);

  // CSS files
  for (const file of selectedFiles.filter((item) =>
    /\.css$/i.test(item.name)
  )) {
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

  // Scripts
  for (const script of Array.from(parsed.querySelectorAll("script[src]"))) {
    const src = script.getAttribute("src");

    if (isExternalUrl(src)) continue;

    const path = resolvePath(src, pageDirectory, folderRoot);
    const file = findFile(path);

    if (!file) {
      script.remove();
      continue;
    }

    const replacement = parsed.createElement("script");

    for (const attribute of Array.from(script.attributes)) {
      if (
        attribute.name !== "src" &&
        attribute.name !== "async" &&
        attribute.name !== "defer"
      ) {
        replacement.setAttribute(attribute.name, attribute.value);
      }
    }

    replacement.textContent =
      rewritePreviewScript(await file.text());

    script.replaceWith(replacement);
  }

  for (const script of parsed.querySelectorAll("script:not([src])")) {
    if (script.textContent) {
      script.textContent =
        rewritePreviewScript(script.textContent);
    }
  }

  // HTML assets
  for (const element of parsed.querySelectorAll(
    "[src], [href], [poster], [srcset], [style]"
  )) {
    if (element.matches("iframe[src]") && depth < 5) {
      const src = element.getAttribute("src");

      if (!isExternalUrl(src)) {
        const childPath = resolvePath(src, pageDirectory, folderRoot);
        const childFile = findFile(childPath);

        if (childFile && /\.html?$/i.test(childFile.name)) {
          element.removeAttribute("src");
          element.setAttribute(
            "srcdoc",
            await prepareHtml(
              await childFile.text(),
              normalizePath(childFile.webkitRelativePath),
              session,
              depth + 1
            )
          );
          continue;
        }
      }
    }

    for (const attribute of ["src", "href", "poster"]) {
      if (!element.hasAttribute(attribute)) continue;

      const value = element.getAttribute(attribute);

      if (
        element.matches("a[href]") &&
        !isExternalUrl(value)
      ) {
        element.dataset.localTarget =
          resolvePath(value, pageDirectory, folderRoot);
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
        rewriteSrcset(
          element.getAttribute("srcset"),
          pageDirectory,
          folderRoot
        )
      );
    }

    if (element.hasAttribute("style")) {
      element.setAttribute(
        "style",
        rewriteCss(
          element.getAttribute("style"),
          pageDirectory,
          folderRoot
        )
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

  // Inline event handlers
  for (const element of parsed.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith("on")) {
        element.setAttribute(
          attribute.name,
          rewritePreviewScript(attribute.value)
        );
      }
    }
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
    const raw = String(value || "").trim();

    if (
      !raw ||
      /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(raw)
    ) {
      return null;
    }

    try {
      const url = new URL(
        raw,
        `https://preview.invalid/${pagePath}`
      );

      if (url.origin !== "https://preview.invalid") return null;

      const path = normalize(
        decodeURIComponent(url.pathname).replace(/^\/+/, "")
      );

      const pageDirectory = pagePath.includes("/")
        ? pagePath.slice(0, pagePath.lastIndexOf("/") + 1)
        : "";

      const candidates = [path];

      if (raw.startsWith("/")) {
        candidates.push(normalize(`${pageDirectory}${path}`));
      }

      candidates.push(normalize(`${root()}${path}`));

      const resolvedPath = candidates.find((candidate) =>
        Object.hasOwn(files, candidate)
      );

      return {
        path: resolvedPath || candidates[0],
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

    return {
      ...result,
      dataUrl: files[result.path]
    };
  }

  function dataUrlText(dataUrl) {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return "";

    const metadata = dataUrl.slice(0, comma);
    const payload = dataUrl.slice(comma + 1);

    if (/;base64/i.test(metadata)) {
      const binary = atob(payload);
      const bytes = Uint8Array.from(
        binary,
        (character) => character.charCodeAt(0)
      );
      return new TextDecoder().decode(bytes);
    }

    return decodeURIComponent(payload);
  }

  window.__localSessionStorage = {
    get length() {
      return Object.keys(sessionValues).length;
    },

    key(index) {
      return Object.keys(sessionValues)[index] ?? null;
    },

    getItem(key) {
      const stringKey = String(key);
      return Object.hasOwn(sessionValues, stringKey)
        ? sessionValues[stringKey]
        : null;
    },

    setItem(key, value) {
      sessionValues[String(key)] = String(value);
    },

    removeItem(key) {
      delete sessionValues[String(key)];
    },

    clear() {
      for (const key of Object.keys(sessionValues)) {
        delete sessionValues[key];
      }
    }
  };

  function navigate(path) {
    const target = localPath(path);

    if (
      !target ||
      !files[target.path] ||
      !/\.html?$/i.test(target.path)
    ) {
      return;
    }

    parent.postMessage(
      {
        type: "local-preview:navigate",
        path: target.path,
        session: sessionValues
      },
      "*"
    );
  }

  window.__localNavigate = navigate;

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-local-target]");
    if (!link) return;

    event.preventDefault();
    navigate(link.dataset.localTarget);
  }, true);

  function rewriteDynamicUrl(value) {
    const found = lookup(String(value));
    return found ? found.dataUrl : value;
  }

  function rewriteCssUrls(cssText) {
    return cssText.replace(
      /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
      (match, quote, value) => {
        const rewritten =
          rewriteDynamicUrl(value.trim());

        return `url(${quote}${rewritten}${quote})`;
      }
    );
  }

  const sourcePrototypes = [
    window.HTMLImageElement?.prototype,
    window.HTMLScriptElement?.prototype,
    window.HTMLMediaElement?.prototype,
    window.HTMLSourceElement?.prototype,
    window.HTMLIFrameElement?.prototype
  ].filter(Boolean);

  for (const prototype of new Set(sourcePrototypes)) {
    const descriptor =
      Object.getOwnPropertyDescriptor(prototype, "src");

    if (!descriptor?.get || !descriptor?.set) continue;

    Object.defineProperty(prototype, "src", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,

      set(value) {
        if (this instanceof HTMLIFrameElement) {
          const target = localPath(String(value));

          if (
            target &&
            files[target.path] &&
            /\.html?$/i.test(target.path)
          ) {
            navigate(target.path);
            return;
          }
        }

        descriptor.set.call(
          this,
          rewriteDynamicUrl(value)
        );
      }
    });
  }

  const NativeAudio = window.Audio;

  window.Audio = function Audio(src) {
    const audio = new NativeAudio();

    if (src != null && src !== "") {
      audio.src = rewriteDynamicUrl(src);
    }

    return audio;
  };

  window.Audio.prototype = NativeAudio.prototype;

  const styleObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const element = mutation.target;
      const cssText = element.getAttribute("style");

      if (!cssText) continue;

      const rewritten =
        rewriteCssUrls(cssText);

      if (rewritten !== cssText) {
        element.setAttribute("style", rewritten);
      }
    }
  });

  styleObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
    subtree: true
  });

  const assetObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const element = mutation.target;
      const attribute = mutation.attributeName;

      if (attribute !== "src" && attribute !== "poster") {
        continue;
      }

      const value = element.getAttribute(attribute);

      if (!value || value.startsWith("data:")) continue;

      const rewritten =
        rewriteDynamicUrl(value);

      if (rewritten !== value) {
        element.setAttribute(attribute, rewritten);
      }
    }
  });

  assetObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["src", "poster"],
    subtree: true
  });

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

    this.method = "";
    this.async = true;
    this._nativeMode = false;

    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
    this.onloadend = null;
    this.onabort = null;
    this.onloadstart = null;
  }

  LocalXMLHttpRequest.UNSENT = 0;
  LocalXMLHttpRequest.OPENED = 1;
  LocalXMLHttpRequest.HEADERS_RECEIVED = 2;
  LocalXMLHttpRequest.LOADING = 3;
  LocalXMLHttpRequest.DONE = 4;

  LocalXMLHttpRequest.prototype.addEventListener =
    function (type, listener) {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, new Set());
      }

      this.listeners.get(type).add(listener);
    };

  LocalXMLHttpRequest.prototype.removeEventListener =
    function (type, listener) {
      this.listeners.get(type)?.delete(listener);
    };

  LocalXMLHttpRequest.prototype.open =
    function (method, url, async = true, ...rest) {
      this.method = String(method).toUpperCase();
      this.async = async !== false;
      this.localRequest = lookup(String(url));

      if (!this.localRequest) {
        this._nativeMode = true;
        this.native.open(method, url, async, ...rest);
        return;
      }

      this._nativeMode = false;
      this.readyState = LocalXMLHttpRequest.OPENED;
      this.onreadystatechange?.call(
        this,
        new Event("readystatechange")
      );
    };

  LocalXMLHttpRequest.prototype.send =
    function (body = null) {
      if (this._nativeMode) {
        this.native.send(body);
        return;
      }

      if (this.async === false) {
        throw new DOMException(
          "Synchronous local XHR is not supported.",
          "InvalidAccessError"
        );
      }

      const emit = (type) => {
        const event = new Event(type);

        if (typeof this[`on${type}`] === "function") {
          this[`on${type}`].call(this, event);
        }

        for (const listener of this.listeners.get(type) || []) {
          if (typeof listener === "function") {
            listener.call(this, event);
          } else {
            listener.handleEvent(event);
          }
        }
      };

      emit("loadstart");

      setTimeout(() => {
        if (
          this.method !== "GET" &&
          this.method !== "HEAD"
        ) {
          this.status = 405;
          this.statusText = "Method Not Allowed";
          this.readyState = LocalXMLHttpRequest.DONE;
          emit("readystatechange");
          emit("error");
          emit("loadend");
          return;
        }

        this.status = 200;
        this.statusText = "OK";
        this.responseText =
          this.method === "HEAD"
            ? ""
            : dataUrlText(this.localRequest.dataUrl);

        this.readyState = LocalXMLHttpRequest.HEADERS_RECEIVED;
        emit("readystatechange");

        this.readyState = LocalXMLHttpRequest.LOADING;
        emit("readystatechange");

        if (this.responseType === "json") {
          try {
            this.response =
              JSON.parse(this.responseText);
          } catch {
            this.response = null;
          }
        } else if (this.responseType === "document") {
          this.responseXML =
            new DOMParser().parseFromString(
              this.responseText,
              "application/xml"
            );
          this.response = this.responseXML;
        } else {
          this.response = this.responseText;

          if (/\.xml$/i.test(this.localRequest.path)) {
            this.responseXML =
              new DOMParser().parseFromString(
                this.responseText,
                "application/xml"
              );
          }
        }

        this.readyState = LocalXMLHttpRequest.DONE;
        emit("readystatechange");
        emit("load");
        emit("loadend");
      }, 0);
    };

  LocalXMLHttpRequest.prototype.abort =
    function () {
      if (this._nativeMode) {
        this.native.abort();
        return;
      }

      this.status = 0;
      this.readyState = LocalXMLHttpRequest.DONE;
      this.onabort?.call(
        this,
        new Event("abort")
      );
    };

  LocalXMLHttpRequest.prototype.setRequestHeader =
    function (...args) {
      if (this._nativeMode) {
        this.native.setRequestHeader(...args);
      }
    };

  LocalXMLHttpRequest.prototype.getResponseHeader =
    function (name) {
      if (this._nativeMode) {
        return this.native.getResponseHeader(name);
      }

      if (String(name).toLowerCase() === "content-type") {
        return (
          this.localRequest.dataUrl.match(
            /^data:([^;,]*)/
          )?.[1] || "text/plain"
        );
      }

      return null;
    };

  LocalXMLHttpRequest.prototype.getAllResponseHeaders =
    function () {
      if (this._nativeMode) {
        return this.native.getAllResponseHeaders();
      }

      return `content-type: ${this.getResponseHeader("content-type")}\r\n`;
    };

  window.XMLHttpRequest = LocalXMLHttpRequest;
}

function rewritePreviewScript(source) {
  return rewriteNavigation(source).replace(
    /\bsessionStorage\b/g,
    "window.__localSessionStorage"
  );
}

function rewriteNavigation(source) {
  return source
    .replace(
      /\b(?:window\.)?location(?:\.href)?\s*=\s*(["'`])([^"'`]+)\1/g,
      (_match, _quote, path) =>
        `window.__localNavigate(${JSON.stringify(path)})`
    )
    .replace(
      /\b(?:window\.)?location\.(?:assign|replace)\(\s*(["'`])([^"'`]+)\1\s*\)/g,
      (_match, _quote, path) =>
        `window.__localNavigate(${JSON.stringify(path)})`
    );
}

function rewriteCss(css, baseDirectory, folderRoot) {
  return css.replace(
    /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
    (match, quote, value) => {
      const rewritten =
        resolveAssetUrl(
          value,
          baseDirectory,
          folderRoot
        );

      return `url(${quote}${rewritten}${quote})`;
    }
  );
}

function rewriteSrcset(value, baseDirectory, folderRoot) {
  return value
    .split(",")
    .map((candidate) => {
      const parts =
        candidate.trim().split(/\s+/);

      if (parts[0]) {
        parts[0] = resolveAssetUrl(
          parts[0],
          baseDirectory,
          folderRoot
        );
      }

      return parts.join(" ");
    })
    .join(", ");
}

function resolveAssetUrl(
  value,
  baseDirectory,
  folderRoot
) {
  const path = resolvePath(
    value,
    baseDirectory,
    folderRoot
  );

  return dataUrlByPath.get(path) || value;
}

function resolvePath(
  value,
  baseDirectory,
  folderRoot
) {
  const raw = String(value || "").trim();

  if (
    !raw ||
    isExternalUrl(raw) ||
    raw.startsWith("#")
  ) {
    return "";
  }

  try {
    const url = new URL(
      raw,
      `https://preview.invalid/${baseDirectory}`
    );

    if (url.origin !== "https://preview.invalid") {
      return "";
    }

    const path = normalizePath(
      decodeURIComponent(url.pathname).replace(/^\/+/, "")
    );

    const candidates = [path];

    if (raw.startsWith("/")) {
      candidates.push(
        normalizePath(`${baseDirectory}${path}`)
      );
    }

    candidates.push(
      normalizePath(`${folderRoot}${path}`)
    );

    return candidates.find((candidate) =>
      dataUrlByPath.has(candidate)
    ) || candidates[0];
  } catch {
    return "";
  }
}

function isExternalUrl(value) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(
    String(value).trim()
  );
}

function findFile(path) {
  return selectedFiles.find(
    (file) =>
      normalizePath(file.webkitRelativePath) ===
      normalizePath(path)
  );
}

function directoryOf(path) {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");

  return slash < 0
    ? ""
    : `${normalized.slice(0, slash)}/`;
}

function rootOf(path) {
  const normalized = normalizePath(path);
  const slash = normalized.indexOf("/");

  return slash < 0
    ? ""
    : normalized.slice(0, slash + 1);
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
  return JSON.stringify(value).replace(
    /</g,
    "\\u003c"
  );
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    document.body.classList.remove("preview-mode");
  }
});

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () =>
      resolve(reader.result);

    reader.onerror = () =>
      reject(
        reader.error ||
        new Error(`Could not read ${file.name}`)
      );

    reader.readAsDataURL(file);
  });
}

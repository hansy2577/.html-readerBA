const importButton = document.querySelector("#import-button");
const loadButton = document.querySelector("#load-button");
const folderInput = document.querySelector("#folder-input");
const status = document.querySelector("#status");
const output = document.querySelector("#output");

alert("hello3")

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

  status.textContent =
    `${count} file${count === 1 ? "" : "s"} selected. Press Load to preview index.html.`;
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

  loadButton.disabled = true;
  importButton.disabled = true;
  status.textContent = "Preparing website preview…";
  output.replaceChildren();

  try {
    const dataUrlByPath = new Map();

    for (const file of selectedFiles) {
      dataUrlByPath.set(
        normalizePath(file.webkitRelativePath),
        await fileToDataUrl(file)
      );
    }

    const html = await entry.text();
    const previewHtml = await prepareHtml(
      html,
      entry.webkitRelativePath,
      dataUrlByPath
    );

    const frame = document.createElement("iframe");
    frame.title = `Preview of ${entry.webkitRelativePath}`;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = previewHtml;
    output.append(frame);

    status.textContent =
      `Previewing ${entry.webkitRelativePath}. The page runs in a sandbox.`;
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

  // Rewrite stylesheets and their local asset references.
  for (const stylesheet of selectedFiles.filter((file) =>
    /\.css$/i.test(file.name)
  )) {
    const path = normalizePath(stylesheet.webkitRelativePath);
    const css = await stylesheet.text();
    const rewrittenCss = rewriteCss(
      css,
      directoryOf(path),
      folderRoot,
      dataUrlByPath
    );

    dataUrlByPath.set(
      path,
      `data:text/css;charset=utf-8,${encodeURIComponent(rewrittenCss)}`
    );
  }

  // Remove <base>, which could override the local URL resolution.
  parsed.querySelectorAll("base").forEach((base) => base.remove());

  for (const element of parsed.querySelectorAll(
    "[src], [href], [poster], [srcset], [style]"
  )) {
    for (const attribute of ["src", "href", "poster"]) {
      if (element.hasAttribute(attribute)) {
        element.setAttribute(
          attribute,
          resolveLocalUrl(
            element.getAttribute(attribute),
            entryDirectory,
            folderRoot,
            dataUrlByPath
          )
        );
      }
    }

    if (element.hasAttribute("srcset")) {
      element.setAttribute(
        "srcset",
        rewriteSrcset(
          element.getAttribute("srcset"),
          entryDirectory,
          folderRoot,
          dataUrlByPath
        )
      );
    }

    if (element.hasAttribute("style")) {
      element.setAttribute(
        "style",
        rewriteCss(
          element.getAttribute("style"),
          entryDirectory,
          folderRoot,
          dataUrlByPath
        )
      );
    }
  }

  for (const style of parsed.querySelectorAll("style")) {
    style.textContent = rewriteCss(
      style.textContent,
      entryDirectory,
      folderRoot,
      dataUrlByPath
    );
  }

  // Install the request shim before the imported page's scripts run.
  const shim = parsed.createElement("script");
  const fileMap = Object.fromEntries(dataUrlByPath);
  const safeMapJson = JSON.stringify(fileMap).replace(/</g, "\\u003c");

  shim.textContent =
    `(${installLocalXMLHttpRequest.toString()})` +
    `(${safeMapJson}, ${JSON.stringify(normalizePath(entryPath))});`;

  parsed.head.prepend(shim);

  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

function installLocalXMLHttpRequest(dataUrlByPath, entryPath) {
  const NativeXMLHttpRequest = window.XMLHttpRequest;
  const virtualOrigin = "https://local-preview.invalid/";
  const currentPath = entryPath;

  function normalize(path) {
    const parts = [];

    for (const part of path.replaceAll("\\", "/").split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }

    return parts.join("/");
  }

  function folderRoot() {
    const slash = currentPath.indexOf("/");
    return slash < 0 ? "" : currentPath.slice(0, slash + 1);
  }

  function lookupLocalDataUrl(requestUrl) {
    let url;

    try {
      url = new URL(requestUrl, `${virtualOrigin}${currentPath}`);
    } catch {
      return null;
    }

    // Only intercept relative or site-root paths for the virtual preview site.
    if (url.origin !== new URL(virtualOrigin).origin) return null;

    let path;
    try {
      path = normalize(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    } catch {
      return null;
    }

    const root = folderRoot();
    const dataUrl =
      dataUrlByPath[path] ||
      dataUrlByPath[normalize(`${root}${path}`)];

    return dataUrl ? { dataUrl, path, search: url.search, hash: url.hash } : null;
  }

  function decodeDataUrl(dataUrl) {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("Invalid local data URL.");

    const metadata = dataUrl.slice(0, comma);
    const payload = dataUrl.slice(comma + 1);
    const isBase64 = /;base64/i.test(metadata);
    const mimeType =
      metadata.match(/^data:([^;,]*)/i)?.[1] || "text/plain";

    let bytes;

    if (isBase64) {
      const binary = atob(payload);
      bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }

    return { bytes, mimeType };
  }

  function LocalXMLHttpRequest() {
    this._native = new NativeXMLHttpRequest();
    this._listeners = new Map();
    this._local = false;
    this._async = true;
    this._method = "GET";
    this._url = "";
    this._responseType = "";
    this._response = null;
    this._responseText = "";
    this._responseXML = null;
    this._status = 0;
    this._statusText = "";
    this._readyState = 0;
    this._responseURL = "";

    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
    this.onabort = null;
    this.onloadend = null;
    this.onloadstart = null;
    this.onprogress = null;

    const eventTypes = [
      "readystatechange",
      "load",
      "error",
      "abort",
      "loadend",
      "loadstart",
      "progress"
    ];

    for (const type of eventTypes) {
      this._native.addEventListener(type, (event) => {
        this._dispatch(type, event);
      });
    }
  }

  LocalXMLHttpRequest.UNSENT = 0;
  LocalXMLHttpRequest.OPENED = 1;
  LocalXMLHttpRequest.HEADERS_RECEIVED = 2;
  LocalXMLHttpRequest.LOADING = 3;
  LocalXMLHttpRequest.DONE = 4;

  LocalXMLHttpRequest.prototype.addEventListener = function (type, listener) {
    if (!listener) return;
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(listener);
  };

  LocalXMLHttpRequest.prototype.removeEventListener = function (type, listener) {
    this._listeners.get(type)?.delete(listener);
  };

  LocalXMLHttpRequest.prototype.dispatchEvent = function (event) {
    this._dispatch(event.type, event);
    return true;
  };

  LocalXMLHttpRequest.prototype._dispatch = function (type, event = {}) {
    const normalizedEvent = event.type
      ? event
      : new Event(type);

    const handler = this[`on${type}`];
    if (typeof handler === "function") handler.call(this, normalizedEvent);

    for (const listener of this._listeners.get(type) || []) {
      if (typeof listener === "function") {
        listener.call(this, normalizedEvent);
      } else {
        listener.handleEvent(normalizedEvent);
      }
    }
  };

  LocalXMLHttpRequest.prototype.open = function (
    method,
    url,
    async = true,
    username,
    password
  ) {
    this._method = String(method).toUpperCase();
    this._url = String(url);
    this._async = async !== false;

    const local = lookupLocalDataUrl(this._url);
    this._local = Boolean(local);
    this._localRequest = local;

    if (!this._local) {
      this._native.open(method, url, async, username, password);
    }

    this._readyState = LocalXMLHttpRequest.OPENED;
    this._dispatch("readystatechange");
  };

  LocalXMLHttpRequest.prototype.send = function (body = null) {
    if (!this._local) {
      this._native.send(body);
      return;
    }

    if (this._async === false) {
      throw new DOMException(
        "Synchronous local preview requests are not supported.",
        "InvalidAccessError"
      );
    }

    if (this._method !== "GET" && this._method !== "HEAD") {
      this._status = 405;
      this._statusText = "Method Not Allowed";
      this._readyState = LocalXMLHttpRequest.DONE;
      this._dispatch("readystatechange");
      this._dispatch("error");
      this._dispatch("loadend");
      return;
    }

    this._dispatch("loadstart");

    try {
      const { bytes, mimeType } = decodeDataUrl(
        this._localRequest.dataUrl
      );

      this._status = 200;
      this._statusText = "OK";
      this._responseURL =
        `${virtualOrigin}${this._localRequest.path}` +
        this._localRequest.search +
        this._localRequest.hash;

      this._readyState = LocalXMLHttpRequest.HEADERS_RECEIVED;
      this._dispatch("readystatechange");

      this._readyState = LocalXMLHttpRequest.LOADING;
      this._dispatch("readystatechange");

      if (this._method === "HEAD") {
        this._responseText = "";
      } else if (
        this._responseType === "arraybuffer" ||
        this._responseType === "blob"
      ) {
        const buffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        );
        this._response =
          this._responseType === "blob"
            ? new Blob([buffer], { type: mimeType })
            : buffer;
      } else {
        this._responseText = new TextDecoder().decode(bytes);

        if (this._responseType === "json") {
          try {
            this._response = JSON.parse(this._responseText);
          } catch {
            this._response = null;
          }
        } else if (this._responseType === "document") {
          this._responseXML = new DOMParser().parseFromString(
            this._responseText,
            /xml/i.test(mimeType) ? "application/xml" : "text/html"
          );
          this._response = this._responseXML;
        } else {
          this._response = this._responseText;

          if (/xml/i.test(mimeType)) {
            this._responseXML = new DOMParser().parseFromString(
              this._responseText,
              "application/xml"
            );
          }
        }
      }

      this._readyState = LocalXMLHttpRequest.DONE;
      this._dispatch("readystatechange");
      this._dispatch("load");
      this._dispatch("loadend");
    } catch (error) {
      this._status = 0;
      this._statusText = "";
      this._readyState = LocalXMLHttpRequest.DONE;
      this._dispatch("readystatechange");
      this._dispatch("error", new ErrorEvent("error", { error }));
      this._dispatch("loadend");
    }
  };

  LocalXMLHttpRequest.prototype.abort = function () {
    if (!this._local) {
      this._native.abort();
      return;
    }

    this._status = 0;
    this._readyState = LocalXMLHttpRequest.DONE;
    this._dispatch("readystatechange");
    this._dispatch("abort");
    this._dispatch("loadend");
  };

  LocalXMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (!this._local) this._native.setRequestHeader(name, value);
  };

  LocalXMLHttpRequest.prototype.getResponseHeader = function (name) {
    if (!this._local) return this._native.getResponseHeader(name);
    if (String(name).toLowerCase() === "content-type") {
      return decodeDataUrl(this._localRequest.dataUrl).mimeType;
    }
    return null;
  };

  LocalXMLHttpRequest.prototype.getAllResponseHeaders = function () {
    if (!this._local) return this._native.getAllResponseHeaders();
    return `content-type: ${decodeDataUrl(this._localRequest.dataUrl).mimeType}\r\n`;
  };

  Object.defineProperties(LocalXMLHttpRequest.prototype, {
    readyState: {
      get() {
        return this._local ? this._readyState : this._native.readyState;
      }
    },
    status: {
      get() {
        return this._local ? this._status : this._native.status;
      }
    },
    statusText: {
      get() {
        return this._local ? this._statusText : this._native.statusText;
      }
    },
    responseURL: {
      get() {
        return this._local ? this._responseURL : this._native.responseURL;
      }
    },
    responseText: {
      get() {
        if (!this._local) return this._native.responseText;
        if (this._responseType && this._responseType !== "text") {
          throw new DOMException(
            "responseText is unavailable for this responseType.",
            "InvalidStateError"
          );
        }
        return this._responseText;
      }
    },
    responseXML: {
      get() {
        return this._local ? this._responseXML : this._native.responseXML;
      }
    },
    response: {
      get() {
        return this._local ? this._response : this._native.response;
      }
    },
    responseType: {
      get() {
        return this._local ? this._responseType : this._native.responseType;
      },
      set(value) {
        this._responseType = value;
        if (!this._local) this._native.responseType = value;
      }
    },
    timeout: {
      get() {
        return this._native.timeout;
      },
      set(value) {
        this._native.timeout = value;
      }
    },
    withCredentials: {
      get() {
        return this._native.withCredentials;
      },
      set(value) {
        this._native.withCredentials = value;
      }
    },
    upload: {
      get() {
        return this._native.upload;
      }
    }
  });

  window.XMLHttpRequest = LocalXMLHttpRequest;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function rewriteCss(css, baseDirectory, folderRoot, dataUrlByPath) {
  return css
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, value) => {
      const resolved = resolveLocalUrl(
        value,
        baseDirectory,
        folderRoot,
        dataUrlByPath
      );
      return `url(${quote}${resolved}${quote})`;
    })
    .replace(/@import\s+(['"])(.*?)\1/gi, (match, quote, value) => {
      return `@import ${quote}${resolveLocalUrl(
        value,
        baseDirectory,
        folderRoot,
        dataUrlByPath
      )}${quote}`;
    });
}

function rewriteSrcset(srcset, baseDirectory, folderRoot, dataUrlByPath) {
  return srcset
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      if (parts[0]) {
        parts[0] = resolveLocalUrl(
          parts[0],
          baseDirectory,
          folderRoot,
          dataUrlByPath
        );
      }
      return parts.join(" ");
    })
    .join(", ");
}

function resolveLocalUrl(value, baseDirectory, folderRoot, dataUrlByPath) {
  const trimmed = value.trim();

  if (
    !trimmed ||
    /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(trimmed)
  ) {
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
    path = normalizePath(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
  } catch {
    return value;
  }

  const dataUrl =
    dataUrlByPath.get(path) ||
    dataUrlByPath.get(normalizePath(`${folderRoot}${path}`));

  return dataUrl ? `${dataUrl}${url.hash}` : value;
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

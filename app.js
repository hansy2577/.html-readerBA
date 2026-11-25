const importButton = document.querySelector("#import-button");
const loadButton = document.querySelector("#load-button");
const folderInput = document.querySelector("#folder-input");
const status = document.querySelector("#status");
const output = document.querySelector("#output");

const textExtensions = new Set([
  "txt", "xml", "xsl", "xslt", "json", "html", "htm", "css", "js", "mjs",
  "ts", "csv", "md", "yaml", "yml", "svg", "log", "ini", "sh", "py", "java",
  "c", "h", "cpp", "php", "sql"
]);

importButton.addEventListener("click", () => folderInput.click());

folderInput.addEventListener("change", () => {
  const count = folderInput.files.length;
  output.replaceChildren();
  if (!count) {
    status.textContent = "No folder selected.";
    loadButton.disabled = true;
    return;
  }
  status.textContent = `${count} file${count === 1 ? "" : "s"} selected. Press Load to view.`;
  loadButton.disabled = false;
});

loadButton.addEventListener("click", async () => {
  const files = Array.from(folderInput.files).sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath));
  if (!files.length) return;

  loadButton.disabled = true;
  importButton.disabled = true;
  output.replaceChildren();

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    status.textContent = `Loading ${index + 1} of ${files.length}: ${file.webkitRelativePath}`;
    const article = document.createElement("article");
    const heading = document.createElement("h2");
    const content = document.createElement("pre");
    heading.textContent = file.webkitRelativePath || file.name;
    article.append(heading, content);
    output.append(article);

    const extension = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "";
    if (!textExtensions.has(extension)) {
      content.textContent = `Preview unavailable for this file type (${formatSize(file.size)}).`;
      continue;
    }

    try {
      content.textContent = await readWithXMLHttpRequest(file);
    } catch (error) {
      content.textContent = `Could not read this file: ${error.message}`;
    }
  }

  status.textContent = `Loaded ${files.length} file${files.length === 1 ? "" : "s"}.`;
  loadButton.disabled = false;
  importButton.disabled = false;
});

function readWithXMLHttpRequest(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const request = new XMLHttpRequest();
    request.open("GET", url);
    request.onload = () => {
      URL.revokeObjectURL(url);
      if (request.status === 200 || request.status === 0) {
        resolve(request.responseText);
      } else {
        reject(new Error(`request returned status ${request.status}`));
      }
    };
    request.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("local file request failed"));
    };
    request.send();
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

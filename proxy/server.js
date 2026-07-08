const http = require("node:http");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, ".env");
const PORT = Number(process.env.PORT || readEnvFile().PORT || 8787);

function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const content = fs.readFileSync(ENV_PATH, "utf8");
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const env = { ...readEnvFile(), ...process.env };
const OPENAI_API_KEY = env.OPENAI_API_KEY;
const OPENAI_MODEL = env.OPENAI_MODEL || "gpt-5.5";
const OPENAI_BASE_URL = (env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
const OPENAI_HTTP_PROXY = env.OPENAI_HTTP_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY || "";
const OPENAI_API_MODE = (env.OPENAI_API_MODE || "responses").toLowerCase();

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_500_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function extractOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n");
}

function parseTranslations(raw, expectedLength) {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    text = text.slice(firstBracket, lastBracket + 1);
  }

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("Model response was not a JSON array.");
  }

  const translations = parsed.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item.translation === "string") return item.translation;
    return "";
  });

  if (translations.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} translations, got ${translations.length}.`);
  }
  return translations;
}

async function translateTexts({ texts, targetLanguage, sourceLanguage, pageTitle, pageUrl }) {
  if (!OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is missing. Put it in proxy/.env.");
    error.statusCode = 500;
    throw error;
  }

  const cleanTexts = texts.map((text) => String(text || "").trim());
  const prompt = [
    `Translate the following webpage text snippets into ${targetLanguage || "Simplified Chinese"}.`,
    sourceLanguage && sourceLanguage !== "auto"
      ? `The source language is ${sourceLanguage}.`
      : "Detect the source language automatically.",
    "Return ONLY a JSON array of strings, with exactly one translated string for each input string, in the same order.",
    "Preserve numbers, product names, code identifiers, URLs, email addresses, and inline punctuation where natural.",
    "Do not add explanations, markdown, indexes, or extra fields.",
    pageTitle ? `Page title: ${pageTitle}` : "",
    pageUrl ? `Page URL: ${pageUrl}` : "",
    "",
    JSON.stringify(cleanTexts),
  ]
    .filter(Boolean)
    .join("\n");

  if (OPENAI_API_MODE === "chat") {
    const data = await postOpenAIJson("/v1/chat/completions", {
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a precise webpage translation engine. You preserve meaning, page UI brevity, and terminology.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    });
    const outputText = data.choices?.[0]?.message?.content || "";
    return parseTranslations(outputText, cleanTexts.length);
  }

  const data = await postOpenAIJson("/v1/responses", {
    model: OPENAI_MODEL,
    reasoning: { effort: env.OPENAI_REASONING_EFFORT || "low" },
    text: { verbosity: env.OPENAI_TEXT_VERBOSITY || "low" },
    input: [
      {
        role: "system",
        content:
          "You are a precise webpage translation engine. You preserve meaning, page UI brevity, and terminology.",
      },
      { role: "user", content: prompt },
    ],
  });

  const outputText = extractOutputText(data);
  return parseTranslations(outputText, cleanTexts.length);
}

async function postOpenAIJson(apiPath, body) {
  const basePath = new URL(`${OPENAI_BASE_URL}/`).pathname.replace(/\/+$/, "");
  const normalizedPath =
    basePath.endsWith("/v1") && apiPath.startsWith("/v1/")
      ? apiPath.slice(3)
      : apiPath;
  const url = new URL(normalizedPath.replace(/^\/+/, ""), `${OPENAI_BASE_URL}/`);
  return postJsonDirect(url, body);
}

async function postJsonDirect(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const hint =
      "Network request to OpenAI failed. If you use a local proxy/VPN, set OPENAI_HTTP_PROXY in proxy/.env, for example http://127.0.0.1:7890.";
    throw new Error(`${hint} Original error: ${error.cause?.message || error.message}`);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `OpenAI request failed with HTTP ${response.status}.`;
    const error = new Error(message);
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

function postJsonViaHttpProxy(url, body, proxyUrlText) {
  return new Promise((resolve, reject) => {
    let proxyUrl;
    try {
      proxyUrl = new URL(proxyUrlText);
    } catch {
      reject(new Error(`Invalid OPENAI_HTTP_PROXY: ${proxyUrlText}`));
      return;
    }

    if (proxyUrl.protocol !== "http:") {
      reject(new Error("OPENAI_HTTP_PROXY currently supports http:// proxies, such as http://127.0.0.1:7890."));
      return;
    }

    const requestBody = JSON.stringify(body);
    const proxyPort = Number(proxyUrl.port || 80);
    const targetPort = Number(url.port || 443);
    const socket = net.connect(proxyPort, proxyUrl.hostname);
    socket.setTimeout(45_000);

    socket.once("connect", () => {
      const auth =
        proxyUrl.username || proxyUrl.password
          ? `Proxy-Authorization: Basic ${Buffer.from(
              `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
            ).toString("base64")}\r\n`
          : "";
      socket.write(
        `CONNECT ${url.hostname}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${url.hostname}:${targetPort}\r\n` +
          auth +
          "Connection: keep-alive\r\n\r\n",
      );
    });

    socket.once("timeout", () => {
      socket.destroy(new Error("Proxy connection timed out."));
    });

    let connectBuffer = Buffer.alloc(0);
    socket.on("data", onConnectData);
    socket.once("error", reject);

    function onConnectData(chunk) {
      connectBuffer = Buffer.concat([connectBuffer, chunk]);
      const headerEnd = connectBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;

      const header = connectBuffer.slice(0, headerEnd).toString("utf8");
      if (!/^HTTP\/1\.[01] 200\b/.test(header)) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${header.split("\r\n")[0] || "unknown response"}`));
        return;
      }

      socket.off("data", onConnectData);
      socket.removeListener("error", reject);

      const secureSocket = tls.connect({
        socket,
        servername: url.hostname,
      });
      secureSocket.setTimeout(90_000);
      secureSocket.once("secureConnect", () => {
        secureSocket.write(
          `POST ${url.pathname}${url.search} HTTP/1.1\r\n` +
            `Host: ${url.hostname}\r\n` +
            `Authorization: Bearer ${OPENAI_API_KEY}\r\n` +
            "Content-Type: application/json\r\n" +
            `Content-Length: ${Buffer.byteLength(requestBody)}\r\n` +
            "Connection: close\r\n\r\n" +
            requestBody,
        );
      });

      const chunks = [];
      secureSocket.on("data", (data) => chunks.push(data));
      secureSocket.once("timeout", () => secureSocket.destroy(new Error("OpenAI request through proxy timed out.")));
      secureSocket.once("error", reject);
      secureSocket.once("end", () => {
        try {
          const response = parseHttpResponse(Buffer.concat(chunks));
          const data = response.body ? JSON.parse(response.body) : {};
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(data.error?.message || `OpenAI request failed with HTTP ${response.statusCode}.`));
            return;
          }
          resolve(data);
        } catch (error) {
          reject(error);
        }
      });
    }
  });
}

function parseHttpResponse(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    throw new Error("Invalid HTTP response from OpenAI.");
  }
  const header = buffer.slice(0, headerEnd).toString("utf8");
  const bodyBuffer = buffer.slice(headerEnd + 4);
  const lines = header.split("\r\n");
  const statusCode = Number(lines[0].split(" ")[1]);
  const headers = Object.fromEntries(
    lines.slice(1).map((line) => {
      const index = line.indexOf(":");
      return [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
    }),
  );

  if ((headers["transfer-encoding"] || "").toLowerCase().includes("chunked")) {
    return { statusCode, headers, body: decodeChunkedBody(bodyBuffer) };
  }
  return { statusCode, headers, body: bodyBuffer.toString("utf8") };
}

function decodeChunkedBody(buffer) {
  let offset = 0;
  const chunks = [];
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const sizeText = buffer.slice(offset, lineEnd).toString("utf8").split(";")[0];
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) break;
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(buffer.slice(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleTranslate(req, res) {
  const body = await readBody(req);
  const payload = JSON.parse(body || "{}");
  const texts = Array.isArray(payload.texts) ? payload.texts : [];

  if (!texts.length) {
    sendJson(res, 400, { error: "texts must be a non-empty array." });
    return;
  }
  if (texts.length > 80) {
    sendJson(res, 400, { error: "Translate at most 80 snippets per request." });
    return;
  }

  const translations = await translateTexts({
    texts,
    targetLanguage: payload.targetLanguage,
    sourceLanguage: payload.sourceLanguage,
    pageTitle: payload.pageTitle,
    pageUrl: payload.pageUrl,
  });
  sendJson(res, 200, { translations, model: OPENAI_MODEL });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        ok: true,
        model: OPENAI_MODEL,
        baseUrl: OPENAI_BASE_URL,
        apiMode: OPENAI_API_MODE,
        hasApiKey: Boolean(OPENAI_API_KEY),
        hasHttpProxy: Boolean(OPENAI_HTTP_PROXY),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/translate") {
      await handleTranslate(req, res);
      return;
    }
    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || "Unexpected error." });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`OpenAI page translate proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`Model: ${OPENAI_MODEL}`);
});

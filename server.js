const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const express = require("express");
const { nanoid } = require("nanoid");
const archiver = require("archiver");

const { crawlDomain } = require("./src/crawler");
const { screenshotUrls } = require("./src/screenshotter");
const { createPdfFromScreenshots } = require("./src/pdf");

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-this-secret-key";

app.use(express.json({ limit: "5mb" }));

app.use(
  "/downloads",
  express.static(path.join(process.cwd(), "output"))
);

function requireApiKey(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const expectedAuthHeader = `Bearer ${API_KEY}`;

  if (authHeader !== expectedAuthHeader) {
    return res.status(401).json({
      status: "error",
      error: "Unauthorized. Missing or invalid API key."
    });
  }

  next();
}

function ensureFullUrl(value) {
  if (!value) {
    return value;
  }

  const trimmedValue = String(value).trim();

  if (
    trimmedValue.startsWith("http://") ||
    trimmedValue.startsWith("https://")
  ) {
    return trimmedValue;
  }

  return `https://${trimmedValue}`;
}

function normalizeOutputFormat(value) {
  const format = String(value || "pdf").toLowerCase().trim();

  if (format === "png" || format === "pngs" || format === "zip") {
    return "png";
  }

  return "pdf";
}

function normalizeMode(value, urls) {
  if (Array.isArray(urls) && urls.length > 0) {
    return "specific_urls";
  }

  const mode = String(value || "entire_site").toLowerCase().trim();

  if (
    mode === "specific" ||
    mode === "specific_urls" ||
    mode === "urls" ||
    mode === "specific_pages"
  ) {
    return "specific_urls";
  }

  return "entire_site";
}

function buildAbsoluteUrl(req, relativePath) {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.get("host");

  return `${protocol}://${host}${relativePath}`;
}

function sanitizeNumber(value, fallback, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(Math.max(number, min), max);
}

function sanitizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase().trim();

    if (normalized === "true" || normalized === "yes" || normalized === "1") {
      return true;
    }

    if (normalized === "false" || normalized === "no" || normalized === "0") {
      return false;
    }
  }

  return fallback;
}

function validateUrlList(urls) {
  if (!Array.isArray(urls)) {
    return [];
  }

  return urls
    .map(url => ensureFullUrl(url))
    .filter(Boolean)
    .filter(url => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    });
}

async function ensureOutputFolders() {
  await fs.mkdir(path.join(process.cwd(), "output"), { recursive: true });
  await fs.mkdir(path.join(process.cwd(), "output", "screenshots"), {
    recursive: true
  });
  await fs.mkdir(path.join(process.cwd(), "output", "pdfs"), {
    recursive: true
  });
  await fs.mkdir(path.join(process.cwd(), "output", "zips"), {
    recursive: true
  });
}

async function createZipFromScreenshots({ screenshotResults, jobId }) {
  const captured = screenshotResults.filter(
    result => result.status === "captured"
  );

  const zipDir = path.join(process.cwd(), "output", "zips");
  await fs.mkdir(zipDir, { recursive: true });

  const zipPath = path.join(zipDir, `${jobId}.zip`);

  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);

    const archive = archiver("zip", {
      zlib: { level: 9 }
    });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);

    for (const result of captured) {
      archive.file(result.filePath, {
        name: path.basename(result.filePath)
      });
    }

    archive.finalize();
  });

  return zipPath;
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    name: "Website Screenshot Export API",
    endpoints: {
      health: "/health",
      capture: "/capture",
      downloads: "/downloads"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok"
  });
});

app.post("/capture", requireApiKey, async (req, res) => {
  const jobId = `capture-${nanoid(10)}`;

  try {
    await ensureOutputFolders();

    const {
      mode,
      domain,
      urls,
      outputFormat = "pdf",
      maxPages = 50,
      maxDepth = 2,
      includeSubdomains = false,
      hideOverlays = true,
      viewportWidth = 1440,
      viewportHeight = 1200,
      concurrency = 2
    } = req.body || {};

    const finalMode = normalizeMode(mode, urls);
    const finalOutputFormat = normalizeOutputFormat(outputFormat);

    const safeMaxPages = sanitizeNumber(maxPages, 50, 1, 500);
    const safeMaxDepth = sanitizeNumber(maxDepth, 2, 0, 10);
    const safeViewportWidth = sanitizeNumber(viewportWidth, 1440, 320, 3840);
    const safeViewportHeight = sanitizeNumber(viewportHeight, 1200, 320, 3000);
    const safeConcurrency = sanitizeNumber(concurrency, 2, 1, 5);
    const safeIncludeSubdomains = sanitizeBoolean(includeSubdomains, false);
    const safeHideOverlays = sanitizeBoolean(hideOverlays, true);

    let urlsToCapture = [];
    let captureTarget = "";

    if (finalMode === "specific_urls") {
      urlsToCapture = validateUrlList(urls);

      if (urlsToCapture.length === 0) {
        return res.status(400).json({
          status: "error",
          jobId,
          error: "Specific URL mode requires a non-empty urls array."
        });
      }

      captureTarget = "specific URLs";
    } else {
      if (!domain) {
        return res.status(400).json({
          status: "error",
          jobId,
          error: "Entire site mode requires a domain."
        });
      }

      const finalDomain = ensureFullUrl(domain);
      captureTarget = finalDomain;

      urlsToCapture = await crawlDomain({
        domain: finalDomain,
        maxPages: safeMaxPages,
        maxDepth: safeMaxDepth,
        includeSubdomains: safeIncludeSubdomains
      });
    }

    if (urlsToCapture.length === 0) {
      return res.status(400).json({
        status: "error",
        jobId,
        error: "No URLs found to capture."
      });
    }

    const screenshotResults = await screenshotUrls({
      urls: urlsToCapture,
      jobId,
      viewportWidth: safeViewportWidth,
      viewportHeight: safeViewportHeight,
      concurrency: safeConcurrency,
      hideFixed: safeHideOverlays
    });

    const captured = screenshotResults.filter(
      result => result.status === "captured"
    );

    const failed = screenshotResults.filter(
      result => result.status === "failed"
    );

    if (captured.length === 0) {
      return res.status(500).json({
        status: "error",
        jobId,
        error: "No screenshots were captured successfully.",
        pagesRequested: urlsToCapture.length,
        pagesCaptured: 0,
        pagesSkipped: failed.length,
        errors: failed.map(result => ({
          url: result.url,
          error: result.error
        }))
      });
    }

    let filePath;
    let relativeDownloadPath;
    let fileType;

    if (finalOutputFormat === "png") {
      filePath = await createZipFromScreenshots({
        screenshotResults,
        jobId
      });

      relativeDownloadPath = `/downloads/zips/${path.basename(filePath)}`;
      fileType = "zip";
    } else {
      filePath = await createPdfFromScreenshots({
        screenshotResults,
        jobId,
        title:
          finalMode === "entire_site"
            ? `Screenshots for ${captureTarget}`
            : "Specific URL Screenshots"
      });

      relativeDownloadPath = `/downloads/pdfs/${path.basename(filePath)}`;
      fileType = "pdf";
    }

    res.json({
      status: "complete",
      jobId,
      mode: finalMode,
      target: captureTarget,
      outputFormat: finalOutputFormat,
      fileType,
      fileUrl: buildAbsoluteUrl(req, relativeDownloadPath),
      pagesRequested: urlsToCapture.length,
      pagesCaptured: captured.length,
      pagesSkipped: failed.length,
      settings: {
        maxPages: safeMaxPages,
        maxDepth: safeMaxDepth,
        includeSubdomains: safeIncludeSubdomains,
        hideOverlays: safeHideOverlays,
        viewportWidth: safeViewportWidth,
        viewportHeight: safeViewportHeight,
        concurrency: safeConcurrency
      },
      capturedUrls: captured.map(result => result.url),
      errors: failed.map(result => ({
        url: result.url,
        error: result.error
      }))
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      jobId,
      error: error.message
    });
  }
});

ensureOutputFolders()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Screenshot API running on http://localhost:${PORT}`);
    });
  })
  .catch(error => {
    console.error("Failed to start API:");
    console.error(error);
    process.exit(1);
  });
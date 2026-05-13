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

const jobs = new Map();

app.use(express.json({ limit: "5mb" }));

app.use(
  "/downloads",
  express.static(path.join(process.cwd(), "output"))
);

function log(jobId, message) {
  console.log(`[${new Date().toISOString()}] [${jobId}] ${message}`);
}

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

function buildAbsoluteUrlFromBase(baseUrl, relativePath) {
  return `${baseUrl}${relativePath}`;
}

function getBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.get("host");

  return `${protocol}://${host}`;
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

function normalizeCaptureRequest(body = {}) {
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
    concurrency = 1
  } = body;

  return {
    mode: normalizeMode(mode, urls),
    domain: domain ? ensureFullUrl(domain) : "",
    urls: validateUrlList(urls),
    outputFormat: normalizeOutputFormat(outputFormat),
    maxPages: sanitizeNumber(maxPages, 50, 1, 500),
    maxDepth: sanitizeNumber(maxDepth, 2, 0, 10),
    includeSubdomains: sanitizeBoolean(includeSubdomains, false),
    hideOverlays: sanitizeBoolean(hideOverlays, true),
    viewportWidth: sanitizeNumber(viewportWidth, 1440, 320, 3840),
    viewportHeight: sanitizeNumber(viewportHeight, 1200, 320, 3000),
    concurrency: sanitizeNumber(concurrency, 1, 1, 5)
  };
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

function createJobRecord({ jobId, baseUrl, request }) {
  const now = new Date().toISOString();

  const job = {
    status: "queued",
    jobId,
    createdAt: now,
    updatedAt: now,
    baseUrl,
    request,
    mode: request.mode,
    target: request.mode === "entire_site" ? request.domain : "specific URLs",
    outputFormat: request.outputFormat,
    fileType: null,
    fileUrl: null,
    pagesRequested: 0,
    pagesCaptured: 0,
    pagesSkipped: 0,
    currentStep: "Queued",
    capturedUrls: [],
    errors: [],
    settings: {
      maxPages: request.maxPages,
      maxDepth: request.maxDepth,
      includeSubdomains: request.includeSubdomains,
      hideOverlays: request.hideOverlays,
      viewportWidth: request.viewportWidth,
      viewportHeight: request.viewportHeight,
      concurrency: request.concurrency
    }
  };

  jobs.set(jobId, job);

  return job;
}

function updateJob(jobId, updates) {
  const existing = jobs.get(jobId);

  if (!existing) {
    return null;
  }

  const updated = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString()
  };

  jobs.set(jobId, updated);

  return updated;
}

function publicJobResponse(job) {
  if (!job) {
    return {
      status: "error",
      error: "Job not found."
    };
  }

  return {
    status: job.status,
    jobId: job.jobId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    mode: job.mode,
    target: job.target,
    outputFormat: job.outputFormat,
    fileType: job.fileType,
    fileUrl: job.fileUrl,
    pagesRequested: job.pagesRequested,
    pagesCaptured: job.pagesCaptured,
    pagesSkipped: job.pagesSkipped,
    currentStep: job.currentStep,
    settings: job.settings,
    capturedUrls: job.capturedUrls,
    errors: job.errors
  };
}

async function runCaptureJob(jobId) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  const request = job.request;

  try {
    log(jobId, "Job started.");

    await ensureOutputFolders();

    updateJob(jobId, {
      status: "running",
      currentStep: "Preparing URLs"
    });

    let urlsToCapture = [];

    if (request.mode === "specific_urls") {
      urlsToCapture = request.urls;

      if (urlsToCapture.length === 0) {
        throw new Error("Specific URL mode requires a non-empty urls array.");
      }

      log(jobId, `Specific URL count: ${urlsToCapture.length}`);
    } else {
      if (!request.domain) {
        throw new Error("Entire site mode requires a domain.");
      }

      log(jobId, `Crawling domain: ${request.domain}`);

      updateJob(jobId, {
        currentStep: `Crawling ${request.domain}`
      });

      urlsToCapture = await crawlDomain({
        domain: request.domain,
        maxPages: request.maxPages,
        maxDepth: request.maxDepth,
        includeSubdomains: request.includeSubdomains
      });

      log(jobId, `Crawler found ${urlsToCapture.length} URL(s).`);
    }

    if (urlsToCapture.length === 0) {
      throw new Error("No URLs found to capture.");
    }

    updateJob(jobId, {
      pagesRequested: urlsToCapture.length,
      currentStep: `Capturing ${urlsToCapture.length} screenshot(s)`
    });

    log(jobId, "Starting screenshots.");

    const screenshotResults = await screenshotUrls({
      urls: urlsToCapture,
      jobId,
      viewportWidth: request.viewportWidth,
      viewportHeight: request.viewportHeight,
      concurrency: request.concurrency,
      hideFixed: request.hideOverlays
    });

    const captured = screenshotResults.filter(
      result => result.status === "captured"
    );

    const failed = screenshotResults.filter(
      result => result.status === "failed"
    );

    log(
      jobId,
      `Screenshots complete. Captured: ${captured.length}. Failed: ${failed.length}.`
    );

    if (captured.length === 0) {
      throw new Error("No screenshots were captured successfully.");
    }

    updateJob(jobId, {
      pagesCaptured: captured.length,
      pagesSkipped: failed.length,
      capturedUrls: captured.map(result => result.url),
      errors: failed.map(result => ({
        url: result.url,
        error: result.error
      })),
      currentStep:
        request.outputFormat === "png"
          ? "Creating PNG ZIP"
          : "Creating PDF"
    });

    let filePath;
    let relativeDownloadPath;
    let fileType;

    if (request.outputFormat === "png") {
      log(jobId, "Creating PNG ZIP.");

      filePath = await createZipFromScreenshots({
        screenshotResults,
        jobId
      });

      relativeDownloadPath = `/downloads/zips/${path.basename(filePath)}`;
      fileType = "zip";
    } else {
      log(jobId, "Creating PDF.");

      filePath = await createPdfFromScreenshots({
        screenshotResults,
        jobId,
        title:
          request.mode === "entire_site"
            ? `Screenshots for ${request.domain}`
            : "Specific URL Screenshots"
      });

      relativeDownloadPath = `/downloads/pdfs/${path.basename(filePath)}`;
      fileType = "pdf";
    }

    const fileUrl = buildAbsoluteUrlFromBase(job.baseUrl, relativeDownloadPath);

    updateJob(jobId, {
      status: "complete",
      fileType,
      fileUrl,
      currentStep: "Complete"
    });

    log(jobId, `Job complete. File created: ${fileUrl}`);
  } catch (error) {
    log(jobId, `Job error: ${error.message}`);

    updateJob(jobId, {
      status: "error",
      currentStep: "Error",
      errors: [
        ...(jobs.get(jobId)?.errors || []),
        {
          url: "",
          error: error.message
        }
      ]
    });
  }
}

async function runCaptureImmediately({ req, jobId, request }) {
  await ensureOutputFolders();

  let urlsToCapture = [];
  let captureTarget = "";

  if (request.mode === "specific_urls") {
    urlsToCapture = request.urls;

    if (urlsToCapture.length === 0) {
      return {
        statusCode: 400,
        body: {
          status: "error",
          jobId,
          error: "Specific URL mode requires a non-empty urls array."
        }
      };
    }

    captureTarget = "specific URLs";
  } else {
    if (!request.domain) {
      return {
        statusCode: 400,
        body: {
          status: "error",
          jobId,
          error: "Entire site mode requires a domain."
        }
      };
    }

    captureTarget = request.domain;

    urlsToCapture = await crawlDomain({
      domain: request.domain,
      maxPages: request.maxPages,
      maxDepth: request.maxDepth,
      includeSubdomains: request.includeSubdomains
    });
  }

  if (urlsToCapture.length === 0) {
    return {
      statusCode: 400,
      body: {
        status: "error",
        jobId,
        error: "No URLs found to capture."
      }
    };
  }

  const screenshotResults = await screenshotUrls({
    urls: urlsToCapture,
    jobId,
    viewportWidth: request.viewportWidth,
    viewportHeight: request.viewportHeight,
    concurrency: request.concurrency,
    hideFixed: request.hideOverlays
  });

  const captured = screenshotResults.filter(
    result => result.status === "captured"
  );

  const failed = screenshotResults.filter(
    result => result.status === "failed"
  );

  if (captured.length === 0) {
    return {
      statusCode: 500,
      body: {
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
      }
    };
  }

  let filePath;
  let relativeDownloadPath;
  let fileType;

  if (request.outputFormat === "png") {
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
        request.mode === "entire_site"
          ? `Screenshots for ${captureTarget}`
          : "Specific URL Screenshots"
    });

    relativeDownloadPath = `/downloads/pdfs/${path.basename(filePath)}`;
    fileType = "pdf";
  }

  return {
    statusCode: 200,
    body: {
      status: "complete",
      jobId,
      mode: request.mode,
      target: captureTarget,
      outputFormat: request.outputFormat,
      fileType,
      fileUrl: buildAbsoluteUrl(req, relativeDownloadPath),
      pagesRequested: urlsToCapture.length,
      pagesCaptured: captured.length,
      pagesSkipped: failed.length,
      settings: {
        maxPages: request.maxPages,
        maxDepth: request.maxDepth,
        includeSubdomains: request.includeSubdomains,
        hideOverlays: request.hideOverlays,
        viewportWidth: request.viewportWidth,
        viewportHeight: request.viewportHeight,
        concurrency: request.concurrency
      },
      capturedUrls: captured.map(result => result.url),
      errors: failed.map(result => ({
        url: result.url,
        error: result.error
      }))
    }
  };
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    name: "Website Screenshot Export API",
    endpoints: {
      health: "/health",
      createJob: "POST /jobs",
      getJob: "GET /jobs/:jobId",
      capture: "POST /capture",
      downloads: "/downloads"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok"
  });
});

app.post("/jobs", requireApiKey, async (req, res) => {
  const jobId = `capture-${nanoid(10)}`;

  try {
    const request = normalizeCaptureRequest(req.body || {});
    const baseUrl = getBaseUrl(req);

    const job = createJobRecord({
      jobId,
      baseUrl,
      request
    });

    log(jobId, "Queued async job.");

    res.status(202).json({
      status: "queued",
      jobId,
      message:
        "Screenshot job has been queued. Ask to check this job status in a few moments.",
      statusUrl: `${baseUrl}/jobs/${jobId}`,
      currentStep: job.currentStep
    });

    /*
      Delay the heavy Playwright work so GPT Actions can receive and process
      the queued response before Render starts using CPU for browser work.
    */
    setTimeout(() => {
      runCaptureJob(jobId).catch(error => {
        log(jobId, `Unexpected async job error: ${error.message}`);

        updateJob(jobId, {
          status: "error",
          currentStep: "Error",
          errors: [
            {
              url: "",
              error: error.message
            }
          ]
        });
      });
    }, 5000);
  } catch (error) {
    res.status(500).json({
      status: "error",
      jobId,
      error: error.message
    });
  }
});

app.get("/jobs/:jobId", requireApiKey, (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      status: "error",
      error: "Job not found."
    });
  }

  res.json(publicJobResponse(job));
});

app.post("/capture", requireApiKey, async (req, res) => {
  const jobId = `capture-${nanoid(10)}`;

  try {
    log(jobId, "Synchronous request received.");

    const request = normalizeCaptureRequest(req.body || {});

    const result = await runCaptureImmediately({
      req,
      jobId,
      request
    });

    res.status(result.statusCode).json(result.body);

    log(jobId, "Synchronous response sent.");
  } catch (error) {
    log(jobId, `Synchronous error: ${error.message}`);

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
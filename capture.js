const { nanoid } = require("nanoid");
const { crawlDomain } = require("./src/crawler");
const { screenshotUrls } = require("./src/screenshotter");
const { createPdfFromScreenshots } = require("./src/pdf");

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);

  if (index === -1) {
    return fallback;
  }

  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printHelp() {
  console.log(`
Domain Screenshot PDF Generator

Entire site mode:
  node capture.js --domain https://example.com --maxPages 25 --maxDepth 2

Specific pages mode:
  node capture.js --urls https://example.com,https://example.com/about

Options:
  --domain              Domain to crawl
  --urls                Comma-separated list of specific URLs to capture
  --maxPages            Max pages to crawl, default 25
  --maxDepth            Max crawl depth, default 2
  --includeSubdomains   Include subdomains
  --viewportWidth       Browser width, default 1440
  --viewportHeight      Browser height, default 1200
  --concurrency         Number of pages captured at once, default 1
  --hideFixed           Hide sticky headers and fixed elements
`);
}

function ensureFullUrl(value) {
  if (!value) return value;

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  return `https://${value}`;
}

async function run() {
  if (hasFlag("help")) {
    printHelp();
    return;
  }

  const domainArg = getArg("domain");
  const urlsArg = getArg("urls");

  const maxPages = Number(getArg("maxPages", 25));
  const maxDepth = Number(getArg("maxDepth", 2));
  const viewportWidth = Number(getArg("viewportWidth", 1440));
  const viewportHeight = Number(getArg("viewportHeight", 1200));
  const concurrency = Number(getArg("concurrency", 1));
  const includeSubdomains = hasFlag("includeSubdomains");
  const hideFixed = hasFlag("hideFixed");

  if (!domainArg && !urlsArg) {
    console.error("Missing input. Use --domain or --urls.");
    printHelp();
    process.exit(1);
  }

  const jobId = `capture-${nanoid(8)}`;

  let urls = [];

  if (urlsArg) {
    urls = urlsArg
      .split(",")
      .map(url => ensureFullUrl(url.trim()))
      .filter(Boolean);

    console.log(`Specific pages mode selected.`);
    console.log(`URLs to capture: ${urls.length}`);
  } else {
    const domain = ensureFullUrl(domainArg);

    console.log(`Entire site mode selected.`);
    console.log(`Domain: ${domain}`);
    console.log(`Max pages: ${maxPages}`);
    console.log(`Max depth: ${maxDepth}`);

    urls = await crawlDomain({
      domain,
      maxPages,
      maxDepth,
      includeSubdomains
    });

    console.log(`Found ${urls.length} URLs.`);
  }

  if (urls.length === 0) {
    console.error("No URLs found to capture.");
    process.exit(1);
  }

  console.log("Starting screenshots...");

  const screenshotResults = await screenshotUrls({
    urls,
    jobId,
    viewportWidth,
    viewportHeight,
    concurrency,
    hideFixed
  });

  const captured = screenshotResults.filter(result => result.status === "captured");
  const failed = screenshotResults.filter(result => result.status === "failed");

  console.log(`Captured: ${captured.length}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log("Failed URLs:");
    for (const item of failed) {
      console.log(`${item.url} - ${item.error}`);
    }
  }

  console.log("Creating PDF...");

  const pdfPath = await createPdfFromScreenshots({
    screenshotResults,
    jobId,
    title: domainArg
      ? `Screenshots for ${ensureFullUrl(domainArg)}`
      : "Specific Page Screenshots"
  });

  console.log("");
  console.log("Done.");
  console.log(`PDF created at: ${pdfPath}`);
}

run().catch(error => {
  console.error("Capture failed:");
  console.error(error);
  process.exit(1);
});
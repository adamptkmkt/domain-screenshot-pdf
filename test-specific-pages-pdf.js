const path = require("path");
const { screenshotUrls } = require("./src/screenshotter");
const { createPdfFromScreenshots } = require("./src/pdf");

async function run() {
  const jobId = "specific-pages-test";

  const urls = [
    "https://paragard.com"
  ];

  const screenshotResults = await screenshotUrls({
    urls,
    jobId,
    viewportWidth: 1440,
    viewportHeight: 1200,
    concurrency: 1,
    hideFixed: false
  });

  const pdfPath = await createPdfFromScreenshots({
    screenshotResults,
    jobId,
    title: "Specific Pages Screenshot Test"
  });

  console.log("Screenshot results:");
  console.log(screenshotResults);

  console.log("");
  console.log("PDF created:");
  console.log(pdfPath);
}

run().catch(error => {
  console.error("Specific pages PDF test failed:");
  console.error(error);
});
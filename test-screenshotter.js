const { screenshotUrls } = require("./src/screenshotter");

async function run() {
  const results = await screenshotUrls({
    urls: [
      "https://paragard.com"
    ],
    jobId: "test-job",
    viewportWidth: 1440,
    viewportHeight: 1200,
    concurrency: 1
  });

  console.log(results);
}

run().catch(error => {
  console.error("Screenshot test failed:");
  console.error(error);
});
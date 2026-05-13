const { crawlDomain } = require("./src/crawler");

async function run() {
  const urls = await crawlDomain({
    domain: "https://paragard.com",
    maxPages: 10,
    maxDepth: 2,
    includeSubdomains: false
  });

  console.log(`Found ${urls.length} URLs:`);
  console.log(urls);
}

run().catch(error => {
  console.error("Crawler test failed:");
  console.error(error);
});
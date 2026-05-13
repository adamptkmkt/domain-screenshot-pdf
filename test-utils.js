const {
  normalizeUrl,
  sameDomain,
  isHttpUrl,
  isBlockedPrivateUrl,
  safeFilenameFromUrl
} = require("./src/utils");

const baseUrl = "https://example.com";

console.log(normalizeUrl("/about/?utm_source=google#team", baseUrl));
console.log(sameDomain("https://example.com/about", baseUrl));
console.log(sameDomain("https://blog.example.com/post", baseUrl, true));
console.log(isHttpUrl("mailto:test@example.com"));
console.log(isBlockedPrivateUrl("http://localhost:3000"));
console.log(safeFilenameFromUrl("https://example.com/about-us", 1));
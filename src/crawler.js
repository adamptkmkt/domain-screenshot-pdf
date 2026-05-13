const axios = require("axios");
const cheerio = require("cheerio");
const {
  normalizeUrl,
  sameDomain,
  isHttpUrl,
  isBlockedPrivateUrl
} = require("./utils");

function shouldSkipUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const pathname = url.pathname.toLowerCase();

    const blockedPathParts = [
      "/cdn-cgi/",
      "/wp-admin",
      "/wp-login",
      "/login",
      "/logout",
      "/cart",
      "/checkout",
      "/my-account",
      "/account",
      "/search",
      "/?s=",
      "/tag/",
      "/author/",
      "/feed",
      "/comments",
      "/trackback"
    ];

    return blockedPathParts.some(part => pathname.includes(part));
  } catch {
    return true;
  }
}

async function getSitemapUrls(startUrl) {
  const root = new URL(startUrl).origin;
  const sitemapUrl = `${root}/sitemap.xml`;

  try {
    const response = await axios.get(sitemapUrl, {
      timeout: 15000,
      headers: {
        "User-Agent": "DomainScreenshotBot/1.0"
      }
    });

    const matches = [...response.data.matchAll(/<loc>(.*?)<\/loc>/g)];

    return matches.map(match => match[1].trim());
  } catch {
    return [];
  }
}

async function getLinksFromPage(url, baseUrl, includeSubdomains) {
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        "User-Agent": "DomainScreenshotBot/1.0"
      }
    });

    const $ = cheerio.load(response.data);
    const links = [];

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      const normalized = normalizeUrl(href, url);

 if (!normalized) return;
if (!isHttpUrl(normalized)) return;
if (isBlockedPrivateUrl(normalized)) return;
if (!sameDomain(normalized, baseUrl, includeSubdomains)) return;
if (shouldSkipUrl(normalized)) return;

links.push(normalized);
    });

    return links;
  } catch {
    return [];
  }
}

async function crawlDomain({
  domain,
  maxPages = 500,
  maxDepth = 5,
  includeSubdomains = false
}) {
  const startUrl = normalizeUrl(domain, domain);

  if (!startUrl) {
    throw new Error("Invalid domain URL");
  }

  if (isBlockedPrivateUrl(startUrl)) {
    throw new Error("Blocked private or local URL");
  }

  const found = new Set();

  // 1. Try sitemap.xml first
  const sitemapUrls = await getSitemapUrls(startUrl);

  for (const rawUrl of sitemapUrls) {
    const normalized = normalizeUrl(rawUrl, startUrl);

if (!normalized) continue;
if (!isHttpUrl(normalized)) continue;
if (isBlockedPrivateUrl(normalized)) continue;
if (!sameDomain(normalized, startUrl, includeSubdomains)) continue;
if (shouldSkipUrl(normalized)) continue;

found.add(normalized);

    if (found.size >= maxPages) {
      return [...found];
    }
  }

  // 2. If sitemap did not produce enough URLs, crawl internal links
  const queue = [{ url: startUrl, depth: 0 }];
  found.add(startUrl);

  while (queue.length > 0 && found.size < maxPages) {
    const current = queue.shift();

    if (current.depth >= maxDepth) {
      continue;
    }

    const links = await getLinksFromPage(
      current.url,
      startUrl,
      includeSubdomains
    );

    for (const link of links) {
      if (found.has(link)) continue;

      found.add(link);

      if (found.size >= maxPages) {
        break;
      }

      queue.push({
        url: link,
        depth: current.depth + 1
      });
    }
  }

  return [...found].slice(0, maxPages);
}

module.exports = {
  crawlDomain
};
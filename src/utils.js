function normalizeUrl(rawUrl, baseUrl) {
  try {
    const url = new URL(rawUrl, baseUrl);

    // Remove page anchors like #section
    url.hash = "";

    // Remove common tracking parameters so duplicate URLs are not crawled
    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "msclkid"
    ];

    for (const param of trackingParams) {
      url.searchParams.delete(param);
    }

    // Remove trailing slash except for homepage
    let finalUrl = url.toString();

    if (finalUrl.endsWith("/") && url.pathname !== "/") {
      finalUrl = finalUrl.slice(0, -1);
    }

    return finalUrl;
  } catch {
    return null;
  }
}

function sameDomain(urlA, urlB, includeSubdomains = false) {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);

    const hostnameA = a.hostname.toLowerCase();
    const hostnameB = b.hostname.toLowerCase();

    if (includeSubdomains) {
      return hostnameA === hostnameB || hostnameA.endsWith("." + hostnameB);
    }

    return hostnameA === hostnameB;
  } catch {
    return false;
  }
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);

    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isBlockedPrivateUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();

    // Block local and private network addresses
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
    ) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

function safeFilenameFromUrl(rawUrl, index) {
  const url = new URL(rawUrl);

  const host = url.hostname.replace(/[^a-z0-9]/gi, "-");
  const path = url.pathname
    .replace(/[^a-z0-9]/gi, "-")
    .replace(/-+/g, "-");

  return `${String(index).padStart(4, "0")}-${host}${path || "-home"}.png`;
}

module.exports = {
  normalizeUrl,
  sameDomain,
  isHttpUrl,
  isBlockedPrivateUrl,
  safeFilenameFromUrl
};
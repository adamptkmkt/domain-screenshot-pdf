const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");
const { safeFilenameFromUrl } = require("./utils");

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function disableAnimations(page) {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }
    `
  }).catch(() => {});
}

async function waitForFonts(page) {
  await page.evaluate(async () => {
    try {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
    } catch {
      // Ignore font wait errors
    }
  }).catch(() => {});
}

async function waitForImages(page) {
  await page.evaluate(async () => {
    const images = Array.from(document.images);

    await Promise.all(
      images.map(img => {
        if (img.complete && img.naturalWidth > 0) {
          return Promise.resolve();
        }

        return new Promise(resolve => {
          const done = () => resolve();

          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });

          setTimeout(done, 5000);
        });
      })
    );

    await Promise.all(
      images.map(img => {
        if (img.decode) {
          return img.decode().catch(() => {});
        }

        return Promise.resolve();
      })
    );
  }).catch(() => {});
}

async function forceLazyImages(page) {
  await page.evaluate(() => {
    const images = Array.from(document.querySelectorAll("img"));

    for (const img of images) {
      const dataSrc =
        img.getAttribute("data-src") ||
        img.getAttribute("data-lazy-src") ||
        img.getAttribute("data-original") ||
        img.getAttribute("data-url") ||
        img.getAttribute("data-img") ||
        img.getAttribute("data-image");

      const dataSrcset =
        img.getAttribute("data-srcset") ||
        img.getAttribute("data-lazy-srcset");

      if (dataSrc && !img.getAttribute("src")) {
        img.setAttribute("src", dataSrc);
      }

      if (dataSrcset && !img.getAttribute("srcset")) {
        img.setAttribute("srcset", dataSrcset);
      }

      img.setAttribute("loading", "eager");
      img.setAttribute("decoding", "sync");
    }

    const pictureSources = Array.from(document.querySelectorAll("source"));

    for (const source of pictureSources) {
      const dataSrcset =
        source.getAttribute("data-srcset") ||
        source.getAttribute("data-lazy-srcset");

      if (dataSrcset && !source.getAttribute("srcset")) {
        source.setAttribute("srcset", dataSrcset);
      }
    }

    const backgroundElements = Array.from(
      document.querySelectorAll("[data-bg], [data-background], [data-bg-src], [data-lazy-bg]")
    );

    for (const el of backgroundElements) {
      const bg =
        el.getAttribute("data-bg") ||
        el.getAttribute("data-background") ||
        el.getAttribute("data-bg-src") ||
        el.getAttribute("data-lazy-bg");

      if (bg) {
        el.style.backgroundImage = `url("${bg}")`;
      }
    }
  }).catch(() => {});
}

async function dismissCookieBanners(page) {
  const buttonLabels = [
    "Accept",
    "Accept All",
    "Accept all",
    "I Accept",
    "I agree",
    "Agree",
    "Got it",
    "Allow all",
    "Allow All",
    "OK",
    "Continue",
    "Close"
  ];

  for (const label of buttonLabels) {
    try {
      await page.getByRole("button", { name: label }).click({ timeout: 750 });
      await wait(500);
      return true;
    } catch {
      // Try next label
    }
  }

  const textLabels = [
    "Accept",
    "Accept All",
    "I Accept",
    "Agree",
    "Got it",
    "OK",
    "Close"
  ];

  for (const label of textLabels) {
    try {
      await page.getByText(label, { exact: true }).click({ timeout: 750 });
      await wait(500);
      return true;
    } catch {
      // Try next label
    }
  }

  return false;
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = 500;

      const timer = setInterval(() => {
        const scrollHeight = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight
        );

        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  }).catch(() => {});
}

async function forceScrollToTop(page) {
  await page.evaluate(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }).catch(() => {});
}

async function normalizeTopNavigation(page) {
  await page.evaluate(() => {
    const viewportWidth = window.innerWidth;

    const topNavKeywords = [
      "header",
      "nav",
      "navbar",
      "navigation",
      "menu",
      "masthead",
      "site-header",
      "main-header",
      "primary-header",
      "topbar",
      "top-bar",
      "global-header",
      "mainnav",
      "main-nav"
    ];

    const elements = Array.from(document.querySelectorAll("body *"));

    for (const el of elements) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      if (rect.width === 0 || rect.height === 0) {
        continue;
      }

      const tagName = el.tagName.toLowerCase();

      const classAndId = [
        el.id || "",
        typeof el.className === "string" ? el.className : "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("role") || "",
        el.getAttribute("data-testid") || "",
        el.getAttribute("data-test") || ""
      ]
        .join(" ")
        .toLowerCase();

      const hasTopNavName = topNavKeywords.some(keyword =>
        classAndId.includes(keyword)
      );

      const isHeaderOrNavTag =
        tagName === "header" ||
        tagName === "nav";

      const isFixedOrSticky =
        style.position === "fixed" ||
        style.position === "sticky";

      const isNearTop =
        rect.top <= 180 &&
        rect.bottom <= 360;

      const isWideEnough =
        rect.width >= viewportWidth * 0.45;

      const isReasonableHeaderHeight =
        rect.height >= 20 &&
        rect.height <= 280;

      const looksLikeTopNav =
        isNearTop &&
        isWideEnough &&
        isReasonableHeaderHeight &&
        (
          hasTopNavName ||
          isHeaderOrNavTag ||
          isFixedOrSticky
        );

      if (!looksLikeTopNav) {
        continue;
      }

      el.setAttribute("data-screenshot-keep", "top-navigation");

      /*
        This is the key fix:
        keep the top nav/header visible, but prevent it from overlaying/cutting
        the hero image by turning it into normal flow content for the screenshot.
      */
      el.style.setProperty("position", "relative", "important");
      el.style.setProperty("top", "auto", "important");
      el.style.setProperty("left", "auto", "important");
      el.style.setProperty("right", "auto", "important");
      el.style.setProperty("bottom", "auto", "important");
      el.style.setProperty("transform", "none", "important");
      el.style.setProperty("z-index", "10", "important");
    }

    /*
      Some sites add body/html padding to account for fixed headers.
      Once we convert the header to normal flow, that padding can create extra gaps.
      Remove only obvious fixed-header compensation values.
    */
    const htmlStyle = window.getComputedStyle(document.documentElement);
    const bodyStyle = window.getComputedStyle(document.body);

    const htmlPaddingTop = Number.parseFloat(htmlStyle.paddingTop) || 0;
    const bodyPaddingTop = Number.parseFloat(bodyStyle.paddingTop) || 0;
    const bodyMarginTop = Number.parseFloat(bodyStyle.marginTop) || 0;

    if (htmlPaddingTop > 40 && htmlPaddingTop < 300) {
      document.documentElement.style.setProperty("padding-top", "0px", "important");
    }

    if (bodyPaddingTop > 40 && bodyPaddingTop < 300) {
      document.body.style.setProperty("padding-top", "0px", "important");
    }

    if (bodyMarginTop > 40 && bodyMarginTop < 300) {
      document.body.style.setProperty("margin-top", "0px", "important");
    }
  }).catch(() => {});
}

async function hideOverlayElements(page) {
  await page.evaluate(() => {
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    const overlayKeywords = [
      "isi",
      "important-safety",
      "important-safety-information",
      "safety-information",
      "prescribing-information",
      "medication-guide",
      "boxed-warning",
      "cookie",
      "consent",
      "privacy",
      "modal",
      "popup",
      "pop-up",
      "overlay",
      "interstitial",
      "chat",
      "drift",
      "intercom",
      "zendesk",
      "livechat",
      "bot",
      "newsletter",
      "subscribe",
      "drawer",
      "floating",
      "sticky-footer",
      "fixed-footer"
    ];

    const safeTopNavKeywords = [
      "header",
      "nav",
      "navbar",
      "navigation",
      "menu",
      "masthead",
      "site-header",
      "main-header",
      "primary-header",
      "topbar",
      "top-bar",
      "global-header",
      "mainnav",
      "main-nav"
    ];

    const elements = Array.from(document.querySelectorAll("body *"));

    for (const el of elements) {
      if (el.getAttribute("data-screenshot-keep") === "top-navigation") {
        continue;
      }

      const style = window.getComputedStyle(el);
      const position = style.position;

      if (position !== "fixed" && position !== "sticky") {
        continue;
      }

      const rect = el.getBoundingClientRect();

      if (rect.width === 0 || rect.height === 0) {
        continue;
      }

      const tagName = el.tagName.toLowerCase();

      const classAndId = [
        el.id || "",
        typeof el.className === "string" ? el.className : "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("role") || "",
        el.getAttribute("data-testid") || "",
        el.getAttribute("data-test") || ""
      ]
        .join(" ")
        .toLowerCase();

      const text = (el.innerText || "").toLowerCase();

      const isNearTop =
        rect.top <= 160 &&
        rect.bottom <= 340;

      const looksLikeTopNavigation =
        isNearTop &&
        rect.width >= viewportWidth * 0.45 &&
        (
          tagName === "header" ||
          tagName === "nav" ||
          safeTopNavKeywords.some(keyword => classAndId.includes(keyword))
        );

      if (looksLikeTopNavigation) {
        continue;
      }

      const hasOverlayKeyword =
        overlayKeywords.some(keyword => classAndId.includes(keyword)) ||
        overlayKeywords.some(keyword => text.includes(keyword));

      const zIndexNumber =
        style.zIndex === "auto" ? 0 : Number.parseInt(style.zIndex, 10) || 0;

      const touchesBottom =
        rect.bottom >= viewportHeight - 12 &&
        rect.height >= 40 &&
        rect.width >= viewportWidth * 0.35;

      const isBottomHalfOverlay =
        rect.top >= viewportHeight * 0.4 &&
        rect.width >= viewportWidth * 0.35 &&
        rect.height >= 40;

      const isModalLike =
        zIndexNumber >= 900 &&
        rect.width >= viewportWidth * 0.25 &&
        rect.height >= viewportHeight * 0.15;

      const isSmallFloatingWidget =
        zIndexNumber >= 50 &&
        rect.width <= viewportWidth * 0.45 &&
        rect.height <= viewportHeight * 0.45 &&
        (
          rect.right >= viewportWidth - 40 ||
          rect.bottom >= viewportHeight - 40
        );

      const shouldHide =
        hasOverlayKeyword ||
        touchesBottom ||
        isModalLike ||
        isSmallFloatingWidget ||
        isBottomHalfOverlay;

      if (shouldHide) {
        el.setAttribute("data-screenshot-hidden", "true");
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("visibility", "hidden", "important");
        el.style.setProperty("opacity", "0", "important");
        el.style.setProperty("pointer-events", "none", "important");
      }
    }
  }).catch(() => {});
}

async function stabilizeLayout(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let lastHeight = 0;
      let stableCount = 0;

      const check = () => {
        const currentHeight = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight
        );

        if (currentHeight === lastHeight) {
          stableCount += 1;
        } else {
          stableCount = 0;
          lastHeight = currentHeight;
        }

        if (stableCount >= 3) {
          resolve();
        } else {
          setTimeout(check, 300);
        }
      };

      check();
    });
  }).catch(() => {});
}

async function preparePageForScreenshot(page, options = {}) {
  const {
    hideFixed = false,
    waitAfterLoadMs = 2500,
    waitAfterScrollMs = 1500
  } = options;

  await page.waitForLoadState("domcontentloaded").catch(() => {});

  await page.waitForLoadState("networkidle", {
    timeout: 15000
  }).catch(() => {});

  await wait(waitAfterLoadMs);

  await disableAnimations(page);
  await dismissCookieBanners(page);

  await forceLazyImages(page);
  await waitForFonts(page);
  await waitForImages(page);

  await autoScroll(page);
  await wait(waitAfterScrollMs);

  await forceLazyImages(page);
  await waitForImages(page);

  await forceScrollToTop(page);
  await wait(1000);

  /*
    Normalize header after returning to the top so the nav is detected
    in its real top-of-page position.
  */
  await normalizeTopNavigation(page);
  await wait(500);

  if (hideFixed) {
    await hideOverlayElements(page);
    await wait(500);
  }

  await forceScrollToTop(page);
  await wait(1000);

  await stabilizeLayout(page);
  await wait(500);
}

async function screenshotUrls({
  urls,
  jobId,
  viewportWidth = 1440,
  viewportHeight = 1200,
  concurrency = 2,
  timeoutMs = 60000,
  hideFixed = false
}) {
  const screenshotDir = path.join(
    process.cwd(),
    "output",
    "screenshots",
    jobId
  );

  await fs.mkdir(screenshotDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true
  });

  const results = [];
  let index = 0;

  async function captureOne(url) {
    const currentIndex = index++;
    const filename = safeFilenameFromUrl(url, currentIndex);
    const filePath = path.join(screenshotDir, filename);

    const page = await browser.newPage({
      viewport: {
        width: viewportWidth,
        height: viewportHeight
      },
      deviceScaleFactor: 1
    });

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs
      });

      await preparePageForScreenshot(page, {
        hideFixed,
        waitAfterLoadMs: 2500,
        waitAfterScrollMs: 1500
      });

      await page.screenshot({
        path: filePath,
        fullPage: true,
        animations: "disabled",
        caret: "hide"
      });

      await page.close();

      return {
        url,
        status: "captured",
        filePath
      };
    } catch (error) {
      await page.close();

      return {
        url,
        status: "failed",
        error: error.message
      };
    }
  }

  const queue = [...urls];

  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const url = queue.shift();
      const result = await captureOne(url);
      results.push(result);
    }
  });

  await Promise.all(workers);
  await browser.close();

  return results;
}

module.exports = {
  screenshotUrls
};
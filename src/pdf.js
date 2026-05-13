const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

async function createPdfFromScreenshots({
  screenshotResults,
  jobId,
  title = "Website Screenshot PDF"
}) {
  const pdfDoc = await PDFDocument.create();

  pdfDoc.setTitle(title);
  pdfDoc.setCreator("Domain Screenshot PDF Generator");

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const captured = screenshotResults.filter(result => result.status === "captured");

  // Cover page
  const coverPage = pdfDoc.addPage([612, 792]);
  coverPage.drawText(title, {
    x: 50,
    y: 720,
    size: 22,
    font,
    color: rgb(0, 0, 0)
  });

  coverPage.drawText(`Pages captured: ${captured.length}`, {
    x: 50,
    y: 685,
    size: 12,
    font,
    color: rgb(0, 0, 0)
  });

  coverPage.drawText(`Generated: ${new Date().toLocaleString()}`, {
    x: 50,
    y: 665,
    size: 12,
    font,
    color: rgb(0, 0, 0)
  });

  for (const result of captured) {
    const imageBytes = await fs.readFile(result.filePath);
    const metadata = await sharp(imageBytes).metadata();

    const image = await pdfDoc.embedPng(imageBytes);

    const originalWidth = metadata.width || image.width;
    const originalHeight = metadata.height || image.height;

    // Use the screenshot's natural size so the PDF preserves the full-page screenshot.
    const page = pdfDoc.addPage([originalWidth, originalHeight + 70]);

    page.drawText(result.url, {
      x: 24,
      y: originalHeight + 42,
      size: 14,
      font,
      color: rgb(0, 0, 0)
    });

    page.drawText(`Captured: ${new Date().toLocaleString()}`, {
      x: 24,
      y: originalHeight + 22,
      size: 10,
      font,
      color: rgb(0.25, 0.25, 0.25)
    });

    page.drawImage(image, {
      x: 0,
      y: 0,
      width: originalWidth,
      height: originalHeight
    });
  }

  const pdfBytes = await pdfDoc.save();

  const pdfDir = path.join(process.cwd(), "output", "pdfs");
  await fs.mkdir(pdfDir, { recursive: true });

  const pdfPath = path.join(pdfDir, `${jobId}.pdf`);
  await fs.writeFile(pdfPath, pdfBytes);

  return pdfPath;
}

module.exports = {
  createPdfFromScreenshots
};
import puppeteer from 'puppeteer';

export interface PdfOptions {
  /** Fully-qualified URL of the print route, e.g. http://web:5173/print/<id> */
  printUrl: string;
}

// A3 landscape @ ~300dpi-equivalent. Puppeteer renders at deviceScaleFactor 2
// against a CSS-sized viewport; preferCSSPageSize honours the @page rule.
const A3_LANDSCAPE_PX = { width: 1587, height: 1123 };

export async function renderFarmPdf({ printUrl }: PdfOptions): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ ...A3_LANDSCAPE_PX, deviceScaleFactor: 2 });
    await page.goto(printUrl, { waitUntil: 'networkidle0', timeout: 60_000 });

    // The print route flips data-map-ready to "1" on the MapLibre idle event.
    await page.waitForSelector('[data-map-ready="1"]', { timeout: 60_000 });

    const pdf = await page.pdf({
      format: 'A3',
      landscape: true,
      printBackground: true,
      preferCSSPageSize: true,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

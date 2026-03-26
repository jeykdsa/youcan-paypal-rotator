const puppeteer = require('puppeteer');

const YOUCAN_EMAIL = process.env.YOUCAN_EMAIL;
const YOUCAN_PASSWORD = process.env.YOUCAN_PASSWORD;
const PAYPAL_EMAIL = process.env.PAYPAL_EMAIL;

if (!YOUCAN_EMAIL || !YOUCAN_PASSWORD || !PAYPAL_EMAIL) {
  console.error('Missing environment variables');
  process.exit(1);
}

(async () => {
  console.log('Starting PayPal email rotation to: ' + PAYPAL_EMAIL);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Step 1: Go to seller-area login (redirects through SSO)
    console.log('Step 1: Navigating to login...');
    await page.goto('https://seller-area.youcan.shop/admin/login', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Step 2: Fill login form on accounts.youcan.shop
    console.log('Step 2: Filling login form...');
    await page.waitForSelector('input[type="password"]', { timeout: 15000 });

    const inputs = await page.$$('input:not([type="hidden"]):not([type="password"])');
    for (const input of inputs) {
      const type = await input.evaluate(el => el.type);
      if (type === 'text' || type === 'email') {
        await input.click({ clickCount: 3 });
        await input.type(YOUCAN_EMAIL);
        break;
      }
    }

    const passwordInput = await page.$('input[type="password"]');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(YOUCAN_PASSWORD);

    // Submit
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click('button[type="submit"], input[type="submit"], button:not([type])'),
    ]);

    // Step 3: Wait for SSO redirect to seller-area
    console.log('Step 3: Waiting for SSO redirect...');
    let attempts = 0;
    while (!page.url().includes('seller-area.youcan.shop/admin') && attempts < 15) {
      await new Promise(r => setTimeout(r, 2000));
      attempts++;
    }

    if (!page.url().includes('seller-area.youcan.shop')) {
      await page.goto('https://seller-area.youcan.shop/admin', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
    }

    // Step 4: Go to payment settings
    console.log('Step 4: Navigating to payment settings...');
    await page.goto('https://seller-area.youcan.shop/admin/settings/payment', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Step 5: Update PayPal email via fetch inside the page
    console.log('Step 5: Updating PayPal email...');
    const result = await page.evaluate(async (newEmail) => {
      const cookies = document.cookie.split(';');
      let xsrf = '';
      for (const c of cookies) {
        const trimmed = c.trim();
        if (trimmed.startsWith('XSRF-TOKEN=')) {
          xsrf = decodeURIComponent(trimmed.split('=').slice(1).join('='));
          break;
        }
      }

      if (!xsrf) return { status: 0, error: 'XSRF token not found' };

      const resp = await fetch('/admin/settings/payment/paypal', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'X-XSRF-TOKEN': xsrf,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': '*/*',
        },
        body: JSON.stringify({ email: newEmail }),
      });
      return { status: resp.status, body: await resp.text() };
    }, PAYPAL_EMAIL);

    console.log('Result: status=' + result.status);

    if (result.status === 200) {
      console.log('SUCCESS: PayPal email changed to ' + PAYPAL_EMAIL);
    } else {
      console.error('FAILED: ' + (result.body || result.error));
      process.exit(1);
    }
  } catch (error) {
    console.error('ERROR: ' + error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();

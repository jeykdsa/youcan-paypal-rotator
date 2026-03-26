const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'changeme';
const YOUCAN_EMAIL = process.env.YOUCAN_EMAIL;
const YOUCAN_PASSWORD = process.env.YOUCAN_PASSWORD;

app.post('/rotate', async (req, res) => {
  const { email, api_key } = req.body;

  if (api_key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Step 1: Go to seller-area login (redirects through SSO to accounts.youcan.shop)
    await page.goto('https://seller-area.youcan.shop/admin/login', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Step 2: Fill in login form on accounts.youcan.shop
    await page.waitForSelector('input[type="password"]', { timeout: 15000 });

    // Find and fill username/email field
    const inputs = await page.$$('input:not([type="hidden"]):not([type="password"])');
    for (const input of inputs) {
      const type = await input.evaluate(el => el.type);
      if (type === 'text' || type === 'email') {
        await input.click({ clickCount: 3 });
        await input.type(YOUCAN_EMAIL);
        break;
      }
    }

    // Fill password
    const passwordInput = await page.$('input[type="password"]');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(YOUCAN_PASSWORD);

    // Submit form
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click('button[type="submit"], input[type="submit"], button:not([type])'),
    ]);

    // Step 3: Wait for redirect back to seller-area (SSO completes via JS)
    // We may end up on accounts.youcan.shop redirect page, then auto-redirect to seller-area
    // Wait until we're on seller-area.youcan.shop
    let attempts = 0;
    while (!page.url().includes('seller-area.youcan.shop/admin') && attempts < 10) {
      await new Promise(r => setTimeout(r, 2000));
      attempts++;
    }

    if (!page.url().includes('seller-area.youcan.shop')) {
      // Manually navigate to seller-area
      await page.goto('https://seller-area.youcan.shop/admin', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
    }

    // Step 4: Navigate to payment settings
    await page.goto('https://seller-area.youcan.shop/admin/settings/payment', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Step 5: Get CSRF token and make PUT request from within the page context
    const result = await page.evaluate(async (newEmail) => {
      // Get XSRF token from cookie
      const cookies = document.cookie.split(';');
      let xsrf = '';
      for (const c of cookies) {
        const trimmed = c.trim();
        if (trimmed.startsWith('XSRF-TOKEN=')) {
          xsrf = decodeURIComponent(trimmed.split('=').slice(1).join('='));
          break;
        }
      }

      if (!xsrf) {
        return { status: 0, error: 'XSRF token not found in cookies' };
      }

      try {
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
        const body = await resp.text();
        return { status: resp.status, body };
      } catch (e) {
        return { status: 0, error: e.message };
      }
    }, email);

    await browser.close();

    const success = result.status === 200;
    res.json({ success, email, statusCode: result.status, response: result.body || result.error });

  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log('PayPal Rotator running on port ' + PORT);
});

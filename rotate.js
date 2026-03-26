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
  console.log('YouCan account: ' + YOUCAN_EMAIL);

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
      timeout: 60000,
    });
    console.log('Step 1 URL: ' + page.url());

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
    console.log('After login URL: ' + page.url());

    // Step 3: Wait for SSO redirect to seller-area
    console.log('Step 3: Waiting for SSO redirect...');
    let attempts = 0;
    while (!page.url().includes('seller-area.youcan.shop/admin') && attempts < 15) {
      await new Promise(r => setTimeout(r, 2000));
      console.log('  Waiting... URL: ' + page.url());
      attempts++;
    }

    if (!page.url().includes('seller-area.youcan.shop')) {
      console.log('Manually navigating to seller-area...');
      await page.goto('https://seller-area.youcan.shop/admin', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
    }
    console.log('Step 3 final URL: ' + page.url());

    // Step 3b: If on switch-store page, select the correct store
    if (page.url().includes('switch-store')) {
      console.log('Step 3b: Selecting store "seoboost"...');

      // Click the store element
      const clicked = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('a, button, div, span, li, td, tr'));
        const el = elements.find(e => e.textContent.trim().toLowerCase().includes('seoboost') && e.closest('a, button, [role="button"], [onclick]'));
        if (el) {
          const clickable = el.closest('a, button, [role="button"], [onclick]') || el;
          clickable.click();
          return clickable.tagName + ': ' + clickable.textContent.trim().substring(0, 50);
        }
        // Try just clicking any element with seoboost
        const fallback = elements.find(e => e.textContent.trim() === 'seoboost');
        if (fallback) {
          fallback.click();
          return 'fallback: ' + fallback.tagName;
        }
        return null;
      });

      console.log('Clicked: ' + clicked);

      if (clicked) {
        // Wait for URL to change or just wait a bit
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
        } catch (e) {
          // Navigation might not happen, that's ok
          console.log('No navigation after click, waiting...');
          await new Promise(r => setTimeout(r, 3000));
        }
        console.log('After store selection URL: ' + page.url());

        // If still on switch-store, try direct navigation
        if (page.url().includes('switch-store')) {
          console.log('Still on switch-store, trying direct URL...');
          // List all links on the page to find the correct one
          const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a')).map(a => ({
              href: a.href,
              text: a.textContent.trim().substring(0, 50)
            })).filter(l => l.text.toLowerCase().includes('seoboost') || l.href.includes('switch') || l.href.includes('store'));
          });
          console.log('Store links found: ' + JSON.stringify(links));

          // Click the first matching link
          if (links.length > 0 && links[0].href) {
            await page.goto(links[0].href, { waitUntil: 'networkidle2', timeout: 30000 });
            console.log('After direct link URL: ' + page.url());
          }
        }
      } else {
        // Log all clickable elements for debugging
        const allElements = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a, button')).map(e => ({
            tag: e.tagName,
            href: e.href || '',
            text: e.textContent.trim().substring(0, 50)
          })).slice(0, 20);
        });
        console.log('Available elements: ' + JSON.stringify(allElements));
        console.error('Could not find "seoboost" store link');
        process.exit(1);
      }
    }

    // Step 4: Go to payment settings
    console.log('Step 4: Navigating to payment settings...');
    await page.goto('https://seller-area.youcan.shop/admin/settings/payment', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    console.log('Step 4 URL: ' + page.url());

    // Check if we're actually on the payment settings page
    const pageTitle = await page.title();
    console.log('Page title: ' + pageTitle);

    // Take a screenshot for debugging
    const pageContent = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log('Page content preview: ' + pageContent);

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

      if (!xsrf) return { status: 0, error: 'XSRF token not found in cookies: ' + document.cookie.substring(0, 200) };

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
        return { status: resp.status, body: body.substring(0, 500), url: window.location.href };
      } catch (e) {
        return { status: 0, error: e.message, url: window.location.href };
      }
    }, PAYPAL_EMAIL);

    console.log('Result: status=' + result.status);
    console.log('Response body: ' + (result.body || result.error));
    console.log('Page URL when request was made: ' + result.url);

    // Check both HTTP status and response body
    const bodyParsed = result.body ? JSON.parse(result.body) : null;
    const realSuccess = result.status === 200 && (!bodyParsed || !bodyParsed.status || bodyParsed.status === 200 || bodyParsed.status === true);

    if (realSuccess) {
      console.log('SUCCESS: PayPal email changed to ' + PAYPAL_EMAIL);
    } else {
      console.error('FAILED: status=' + result.status + ', body=' + (result.body || result.error));
      process.exit(1);
    }
  } catch (error) {
    console.error('ERROR: ' + error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();

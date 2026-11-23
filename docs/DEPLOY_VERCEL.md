# Deploy the MoodShift API on Vercel

The repository root is the Vercel project. Its Express entry point exports the app without opening a port. The Chrome extension is built and loaded separately. The AWS worker has its own deployment.

## Upgrade an existing API to command version 2

1. In the project dashboard, check **Settings → Environments → Production → Branch Tracking** before pushing code. A push to the configured production branch can publish automatically. [Vercel Git deployments](https://vercel.com/docs/git)
2. After confirming the intended branch is a preview branch, push it and open the resulting deployment under **Deployments**. You can also create a preview deployment from the chosen Git ref. Use the existing Preview environment variables for Gemini, permitted extension origins, and demo access. [Vercel deploying documentation](https://vercel.com/docs/deployments)
3. Request `/health` on the test deployment. A version 2 backend returns HTTP 200 and the header `X-MoodShift-Controls: 2`. Once you have verified the revision and want to release it, choose **Promote to Production** on that deployment. [Vercel promotion instructions](https://vercel.com/docs/deployments/promote-preview-to-production)
4. Rebuild the production extension with `npm run build:extension -- --mode production` and reload the existing installation in Chrome. Check the production alias used in `extension/.env.local`, capture a playing tab, and try “Lower pitch by two semitones and add Concert Hall reverb.”

The new extension calls `POST /api/interpret/v2` for typed and spoken commands. A `404` falls back to the existing `/api/interpret` endpoint for the previous DSP and stem actions. Following the preview and promotion workflow allows the existing production branch to stay where it is.

## Prepare the extension ID and credentials

1. Build an unpacked production copy on the computer you will use for the demo. Use the final domains if you know them, or use the example placeholders to obtain the Chrome ID. Keep using this same unpacked directory and Chrome profile.

   ```powershell
   npm ci
   Copy-Item extension/.env.example extension/.env.local
   npm run build:extension -- --mode production
   ```

   Edit `extension/.env.local` to set the public endpoints. The production extension build uses values from this file first and uses terminal variables for keys absent from the file. The build prints the API URL it used. Store Vercel secrets in Vercel.

2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `extension/dist-cloud`. Copy its 32-character **ID**. An unpacked install from another path can have a different ID. Allow only the IDs used by your demo.
3. Generate a random demo code on your own machine and keep it in a password manager. One way to generate 32 random bytes in URL-safe format is `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Use a new code for the demo and keep it out of shell arguments, source files, and build variables. Use the same code in the AWS worker if one extension will access both services.

| Vercel environment variable | Value |
| --- | --- |
| `MOODSHIFT_DEPLOYMENT` | `cloud-demo`. |
| `ALLOWED_EXTENSION_ORIGINS` | Exact origins such as `chrome-extension://<ID>`. Separate multiple origins with commas. |
| `DEMO_ACCESS_TOKEN` | The random 32–128 character URL-safe code. Store it as a sensitive variable. |
| `GEMINI_API_KEY` | The operator’s Gemini API key. Store it as a sensitive variable. |
| `GEMINI_MODEL` | Optional. Default `gemini-3.1-flash-lite`. |

The API accepts bounded local sound preferences with a Gemini prompt. Existing deployments that use `cloud-owner` can keep that value or switch to `cloud-demo`. Both require the same access checks.

## Provision the installed extension

An existing Chrome installation continues to use its saved access code. For a new authorized installation, open the MoodShift side panel's DevTools Console and run this snippet. Enter the operator-provided code in the prompt. Use the side panel's extension context.

```js
{
  const code = prompt('Enter the access code provided by your MoodShift operator')?.trim();
  if (code && /^[A-Za-z0-9_-]{32,128}$/.test(code)) {
    await chrome.storage.local.set({ moodshiftDemoAccessCode: code });
  }
}
```

The production backend still verifies the bearer token and the extension origin. The AWS worker also authenticates connections. Keep the credential in the local Chrome profile and backend secret settings.

## Deploy from the dashboard

1. Push the feature branch yourself to the Git provider your Vercel account can access. In Vercel choose **Add New → Project**, choose **Import** for the repository, and use a dedicated project for this demo.
2. On the import screen, leave **Root Directory** at the repository root (`./`). Use the **Express** preset and default Express build settings. The extension shares TypeScript validation with the server, so selecting `server/` would hide those imports.
3. Enter the environment variables above in **Environment Variables** for **Production**. Enable them for **Preview** only when you intend to test that branch with its own credentials. If import initially tracks `main`, set the dedicated project’s production branch to `feature/cloud-deployment` in **Settings → Environments → Production → Branch Tracking** and deploy that branch. The CLI below can also deploy the current branch directly to Production.
4. Deploy the production revision. Copy the HTTPS production domain from **Domains** and open `https://<project>.vercel.app/health`. Expect HTTP 200 with `ok: true`, the model name, and `aiConfigured: true` when a Gemini key is present. Health checks key presence. Use the [smoke test](CLOUD_SMOKE_TEST.md) to verify actual model access.
5. In `extension/.env.local`, set `API_BASE_URL` to the production domain listed under **Domains**. Verify its `/health` returns JSON without a Vercel login. Set `STEM_WS_URL` to the AWS WSS address, or use `ws://127.0.0.1:8788` for the local stem helper. Start the local helper with the extension ID shown for `extension/dist-cloud` in `chrome://extensions`. Rebuild with `npm run build:extension -- --mode production` and reload `extension/dist-cloud` in Chrome. Follow [operator provisioning](#provision-the-installed-extension) if this is a new installation.

## Deploy using the CLI

Run these commands yourself from the repository root with Node.js 22. `vercel link` lets you select or create the project. Use the prompts for values so secrets do not enter command history.

```text
npx vercel@latest login
npx vercel@latest link
npx vercel@latest env add MOODSHIFT_DEPLOYMENT production
npx vercel@latest env add ALLOWED_EXTENSION_ORIGINS production
npx vercel@latest env add DEMO_ACCESS_TOKEN production --type secret
npx vercel@latest env add GEMINI_API_KEY production --type secret
npx vercel@latest deploy --prod
```

To check a linked production build on your machine, use `npx vercel@latest pull --yes --environment=production` then `npx vercel@latest build --prod`. The pulled project settings and environment files are local to `.vercel/`. Keep them private. Use the returned deployment’s production alias for `/health` and the extension configuration.

## Access controls, costs, and rotation

- **Shared demo limits.** The API has per-instance limits of 12 authenticated requests per minute and 250 per UTC day. Serverless instances and deploys reset or multiply these counters. Configure a Vercel **Firewall → Configure → New Rule** rate limit for the interpretation endpoint if your plan supports it. Set Gemini project quotas and alerts independently. Review Vercel usage and configure Spend Management notifications or production pause where your plan supports it. [Vercel rate limits](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting) · [Spend Management](https://vercel.com/docs/spend-management)
- **Browser requests.** The server accepts exactly the configured browser origins. Requests without an Origin can use the API with the same bearer code. Keep Vercel’s interactive deployment protection off the production alias used by the extension, or the login page will block background requests. Use application authentication and WAF restrictions on the demo alias. A public launch needs per-user authentication, authorization, and durable quotas.
- **Rotation.** Update `DEMO_ACCESS_TOKEN` on Vercel and the AWS worker, redeploy the Vercel production alias, restart the worker, and provision the new code. Remove old reachable Vercel deployments or apply deployment protection to them so their old code cannot still be used. To revoke GPU access immediately, stop the service or restrict the security group.
- **Diagnose.** HTTP `401` means the code is missing or wrong. HTTP `403` indicates an unapproved browser origin. Check Vercel logs for startup configuration errors with the variable names only. HTTP `429` can come from the application, firewall, or Gemini quota. Local development still uses `npm run dev:server` on loopback without a demo code.

[Vercel Express documentation](https://vercel.com/docs/frameworks/backend/express) · [Vercel environment variables](https://vercel.com/docs/environment-variables)

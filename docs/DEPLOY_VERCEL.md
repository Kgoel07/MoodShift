# Deploy the MoodShift API on Vercel

The repository root is the Vercel project. Its Express entry point exports the app without opening a port. The Chrome extension is built and loaded separately. The AWS worker has its own deployment.

## Prepare the extension ID and credentials

1. Build an unpacked production copy on the computer you will use for the demo. Use the final domains if you know them, or use the example placeholders to obtain the Chrome ID. Keep using this same unpacked directory and Chrome profile.

   ```powershell
   npm ci
   $env:API_BASE_URL = 'https://api.example.com'
   $env:STEM_WS_URL = 'wss://stems.example.com/stem'
   npm run build:extension -- --mode production
   ```

2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `extension/dist-cloud`. Copy its 32-character **ID**. An unpacked install from another path can have a different ID. Allow only the IDs used by your demo.
3. Generate a random demo code on your own machine and keep it in a password manager. One way to generate 32 random bytes in URL-safe format is `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Use a new code for the demo and keep it out of shell arguments, source files, and build variables. Use the same code in the AWS worker if one extension will access both services.

| Vercel environment variable | Value |
| --- | --- |
| `MOODSHIFT_DEPLOYMENT` | `cloud-demo` for all shared demos. Use `cloud-owner` only on a separate deployment whose code is exclusive to a single operator. |
| `ALLOWED_EXTENSION_ORIGINS` | Exact origins such as `chrome-extension://<ID>`. Separate multiple origins with commas. |
| `DEMO_ACCESS_TOKEN` | The random 32–128 character URL-safe code. Store it as a sensitive variable. |
| `GEMINI_API_KEY` | The operator’s Gemini API key. Store it as a sensitive variable. |
| `GEMINI_MODEL` | Optional. Default `gemini-3.1-flash-lite`. |
| `SUPERMEMORY_API_KEY` | Optional in `cloud-owner` only. Store it as a sensitive variable. |
| `CLOUD_MEMORY_INSTALLATION_ID` | Required in `cloud-owner`. Set it to that operator’s extension installation UUID. |

`cloud-demo` disables memory operations and profile retrieval. For `cloud-owner`, enable **Personalization** in the extension to create its installation ID. In the extension side panel’s DevTools Console, run `(await chrome.storage.local.get('moodshiftPersonalization')).moodshiftPersonalization?.installationId`. Copy the UUID into the Vercel setting. The backend pins this namespace and still requires the code on every request. Keep the owner deployment and its code private. A shared code and a client-provided UUID provide no multi-user authorization.

## Deploy from the dashboard

1. Push the feature branch yourself to the Git provider your Vercel account can access. In Vercel choose **Add New → Project**, choose **Import** for the repository, and use a dedicated project for this demo.
2. On the import screen, leave **Root Directory** at the repository root (`./`). Use the **Express** preset and default Express build settings. The extension shares TypeScript validation with the server, so selecting `server/` would hide those imports.
3. Enter the environment variables above in **Environment Variables** for **Production**. Enable them for **Preview** only when you intend to test that branch with its own credentials. If import initially tracks `main`, set the dedicated project’s production branch to `feature/cloud-deployment` in **Settings → Environments → Production → Branch Tracking** and deploy that branch. The CLI below can also deploy the current branch directly to Production.
4. Deploy the production revision. Copy the HTTPS production domain from **Domains** and open `https://<project>.vercel.app/health`. Expect HTTP 200 with `ok: true`, the model name, and `aiConfigured: true` when a Gemini key is present. Health checks key presence. Use the [smoke test](CLOUD_SMOKE_TEST.md) to verify actual model access.
5. Update `API_BASE_URL` to the real production origin and `STEM_WS_URL` to the AWS WSS address. Rebuild the same `extension/dist-cloud` directory and reload it in Chrome. Open **Private demo access**, enter the code, and click **Save demo code**.

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

For owner mode, add `CLOUD_MEMORY_INSTALLATION_ID` and `SUPERMEMORY_API_KEY` through the dashboard or equivalent `vercel env add` commands before deploying. To check a linked production build on your machine, use `npx vercel@latest pull --yes --environment=production` then `npx vercel@latest build --prod`. The pulled project settings and environment files are local to `.vercel/`. Keep them private. Use the returned deployment’s production alias for `/health` and the extension configuration.

## Access controls, costs, and rotation

- **Shared demo limits.** The API has per-instance limits of 12 authenticated requests per minute and 250 per UTC day. Serverless instances and deploys reset or multiply these counters. Configure a Vercel **Firewall → Configure → New Rule** rate limit on the two API paths if your plan supports it. Set Gemini project quotas and alerts independently. Review Vercel usage and configure Spend Management notifications or production pause where your plan supports it. [Vercel rate limits](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting) · [Spend Management](https://vercel.com/docs/spend-management)
- **Browser requests.** The server accepts exactly the configured browser origins. Requests without an Origin can use the API with the same bearer code. Keep Vercel’s interactive deployment protection off the production alias used by the extension, or the login page will block background requests. Use application authentication and WAF restrictions on the demo alias. A public launch needs per-user authentication, authorization, and durable quotas.
- **Rotation.** Update `DEMO_ACCESS_TOKEN` on Vercel and the AWS worker, redeploy the Vercel production alias, restart the worker, and enter the new code in the extension. Remove old reachable Vercel deployments or apply deployment protection to them so their old code cannot still be used. To revoke GPU access immediately, stop the service or restrict the security group.
- **Diagnose.** HTTP `401` means the code is missing or wrong. HTTP `403` indicates an unapproved browser origin, shared-demo memory access, or the wrong owner installation. Check Vercel logs for startup configuration errors with the variable names only. HTTP `429` can come from the application, firewall, or Gemini quota. Local development still uses `npm run dev:server` on loopback without a demo code.

[Vercel Express documentation](https://vercel.com/docs/frameworks/backend/express) · [Vercel environment variables](https://vercel.com/docs/environment-variables)

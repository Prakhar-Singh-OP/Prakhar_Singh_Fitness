# Prakhar Singh Fitness

The app remains a standalone React-in-HTML fitness planner. An optional Vercel-compatible API now adds coach accounts, client invitations, and Supabase PostgreSQL-backed profile/progress sync. Without a configured database, the existing browser-only app continues to work.

## Local development

1. Install Node.js 20.6 or newer.
2. Run `npm install`.
3. Run `npm run dev`, then open `http://127.0.0.1:3000`.

The local server serves the app and API. Without `DATABASE_URL`, account endpoints return a clear configuration error and the local-only features remain available. The `dev` and `db:migrate` scripts load values from the ignored `.env` file.

To use accounts locally, copy `.env.example` to `.env`, set `DATABASE_URL` to the Supabase **Transaction pooler** connection string from **Project Settings → Database → Connect**, then run the migration and start the app:

```powershell
npm run db:migrate
npm run dev
```

The app validates Supabase's database certificate using the CA certificate in `supabase/prod-ca-2021.crt`; do not disable TLS certificate verification. Keep `.env` private and never commit database credentials.

If configuring the connection through a PowerShell session instead of `.env`, use:

```powershell
$env:DATABASE_URL = "your-postgres-connection-string"
$env:APP_URL = "http://127.0.0.1:3000"
npm run db:migrate
npm run dev
```

## Supabase database

The database migration is `supabase/migrations/20261103000000_accounts.sql`. It creates app-specific `psf_`-prefixed account, session, coach workspace, client, invitation, version, rate-limit, and weekly check-in tables; enables row-level security; and revokes direct access from Supabase's `anon` and `authenticated` API roles. Re-running `npm run db:migrate` safely applies the new check-in table to an existing installation. The existing public tables are left untouched. The app's server-side `DATABASE_URL` is the only database access path.

The selected Supabase project reference is `wkncvknkvvvrixvrognw`.

Use the Supabase **Transaction pooler** URL for Vercel's serverless runtime. Keep the password secret. Run the migration using the same URL (or a Supabase direct/session connection if the network restricts the pooler):

```powershell
$env:DATABASE_URL = "your-supabase-transaction-pooler-url"
npm run db:migrate
```

In Supabase, keep backups enabled and restrict project membership to trusted operators. Do not expose the database URL, service-role key, or database password in frontend code or public environment variables.

## Deploying on Vercel

Deploy this folder as the project root and configure these Vercel environment variables for every environment that should support accounts:

- `DATABASE_URL`: the Supabase Transaction pooler PostgreSQL connection string (server-only).
- `APP_URL`: the app's canonical origin, such as `https://fitness.example.com` (no path).
- `RESEND_API_KEY`: a server-only Resend API key for password-recovery email.
- `EMAIL_FROM`: a sender address verified with Resend.

Run `npm run db:migrate` against the production database before enabling sign-up. The API is under `api/`; `vercel.json` includes Supabase's CA certificate with the function bundle and retains the existing clean-URL settings. Vercel supplies HTTPS and the app uses same-origin API requests.

## Account behavior

- Coaches create an account from the Clients page. Existing browser data is not uploaded automatically; the coach must choose **Upload browser profiles**.
- Add each client's email and create a one-time invitation link from the roster. The coach must deliver that link through a private channel; the app does not send email. Links expire after seven days and are single-use.
- Invited clients create their own password and can access only their linked profile and progress. Coaches see only their own roster.
- Profile and progress changes sync automatically. Workspace version checks detect edits from another device; the user can load the server copy or explicitly keep this device's data. Replaced browser data is backed up locally.
- Invited clients can submit a weekly check-in with adherence, completed workouts, energy, and optional notes. Coaches can review and reply; both are scoped to the coach-client relationship and included in workspace version checks.
- Diet plans support per-ingredient swaps within the same food category and the client's vegetarian/vegan preference. Nutrition and estimated cost are recalculated, and saved choices sync with the active profile.
- Progress includes check-in adherence, logged workouts, and energy alongside weight and body measurements.
- Removing a linked client deletes that client account and its sessions as well as the profile and progress.
- Passwords are stored as salted scrypt hashes. Sessions use opaque, hashed tokens in `HttpOnly`, `SameSite=Strict` cookies with a 14-day expiry. Sign-in attempts and coach-account creation are rate-limited.
- Password recovery uses Resend when `RESEND_API_KEY`, `EMAIL_FROM`, and `APP_URL` are configured. Tokens are stored as hashes, expire after 30 minutes, are single-use, and reset all active sessions. Recovery requests are rate-limited.

Coach account email verification and automated client-invitation delivery are not configured. Before storing sensitive client information, deploy over HTTPS, secure and back up the database, configure email delivery, and establish an appropriate privacy and retention policy. Local browser storage and its recovery backups are not encrypted.

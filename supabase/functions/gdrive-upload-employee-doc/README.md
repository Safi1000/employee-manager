# Google Drive employee-docs setup (OAuth refresh-token model)

These two edge functions (`gdrive-upload-employee-doc` and
`gdrive-delete-employee-doc`) upload employee documents to a regular Google
account's Drive using OAuth. A single account "owns" all employee docs and
its 15 GB free quota backs the storage.

> Why OAuth and not a service account? Service accounts have zero storage
> quota on personal Drives — uploading anything fails with
> `storageQuotaExceeded`. Service accounts only work with paid Workspace
> Shared Drives. OAuth on a regular Gmail sidesteps that entirely.

## One-time Google Cloud setup

### 1. Create an OAuth client

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. **Create Credentials → OAuth client ID**.
   - If prompted, configure the OAuth consent screen first (next section).
3. **Application type: Web application**.
4. Name: anything (e.g. `Employee Manager Drive`).
5. **Authorized redirect URIs**: add `https://developers.google.com/oauthplayground`.
6. Create → copy the **Client ID** and **Client secret**.

### 2. Configure the OAuth consent screen

(Skip if you've already done this for another project.)

1. <https://console.cloud.google.com/apis/credentials/consent>.
2. **User Type: External** (only option without Google Workspace).
3. Fill in: App name (`Employee Manager`), User support email, Developer
   contact email. Skip logo / URLs.
4. **Scopes**: Add `https://www.googleapis.com/auth/drive.file`. This is the
   only scope we need — non-sensitive, no Google verification required.
5. **Test users**: not required for non-sensitive scopes once published, but
   add the account you want to use as a test user anyway.
6. **Save**, then on the consent screen overview click **Publish app** →
   **Confirm**. Because `drive.file` is non-sensitive there's no
   verification step — the app moves straight to "In production". This is
   important: refresh tokens issued for apps in "Testing" status expire in
   7 days, but production-status tokens don't expire.

### 3. Get a refresh token

1. Go to <https://developers.google.com/oauthplayground/>.
2. Click the **gear icon (top right)** → check **Use your own OAuth
   credentials** → paste the Client ID + Client secret from step 1 → Close.
3. In the left "Select & authorize APIs" panel, scroll to the bottom and
   paste this scope into the input field:
   ```
   https://www.googleapis.com/auth/drive.file
   ```
4. Click **Authorize APIs**. Sign in with the Google account that should
   own the employee documents → click **Allow**.
5. Click **Exchange authorization code for tokens**.
6. Copy the **refresh token** value from the response.

## Set Supabase Edge Function secrets

<https://supabase.com/dashboard/project/mmkfpnshxjcyijhuydgr/functions/secrets>

| Secret name | Value |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | from step 1 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | from step 1 |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | from step 3 |

You can delete the old service-account secrets if they're still there:
`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`,
`GOOGLE_DRIVE_PARENT_FOLDER_ID`. The new functions don't use them.

## How the functions behave

- On the first upload, the function creates a folder named `EmployeeManager`
  at the root of the OAuth'd account's Drive. It's tagged with an
  `appProperties.type=employee_manager_root` flag so we can find it again
  later even if you rename it from the Drive UI.
- Each employee gets a subfolder `emp_<uuid>` inside that root, created on
  first upload for that employee.
- Files are made world-readable (anyone-with-link can view) so the URL
  stored on `employee_documents.drive_view_url` resolves without further
  auth.
- Because the OAuth scope is `drive.file`, the app can ONLY see / modify
  the files it created. It cannot snoop on the rest of the user's Drive.

## Common errors

- **`Google token exchange failed (status 400) ... invalid_grant`** — the
  refresh token was revoked, expired (apps in Testing mode expire tokens
  after 7 days), or doesn't match the client_id/client_secret. Re-run the
  OAuth Playground flow.
- **`status 401`** — usually a typo in `GOOGLE_OAUTH_CLIENT_SECRET`.
- **`Drive folder create failed (status 403)`** — the OAuth grant was made
  with a scope narrower than `drive.file`. Re-run the Playground flow with
  the correct scope.

## Rotating credentials

To rotate the refresh token (e.g. someone leaves the company and you want
to switch ownership of the docs to a different Google account):

1. Run the OAuth Playground flow again, signed in with the new account.
2. Replace `GOOGLE_OAUTH_REFRESH_TOKEN` in Supabase secrets.
3. Note: docs uploaded before the switch belong to the previous account.
   Either keep both accounts active, or download + re-upload existing docs.

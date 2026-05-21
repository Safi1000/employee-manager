# Google Drive employee-docs setup

These two edge functions (`gdrive-upload-employee-doc` and
`gdrive-delete-employee-doc`) move employee document uploads from Supabase
Storage to a shared Google Drive folder, using a single service account so
no per-user OAuth is required.

## One-time Google Cloud setup

1. **Create a Google Cloud project** at <https://console.cloud.google.com>
   (or reuse an existing one).
2. **Enable the Drive API** for that project:
   <https://console.cloud.google.com/apis/library/drive.googleapis.com>.
3. **Create a service account**:
   - IAM & Admin → Service Accounts → Create service account
   - Give it a name like `employee-docs-uploader`
   - Skip the optional role assignment (no project role needed)
   - Done.
4. **Generate a JSON key** for the service account:
   - Click the service account → Keys tab → Add Key → JSON
   - Save the downloaded file somewhere safe — you won't be able to download it again.
5. **Note the service account email** (e.g. `employee-docs-uploader@my-project.iam.gserviceaccount.com`).
6. **Create the parent Drive folder**:
   - Open <https://drive.google.com>
   - New → Folder → call it whatever (e.g. `Employee Documents`)
   - Open the folder. The URL looks like
     `https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz` —
     the long string after `/folders/` is the **folder ID**.
   - Share this folder with the service account email as **Editor**.
   - (Optional but recommended for organisations with Google Workspace:
     use a **Shared Drive** instead of "My Drive" so the files belong to
     the company, not the service account.)

## Set Supabase Edge Function secrets

Paste these three values into the project's Edge Function secrets
(Project Settings → Edge Functions → Secrets):

| Name | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | The `client_email` field from the JSON key |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | The `private_key` field from the JSON key — **keep the `\n` escape sequences as literal text**. Do not turn them into real line breaks. |
| `GOOGLE_DRIVE_PARENT_FOLDER_ID` | The folder ID from step 6 |

## Deploy the functions

From the project root:

```bash
supabase functions deploy gdrive-upload-employee-doc
supabase functions deploy gdrive-delete-employee-doc
```

## How it works

- On upload the function authenticates as the service account, lazily
  creates a per-employee subfolder (`emp_<uuid>`) under the parent folder,
  and uploads the file there with `anyone-with-link can view` permission.
- The frontend receives `drive_file_id` + `drive_view_url` and inserts an
  `employee_documents` row referencing them.
- Legacy rows (uploaded to Supabase Storage before the cutover) still work
  — the frontend falls back to `storage.getPublicUrl(storage_path)` when
  `drive_view_url` is null.

## Cost / quota notes

- Drive storage: 15 GB free on a personal account; Workspace plans go to
  30 GB+ per user. Files attributed to the service account count against
  whoever owns the Drive (Shared Drive = company; My Drive = service
  account).
- Drive API has a 1B+ requests/day quota. Way more than this app will use.
- The first upload after a cold start pays for one OAuth token exchange
  (~200ms); subsequent uploads on the same warm container reuse the
  cached token for an hour.

## Rotating the service-account key

When the JSON key needs rotation (recommended yearly):

1. Generate a new JSON key on the same service account.
2. Replace `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` in Supabase secrets.
3. Delete the old key on Google Cloud after a few minutes.

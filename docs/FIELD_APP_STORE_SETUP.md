# Field app — push notifications and store setup

Four accounts, done once. Steps 1–3 make push notifications work (a new expense
request reaches the approvers' phones; the decision goes back to whoever asked).
Step 4 is the Play Store listing. None of these need anything from Bastion — and
**never paste a password, private key or `.p8`/`.json` key file into a chat**;
upload them only where each step says.

Use one company Google account for Firebase and Play (for example the one that
owns the domain), so the app's Android pieces stay together.

---

## 1. Expo account → the push project id  (10 minutes)

The app sends pushes through Expo's free push service.

1. Go to **expo.dev** → *Sign up* (use the company email). Create an
   **organisation** called `ggs` (top-left menu → *Create organization*).
2. In that organisation: **Projects → Create a project**, name it **GGS Field**,
   slug **ggs-field**.
3. Open the project. Copy its **Project ID** (a long id like
   `1a2b3c4d-…`) from the project page.
4. **Send me the Project ID** (it is not a secret). I put it in the app's
   settings (`app.json`).

---

## 2. Firebase → Android pushes  (15 minutes)

1. Go to **console.firebase.google.com** → *Add project* → name **GGS Field** →
   Google Analytics *off* → Create.
2. On the project page: **Add app → Android**.
   - Android package name: **`pk.ggs.field`** (exactly this)
   - App nickname: GGS Field → *Register app*.
3. Download **`google-services.json`** and **send it to me** — it is app
   configuration, not a secret; it goes into the build.
4. Still in Firebase: **⚙ Project settings → Service accounts → Generate new
   private key** → a JSON file downloads. **This one IS secret.** Do not send it
   to anyone. Instead:
   - Go to **expo.dev → GGS Field → Credentials → Android → Add a Google
     Service Account Key for push notifications (FCM V1)** and upload that file
     there. Then you can delete it from your computer.

---

## 3. Apple → iPhone pushes  (10 minutes, when the iPhone build comes)

1. **developer.apple.com → Certificates, IDs & Profiles → Identifiers → +** →
   App IDs → App → Bundle ID **`pk.ggs.field`**, tick **Push Notifications** →
   Register.
2. **Keys → +** → name *GGS Field push* → tick **Apple Push Notifications
   service (APNs)** → Continue → Register → **Download** the `.p8` file (Apple
   lets you download it once). Note the **Key ID** shown, and your **Team ID**
   (top-right of the developer site).
3. **expo.dev → GGS Field → Credentials → iOS → Push Key → Add** → upload the
   `.p8`, enter the Key ID and Team ID. Keep the `.p8` somewhere safe offline.

The iPhone build itself is done in Expo's cloud (no Mac needed); I'll set it up
when we get there.

---

## 4. Google Play developer account  (start now — it takes days)

1. **D-U-N-S number** (free, needed for an organisation account): request it at
   **dnb.com → D-U-N-S Number → Get a D-U-N-S Number** for the company's legal
   name and address exactly as registered. It can take 1–2 weeks.
   - Why organisation and not personal: a *personal* account must first run a
     closed test with 12 testers for 14 days before it may publish. An
     organisation account does not.
2. When you have the D-U-N-S: **play.google.com/console/signup** → *An
   organization* → pay the one-time **USD 25** → enter the D-U-N-S and the
   company details → Google verifies (a few days).
3. Tell me when it is verified. I will prepare the listing: name, short and long
   description, screenshots, the **privacy policy** page and the **data safety**
   answers (the app uses the camera and location, and shows only staff data).
   You submit from your account.

We can keep the app **unlisted / for your staff only**, so it doesn't show in
public searches.

---

## What I need back from you

| From step | Send me | Secret? |
|---|---|---|
| 1 | Expo **Project ID** | No |
| 2 | **`google-services.json`** | No |
| 2 | — (upload the service-account key to expo.dev yourself) | **Yes** |
| 3 | — (upload the `.p8` to expo.dev yourself) | **Yes** |
| 4 | "Play account verified" | — |

As soon as I have the Project ID and `google-services.json`, the next APK has
push notifications. Everything else in the app works without them — approvers
see the Bastion alert on the web meanwhile.

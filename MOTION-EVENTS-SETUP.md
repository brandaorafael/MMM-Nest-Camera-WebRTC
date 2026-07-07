# Nest Event Setup (Pub/Sub) — for motion-driven auto-focus

This guide sets up **Google Cloud Pub/Sub** so the module can receive real-time
camera events (motion, person, doorbell chime) and automatically focus the camera
that triggered. Do this **once**; it takes ~15 minutes.

> You only need this for the **motion-driven auto-focus** feature. Live streaming,
> multi-camera, auto-cycle, keyboard/web control all work **without** any of this.

## How events flow

```
Nest camera  ──▶  Google SDM service  ──▶  Pub/Sub topic (yours)  ──▶  pull subscription  ──▶  the Pi
                                            "nest-events"              "nest-events-sub"      (node_helper)
```

Nest publishes an event to a Pub/Sub **topic in your own Google Cloud project**;
the Pi **pulls** those events from a **subscription** using a service-account key.

## Before you start

You already have these from the base module setup:

- A **Device Access project** (the `nestProjectId` in your config) — created at
  <https://console.nest.google.com/device-access/>. Cost: one-time $5 USD.
- A **Google Cloud project** (the one your OAuth `nestClientId` belongs to). You'll
  create the topic/subscription here. Find its **Project ID** (a string like
  `my-nest-1234`, *not* the number) at <https://console.cloud.google.com/> → project picker.

Throughout, replace:
- `<GCP_PROJECT_ID>` — your Google Cloud project ID string
- `<DEVICE_ACCESS_PROJECT_ID>` — your Device Access project UUID

---

## Step 1 — Create your Pub/Sub topic

> ⚠️ **Do this _before_ registering anything in the Device Access Console.** The
> console validates that the topic already exists and that Nest is allowed to publish
> to it — if you register first you get *"The PubSub topic is not found"*.

Cloud Console → **Pub/Sub → Topics → Create topic**:
- Topic ID: `nest-events`
- Uncheck "Add a default subscription" (we create a pull one deliberately in Step 4).
- Create.

Copy the full **Topic name** shown: `projects/<GCP_PROJECT_ID>/topics/nest-events`.
Use that exact string later — don't hand-type it.

(Make sure the **Pub/Sub API** is enabled for the project; the console prompts you if not.)

## Step 2 — Authorize Nest to publish to your topic

Nest publishes as a **Google Group**, `sdm-publisher@googlegroups.com` — added with a
`group:` prefix, **not** as a service account.

> ⚠️ **Do NOT add it through the console's "Add principal" picker.** The picker does a
> directory lookup and rejects it with *"Email addresses and domains must be associated
> with an active Google / Workspace / Cloud Identity account."* That's a UI limitation,
> not a wrong address. Use **Cloud Shell** (the `>_` icon in the console top bar), which
> skips that validation:

```bash
# make sure Cloud Shell is pointed at the right project
gcloud config set project <GCP_PROJECT_ID>

gcloud pubsub topics add-iam-policy-binding nest-events \
  --member="group:sdm-publisher@googlegroups.com" \
  --role="roles/pubsub.publisher"
```

> ⚠️ It must be `group:sdm-publisher@googlegroups.com`. Using `serviceAccount:` or any
> `@system.gserviceaccount.com` address fails with *"Service account … does not exist"* —
> and a wrong address **fails silently at runtime** (events never arrive). The current
> address is listed as a prerequisite in Google's
> [Subscribe to events](https://developers.google.com/nest/device-access/subscribe-to-events)
> docs — check there if this ever changes.

## Step 3 — Register the topic in the Device Access Console

<https://console.nest.google.com/device-access/> → open your project → **Pub/Sub topic**:
- Choose a **self-hosted topic** and paste `projects/<GCP_PROJECT_ID>/topics/nest-events`.
- It should validate now that Step 2 granted publish rights.

## Step 4 — Create the pull subscription

Cloud Console → **Pub/Sub → Subscriptions → Create subscription**:
- Subscription ID: `nest-events-sub`
- Topic: select **`nest-events`** (it's in your own project — pick it from the list).
- Delivery type: **Pull**.
- Leave the rest default → Create.

## Step 5 — Service account + key for the Pi

The Pi needs credentials to pull from the subscription.

1. **IAM & Admin → Service Accounts → Create service account**
   - Name: `nest-mmm-pi`
   - Grant role: **Pub/Sub Subscriber** (`roles/pubsub.subscriber`).
   - Create.
2. Open the new service account → **Keys → Add key → Create new key → JSON**.
   A `.json` key file downloads.

> 🔒 **Treat this JSON like a password.** Don't commit it. Place it next to the module's
> `tokens.json` (already git-ignored). Never paste its contents into chat, issues, or
> logs.

## Step 6 — Put the key on the Pi and configure the module

1. Copy the key to the module directory on the Pi (keep the name simple):
   ```bash
   scp your-downloaded-key.json rafael@<pi-ip>:MagicMirror/modules/MMM-Nest-Camera-WebRTC/pubsub-key.json
   ```
2. Add the event options to the module's config block in `config/config.js`:
   ```js
   {
     module: "MMM-Nest-Camera-WebRTC",
     position: "top_left",
     config: {
       // …existing camera config…

       // Motion-driven auto-focus (requires the Pub/Sub setup above)
       enableMotionFocus: true,
       pubsubSubscription: "projects/<GCP_PROJECT_ID>/subscriptions/nest-events-sub",
       pubsubKeyFile: "pubsub-key.json",   // relative to the module folder
       motionHoldMs: 20000                 // keep the triggered camera as hero this long
     }
   }
   ```
3. Install the Pub/Sub client on the Pi and restart:
   ```bash
   ssh rafael@<pi-ip> "cd MagicMirror/modules/MMM-Nest-Camera-WebRTC && npm install"
   ssh rafael@<pi-ip> "cd MagicMirror && bash start-background.sh"
   ```

> Camera **events must be enabled per device** in the Google Home app (Doorbell press,
> Person/Motion). A camera with events off will stream fine but never trigger auto-focus.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| *"The PubSub topic is not found"* when registering in Device Access Console | Topic doesn't exist yet, or Nest can't publish to it. Do Steps 1–2 first. |
| *"Email addresses and domains must be associated with an active Google … account"* when adding the publisher | Console picker rejects the Google Group. Grant it via **Cloud Shell** (Step 2), not the UI. |
| *"Service account sdm-publisher@… does not exist"* / *"… @system.gserviceaccount.com does not exist"* | Wrong member type/address. It's `group:sdm-publisher@googlegroups.com`, not a service account. |
| Setup all green but **no events arrive** | (a) Publisher grant used a wrong address — recheck Step 2 against the docs; (b) events not enabled for the device in Google Home; (c) key's service account lacks `Pub/Sub Subscriber` on the subscription. |

## Cost

A **self-hosted topic** bills Pub/Sub usage to your GCP project. Camera event volume is
tiny (a handful of small messages per motion/doorbell event), so this is effectively
free — well within the Pub/Sub free tier for a home setup — but it's a line item on
*your* project rather than Google's.

## References

- [Device Access — Subscribe to events](https://developers.google.com/nest/device-access/subscribe-to-events)
- [Device Access — Events reference](https://developers.google.com/nest/device-access/api/events)

# Evie Willow Workshop Scheduler — Online Setup

This guide walks you through getting your scheduler online so you can access it
from any browser, and put it on a workshop tablet in read-only mode.

You'll use three free services:

- **GitHub** — stores your code
- **Supabase** — stores your schedule data (the shared database)
- **Vercel** — turns your code into a live website with a URL

**Estimated time: 45–60 minutes** for first-time setup. Once done, you'll never
need to touch this again — just open the URL and use the scheduler.

---

## Part 1 — Sign up for the three services

### 1a. GitHub

1. Go to https://github.com/signup
2. Sign up with your email. Choose a username (e.g. `eviewillow`).
3. Verify your email.

### 1b. Supabase

1. Go to https://supabase.com and click **Start your project**.
2. Sign in with your GitHub account (easiest).
3. Once logged in, click **New project**.
4. Fill in:
   - **Name**: `evie-willow-scheduler`
   - **Database password**: click "Generate a password" and **save it somewhere safe** (you might never need it again, but keep it just in case)
   - **Region**: pick the closest to you (e.g. **West EU (London)**)
   - **Plan**: Free
5. Click **Create new project**. Wait 1–2 minutes for it to set up.

### 1c. Vercel

1. Go to https://vercel.com/signup
2. Click **Continue with GitHub** and authorise it.
3. You're in. We'll come back here in Part 4.

---

## Part 2 — Set up the database table in Supabase

When your Supabase project finishes setting up, you'll see its dashboard.

1. In the left sidebar, click the **SQL Editor** icon (looks like `</>`).
2. Click **New query**.
3. Paste this exactly:

```sql
create table kv_store (
  key text primary key,
  value jsonb,
  updated_at timestamptz default now()
);

alter table kv_store enable row level security;

create policy "Allow public read"  on kv_store for select using (true);
create policy "Allow public write" on kv_store for insert with check (true);
create policy "Allow public update" on kv_store for update using (true);
create policy "Allow public delete" on kv_store for delete using (true);

alter publication supabase_realtime add table kv_store;
```

4. Click **Run** (bottom-right). You should see a success message.

> **What that did:** created a simple key-value table to hold your scheduler
> data, opened it up so the app can read/write, and turned on realtime
> notifications so tablets stay in sync automatically.

> **About the "public" policy:** anyone who has your Supabase URL + anon key
> can read and write the data. Since your URL won't be published anywhere
> public, this is fine for a small workshop. If you ever want proper logins
> later, that's a separate setup.

5. Now grab your Supabase credentials. In the left sidebar, click the
   **Project Settings** gear icon, then **API**.
6. **Copy these two values somewhere safe** (notepad is fine):
   - **Project URL** (looks like `https://abcdefg.supabase.co`)
   - **anon public key** (a long string starting with `eyJ...`)

---

## Part 3 — Push the code to GitHub

You'll do this from your computer's command line. If you've never used the
command line before, the easiest way is:

### Option A — Use GitHub Desktop (recommended for beginners)

1. Download **GitHub Desktop** from https://desktop.github.com and install it.
2. Open it and sign in with your GitHub account.
3. Unzip the folder I gave you (`evie-willow-deploy`) somewhere on your computer.
4. In GitHub Desktop, click **File → Add Local Repository**, then pick that folder.
5. It'll say "this isn't a git repository — create one?". Click **Create a Repository**.
6. Name it `evie-willow-scheduler`. Click **Create**.
7. Click **Publish repository** (top-right). Uncheck "Keep this code private" if
   you don't mind it being public (it's just code, no data lives in here).
   Click **Publish**.
8. Your code is now on GitHub.

### Option B — Command line (if you've done this before)

```bash
cd evie-willow-deploy
git init
git add .
git commit -m "Initial commit"
gh repo create evie-willow-scheduler --public --source=. --push
```

---

## Part 4 — Deploy to Vercel

1. Go back to https://vercel.com
2. Click **Add New → Project**.
3. You'll see a list of your GitHub repos. Click **Import** next to `evie-willow-scheduler`.
4. Don't change any settings yet. Scroll down to **Environment Variables**.
5. Add these two variables (paste the values from Part 2 step 6):

   | Name | Value |
   |------|-------|
   | `VITE_SUPABASE_URL` | your Supabase Project URL |
   | `VITE_SUPABASE_ANON_KEY` | your Supabase anon public key |

6. Click **Deploy**. Wait 1–2 minutes for the build.
7. When it's done, you'll get a URL like `https://evie-willow-scheduler.vercel.app`.

**That's your scheduler. Visit the URL — it's live.**

---

## Part 5 — Set up the workshop tablet

1. Open the URL on the workshop tablet's browser.
2. Add `?readonly=1` to the end of the URL, like this:

   `https://evie-willow-scheduler.vercel.app/?readonly=1`

3. Bookmark that URL on the tablet. Or set it as the homepage.
4. The tablet will show **"READ-ONLY · WORKSHOP VIEW"** at the top and the
   prompt bar will be hidden. Staff can view the schedule but can't change anything.

When you make a change from your own device, the tablet will auto-update within
a second or two.

---

## Things to know

- **Free tier limits**: Supabase free tier allows 500MB of database and
  500K row reads per month. For a workshop scheduler, you'll never come close.
  Vercel free tier allows 100GB of bandwidth per month — also way more than
  enough.

- **Daily backup**: in Supabase, go to **Database → Backups** to see automatic
  daily backups. They're kept for 7 days on the free tier.

- **Updating the code**: if I send you a new version of the scheduler, replace
  `src/scheduler.jsx` in your GitHub repo (use GitHub Desktop's commit + push,
  or paste the new code via github.com directly). Vercel will auto-redeploy in
  about a minute.

- **Custom domain (optional)**: if you want `schedule.eviewillow.com` instead
  of the `vercel.app` URL, Vercel supports that under **Domains** in your
  project settings. You'll need to add a CNAME record at your domain registrar.
  Vercel walks you through it.

---

## Troubleshooting

**"Cannot read properties of null"** when loading the URL — usually means
the Supabase env vars aren't set. Go to Vercel → your project → Settings →
Environment Variables. Make sure both are there. Redeploy if needed (Deployments
tab → click the latest → Redeploy).

**Tablet doesn't auto-update** — check the Supabase SQL ran successfully.
The `alter publication supabase_realtime add table kv_store;` line is what
enables realtime sync.

**Schedule disappears after refresh** — if your data was previously in the
browser's local storage from the Claude artifact version, it won't transfer.
You'll need to re-enter your jobs in the new online version. (Future me will
build an import tool — ask if you need it.)

---

If anything goes wrong, copy the error message and bring it back to a Claude
chat — I can help you diagnose. The most common issues are typos in env vars
or the SQL not running fully.

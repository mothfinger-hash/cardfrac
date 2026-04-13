[README.md](https://github.com/user-attachments/files/26686193/README.md)
# CardFrac — Setup Guide

## Step 1 — Run the database schema

1. Open your Supabase project dashboard
2. Click **SQL Editor** in the left sidebar
3. Click **New query**
4. Open `schema.sql` from this folder and paste the entire contents
5. Click **Run** — you should see "Success. No rows returned"

## Step 2 — Create a Storage bucket for card photos

1. In Supabase, click **Storage** in the left sidebar
2. Click **New bucket**
3. Name it exactly: `card-photos`
4. Check **Public bucket** (so photos load without auth)
5. Click **Create bucket**

## Step 3 — Get your API keys

1. In Supabase, click **Settings** (gear icon) → **API**
2. Copy your **Project URL** (looks like `https://xxxx.supabase.co`)
3. Copy your **anon public** key (long string starting with `eyJ...`)
4. Open `supabase.js` and replace:
   - `YOUR_SUPABASE_URL_HERE` → your Project URL
   - `YOUR_SUPABASE_ANON_KEY_HERE` → your anon key

## Step 4 — Set yourself as admin

After signing up through the app for the first time:

1. In Supabase, click **Table Editor** → **profiles**
2. Find your row (by username or email)
3. Set `is_admin` to `true`
4. Save

## Step 5 — Push to GitHub

1. Create a new repository at github.com (name it `cardfrac`, set to Private)
2. Open Terminal (Mac) or Command Prompt (Windows) in this project folder
3. Run:
```
git init
git add .
git commit -m "Initial CardFrac project"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/cardfrac.git
git push -u origin main
```

## Step 6 — Deploy to Vercel

1. Go to vercel.com and sign in with your GitHub account
2. Click **Add New → Project**
3. Import your `cardfrac` repository
4. Click **Deploy** — that's it. Vercel auto-detects it's a static site.
5. Your app will be live at `https://cardfrac.vercel.app` (or similar)

## Step 7 — Set Vercel environment variables (optional but recommended)

Instead of hardcoding your Supabase keys in `supabase.js`, you can use Vercel environment variables:

1. In Vercel, go to your project → **Settings** → **Environment Variables**
2. Add:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon key

---

## File structure

```
cardfrac/
├── index.html       ← main app (your card-fractions.html, renamed)
├── supabase.js      ← all Supabase API calls
├── schema.sql       ← run once in Supabase SQL Editor
└── README.md        ← this file
```

## Notes

- The `schema.sql` file also contains optional seed data (4 demo listings) at the bottom — you can delete that section if you want to start with a clean database
- Row Level Security (RLS) is enabled on all tables — users can only read/write data they're permitted to access
- Image uploads go to Supabase Storage and are returned as permanent public URLs (no more base64 in memory)

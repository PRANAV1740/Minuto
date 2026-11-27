# Enabling Google sign-in

> Minuto's side is built and verified. What is left can only be done by you, because it means signing into your Google account and creating an OAuth client — neither of which anyone else can do for you.
>
> It takes about five minutes and costs nothing.

## What is already done

| | |
|---|---|
| Google provider wired into Better Auth | [web/app/lib/auth.ts](../web/app/lib/auth.ts) |
| Callback route | `/api/auth/callback/google` |
| Button shown only when configured | a button that fails on click is worse than no button |
| PKCE and state | verified present (S256, 32-char state) |

Verified by running the app with placeholder credentials and inspecting the authorize URL it builds:

```
https://accounts.google.com/o/oauth2/v2/auth
  client_id             = <from GOOGLE_CLIENT_ID>
  redirect_uri          = http://localhost:3000/api/auth/callback/google
  response_type         = code
  scope                 = email profile openid
  code_challenge_method = S256
  state                 = <32 chars>
```

So the only missing pieces are a real client id and secret.

## What you need to do

### 1. Create a project

Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a project, or pick an existing one. The name is only ever seen by you.

### 2. Configure the consent screen

**APIs & Services → OAuth consent screen**

| Field | Value |
|---|---|
| User type | **External** (unless you have Workspace and only want your own org) |
| App name | Minuto |
| Support email | your own |
| Scopes | leave the defaults — `email`, `profile`, `openid` are added automatically |
| Test users | add your own Google address |

Leave it in **Testing**. An app in testing works for the test users you list, with no review. Publishing is only needed when strangers sign in, and that is a Phase 3 decision.

### 3. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**

| Field | Value |
|---|---|
| Application type | **Web application** |
| Name | Minuto local |
| Authorised JavaScript origins | `http://localhost:3000` |
| Authorised redirect URIs | `http://localhost:3000/api/auth/callback/google` |

That redirect URI must match **exactly** — no trailing slash. A mismatch is the single most common failure, and Google's error names it directly (`redirect_uri_mismatch`).

### 4. Put the values in the env file

Add two lines to `web/.env.local` — the file is gitignored, so the secret stays local:

```
GOOGLE_CLIENT_ID=<the client id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<the client secret>
```

### 5. Restart

```powershell
npm run db:start
```

```powershell
npm run web
```

**Continue with Google** appears on `/sign-in`. No code change is needed — the button is driven by whether those two variables exist.

## When you deploy

Add the production origin and redirect URI to the same OAuth client:

```
https://your-domain/api/auth/callback/google
```

and set `BETTER_AUTH_URL` to the production domain. Better Auth infers the base URL from the request on preview deployments, so leave it unset there.

## Adding Calendar later

Minuto is meant to read a meeting's title and attendees from Google Calendar (docs/ARCHITECTURE.md §2). That is one scope away:

```ts
google: {
  clientId: googleId!,
  clientSecret: googleSecret!,
  scope: ['https://www.googleapis.com/auth/calendar.readonly'],
}
```

Better Auth stores the provider's access token on the `account` row, so the Calendar call can use it directly. Two things to know before doing it:

- A calendar scope is **sensitive**, so publishing the app then requires Google's verification review — which is exactly why the architecture keeps Calendar optional, and why the app reads titles and attendees from the Meet page when there is no Calendar access.
- Existing users have to sign in again to grant the new scope; it is not applied retroactively.

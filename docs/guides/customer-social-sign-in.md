# Customer sign-in with Google and Apple

Each store turns these on from **admin → Settings → Customer sign-in**. Nothing on the server changes. The storefront
shows a button within a minute of saving and hides it again when the field is cleared.

## Google

1. In Google Cloud, create or pick a project named after the store; Google shows its name on the sign-in screen.
2. **Google Auth Platform → Branding:** app name, support email, the storefront's home, privacy and terms URLs, and
   the storefront domain under *Authorized domains*. Skip the logo unless you want Google's review.
3. **Audience:** External, then **Publish app**. Without publishing, only listed test users can sign in.
4. **Clients → Create client → Web application:** add `https://<your storefront domain>` under
   *Authorized JavaScript origins*. No redirect URI is needed.
5. Paste the **client ID** (`…apps.googleusercontent.com`) into admin. The client secret is not used.

## Apple

Requires a paid Apple Developer membership (Account Holder or Admin).

1. **Certificates, Identifiers & Profiles → Identifiers → App IDs:** an App ID with *Sign in with Apple* enabled.
2. **Identifiers → Services IDs:** create one (for example `com.yourstore.web`), enable *Sign in with Apple*, and
   configure it with the App ID above, your storefront domain, and the return URL `https://<domain>/sign-in` (no trailing slash; it must match exactly).
3. **Sign in with Apple for Email Communication:** register your sending domain or address, so receipts reach
   customers who hide their email.
4. Paste the **Services ID** into admin.

The IDs are public. The API checks every sign-in against the IDs saved for that store.

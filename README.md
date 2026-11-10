# Site Request

A small Chrome extension to request access to a blocked site by email, in one click.

When you land on a block page, open the extension and click **Request this site**. It reads the blocked address (and the reason shown on the block page), writes the request email, and sends it from the Gmail account you are already signed in to in Chrome. You can also request the site of any open tab, or type an address by hand.

## Install

1. Download `site-request.zip` from the [latest release](https://github.com/YankyAppel/site-request/releases/latest) and unzip it. You get a folder called `site-request`. Keep it somewhere permanent (for example Documents), not in Downloads.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `site-request` folder.
4. The Settings page opens. Fill in what you need and click **Save**. Pin the extension (puzzle icon, then the pin) so it is one click away.

Be signed in to Gmail in the same Chrome profile. Each request is sent from that Gmail account.

## Updates

The extension checks this repository's releases when Chrome starts and every 6 hours. When a newer version is out:

1. The icon shows **NEW**. Open it and click **Update** in the bar at the top. The new zip downloads.
2. Unzip it and copy everything from its `site-request` folder into your `site-request` folder, replacing the files.
3. Click **Reload after update**. Your settings and request history stay.

Chrome does not let an extension loaded from a folder replace its own files, so step 2 is done by hand. You can also check right away with **Check for updates** in Settings.

## Settings

All optional and stored only in your browser:

- **Send requests to**: the email address that handles your site requests.
- **Account details**: name, phone number, account PIN and notes. Filled-in details are added at the bottom of every request; empty ones are left out.
- **Gmail account**: only if you are signed in to more than one Google account (0 = first, 1 = second, or the address itself).
- **Subject and message**: your own wording. Placeholders: `{url}` full address, `{domain}` site name, `{date}` date and time, `{reason}` the reason from the block page (a line with `{reason}` is left out when there is none).

The extension only acts on Gmail tabs it opened itself for a request.

## License

MIT

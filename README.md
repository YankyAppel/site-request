# Site Request

A small Chrome extension to request access to a blocked site by email, in one click.

When you land on a block page, open the extension and click **Request this site** (or use the **Request this site** box on the block page itself). It reads the blocked address (and the reason shown on the block page), writes the request email, and sends it from the Gmail account you are already signed in to in Chrome. You can also request the site of any open tab, type an address by hand, or right-click any link or page.

## Install

1. Download `site-request.zip` from the [latest release](https://github.com/YankyAppel/site-request/releases/latest) and unzip it. You get a folder called `site-request`. Keep it somewhere permanent (for example Documents), not in Downloads.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `site-request` folder.
4. The Settings page opens. Enter the email address that handles your site requests in **Send requests to**, fill in anything else you need, and click **Save**. Pin the extension (puzzle icon, then the pin) so it is one click away.

No address is built in. Until you add one, nothing is sent: the popup shows a **Send requests to (email)** field with a **Save** button, and a right-click request shows a notification asking you to set the address in the popup first.

Be signed in to Gmail in the same Chrome profile. Each request is sent from that Gmail account.

## Updates

The extension checks this repository's releases when Chrome starts, when it is installed or reloaded, every 2 hours, and when you open it (at most once every 2 minutes). It reads the version from where `github.com/YankyAppel/site-request/releases/latest` leads, and uses the GitHub API only if that does not work. When a newer version is out:

1. The icon shows **NEW**. Open it and click **Update** in the bar at the top. The new zip downloads.
2. Unzip it and copy everything from its `site-request` folder into your `site-request` folder, replacing the files.
3. Click **Reload after update**. Your settings and request history stay.

Chrome does not let an extension loaded from a folder replace its own files, so step 2 is done by hand. You can also check right away with **Check for updates** in Settings. If the checks cannot reach GitHub, Settings says so ("Couldn't check for updates") instead of staying quiet.

## Whole site or just this page

Before you send, the popup asks **Whole site** (the default) or **Just this page**:

- **Whole site** asks for the whole domain as a wildcard, for example `*.example.com`, with the page you were on as an example.
- **Just this page** asks for that exact address only, and the email says so.

## Reasons

Say why you need a site, in one tap. Under the address, the popup shows your reasons as buttons, plus **None**. Tap one (only one at a time). There is also a box, **Add details (optional)**, for your own explanation, up to 500 characters. Use a reason, details, both, or neither.

In the email, the reason's text appears as a **Reason:** line and your details as a **Details:** paragraph. Both are left out when empty. The same choice works for **Request all**, and a reminder repeats the reason of the original request. Recent requests show the reason under each site.

Make your own reasons in Settings under **Reasons**: add, edit, delete and move them up or down. Each one has a short button name and the text that goes in the email. Four starters come with the extension (For work, For a shiur / learning, For school, For shopping / a purchase). Change or delete them as you like. A reason you change later does not change requests you already sent.

## Request box on the block page

On some block pages there is no button to request the site (for example a **Locked Web Category** page, where only **Report miscategorization** is offered). On those pages the extension adds a **Request this site** box right on the page, under the block details and above **Report miscategorization**. You don't need to open the extension.

The box has everything the popup has: the blocked address, **Whole site** / **Just this page**, your reason buttons, **Add details (optional)** (up to 500 characters) and **Send request**. It sends the same way as the popup: the same Gmail email, your saved address, your request history, the approval check and the reminder. If no address is saved yet, the box asks for it first (**Save**). After sending it shows **Request sent** with the time, and the request's status (**Waiting for approval**, or **Approved** once the check sees the site open).

When the block page has its own request button, the box stays hidden, so you use the page's own button. The extension looks for a visible button, link or form that asks to request, unblock or allow the site (not **Report miscategorization**, which is on every block page). It looks again for a few seconds after the page loads, in case the page's button appears late. A **Locked** page is read as having no request option of its own, unless it clearly shows a request button.

Settings:

- **Show Request button on block pages** (on by default).
- **Only when the page has no request option of its own** (on by default). Turn it off to show the box on every block page.

## Already requested

When you already requested a site, the extension makes it clear, so you don't send the same request twice by mistake.

- **On the block page**, the box opens with a coloured bar at the top: a check mark, **Already requested** and the date and time. Under it: **Waiting for approval** (amber) or **Approved** (green, with a **Reload page** button that opens the site), the reason you used, and whether you asked for the **whole site** or **this page**. If you requested it more than once: **Requested 3 times · last Nov 10, 3:08 PM**.
- The form is folded away. The button reads **Send another request**; click it to open the form again, then **Send again**. If your earlier request was for one page only, the box says **Earlier request was for this page only** and picks **Whole site** for you.
- **In the popup**, the same banner (**Already requested**, the date, the status) sits above the form, and the button reads **Send another request**.
- **On the toolbar icon**, a tab whose site you requested and is still waiting shows a small blue **✓**, so you can see it without opening anything. The red **NEW** (an update) and the amber count (blocked parts on the page) come first; the ✓ shows when neither is there. It goes away once the request is approved.
- **Right-click** still sends right away; the notification says **Sent again (2nd request)**.

A request counts for a page when it asked for that exact page, or for the whole site the page is on. A request for one page does not count for other pages of the same site.

## Right-click

Right-click a link, or anywhere on a page, and choose **Request this site** (the whole domain) or **Request just this page** (the exact address). Right-clicking a link to a block page requests the blocked site. These send right away with your **Default reason** (Settings; None unless you pick one). A notification tells you when the email was sent.

To pick a reason first, choose **Request with reason…**. The popup opens with the site filled in. If Chrome does not open the popup there, the same page opens in a small window, which closes after sending.

## Hidden blocks

Sometimes a site opens but looks broken: its pictures, videos, styles or scripts come from other addresses that are blocked. The extension notices these while the page loads (a part that is sent to the block page, a part whose connection is cut or whose secure connection fails, or a block page sent in place of a part) and shows the count on its icon in amber.

Open the popup to see **This page has N blocked parts**, with each address and a checkbox. Several addresses under one name are grouped as a wildcard (for example `*.cdn.example.com`). Common ad and tracker addresses are listed but left unticked. **Request all** sends one email with every ticked address.

While an update is waiting, the icon shows the red **NEW** instead; the popup still shows both. Icon order: red **NEW**, then the amber count, then the blue **✓** for an already requested site.

## Reminder

If a request is still not open 2 days after you sent it, Chrome shows **Still waiting on example.com — send a reminder?** Click it to send a short follow-up email (subject "Reminder: " plus the original subject) through Gmail. Each request is reminded once at most. Turn it off in Settings with **Offer a reminder after 2 days** (on by default).

## Was my request approved?

Every 30 minutes, once a minute after Chrome starts, and when you open the popup (at most once every 2 minutes), the extension opens each site you requested in the last 30 days in the background (without your cookies or logins). When the site itself answers instead of the block page, it checks once more a couple of minutes later. If it is still open, the request is marked **Approved** and Chrome shows a notification: **Site approved: example.com**. Click the notification to open the site.

- The popup's recent requests show a green **Approved** tag, or **Blocked** while it is still blocked, and **Checking…** while a check runs. Click an approved one to open it.
- **Check now** in the popup checks right away.
- A site that does not answer at all (offline, timeout) is not counted either way; it is tried again next time.
- Approved requests are not checked again.
- Turn it off in Settings with **Check if my requests were approved** (on by default).

To open sites in the background and to notice blocked parts of pages, the extension needs permission to read the sites you visit, so Chrome may ask you to approve the new permissions after an update. Nothing is sent anywhere: each check is a plain page load from your own browser, and the result stays in your browser.

## Settings

All optional and stored only in your browser:

- **Send requests to**: the email address that handles your site requests. Empty until you add it; nothing is sent without it.
- **Account details**: name, phone number, account PIN and notes. Filled-in details are added at the bottom of every request; empty ones are left out.
- **Gmail account**: only if you are signed in to more than one Google account (0 = first, 1 = second, or the address itself).
- **Check if my requests were approved**: the background check above.
- **Offer a reminder after 2 days**: the reminder above.
- **Show Request button on block pages** and **Only when the page has no request option of its own**: the box on the block page above.
- **Reasons**: your reason buttons, and the **Default reason** used by the right-click menu and picked first in the popup.
- **Subject and message**: your own wording. Placeholders: `{url}` full address, `{domain}` site name, `{target}` what is asked for (`*.example.com` for the whole site, or the exact page), `{ask}` the matching request sentence, `{page}` the page you were on (whole-site requests only), `{date}` date and time, `{reason}` the reason shown on the block page, `{why}` the reason you pick and your details. A line with `{reason}`, `{page}` or `{why}` is left out when it has no value. A message of your own without `{why}` gets your reason added at the end.

The reason shown on the block page (for example its category) appears in the default message as **Blocked as:**, so it does not mix with your own **Reason:** line.

The extension only acts on Gmail tabs it opened itself for a request.

## License

MIT

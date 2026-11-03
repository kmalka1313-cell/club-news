# club-news

Collects the latest news about your favorite clubs across different sports (Google News RSS, no API keys, Node.js only, no dependencies).

## Use
    node club-news.js                      # new items since last run -> digests/YYYY-MM-DD.md
    node club-news.js --all --days 7       # everything from the past week
    node club-news.js --add "Arsenal" --sport Football
    node club-news.js --list

## Web UI
    node server.js                         # then open http://localhost:3000

Browse news by sport, change the time window, and add/remove clubs from the browser (shares `clubs.json` with the CLI; doesn't touch `seen.json`).

- **Access control:** the first visit asks you to create the admin account. Admins add/remove clubs and users; members can read news and chat. Passwords are scrypt-hashed in `users.json`; logins last 7 days (`sessions.json`).
- **Chat:** click a headline, then use the chat in the side panel. Anyone logged in can post; you can delete your own messages (admins any). Stored in `chats.json`.
- Forgot the admin password? Delete `users.json` and `sessions.json` and set up again.

Edit `clubs.json` to change clubs (`query` is the search text). `seen.json` tracks already-shown links so each run only shows new items.
Schedule daily with Windows Task Scheduler: `node C:\Users\kmalk\club-news\club-news.js`.

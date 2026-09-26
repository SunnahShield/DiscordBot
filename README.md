# Sunnah Shield Points Discord Bot

Discord slash-command bot for **Sunnah Shield Points | نقاط درع السنة**.

## Commands

- `/add <user> <points>`: Admins only. Adds points to a user.
- `/remove <user> <points>`: Admins only. Removes points from a user.
- `/leaderboard`: Anyone. Shows the top point holders.
- `/trade <user> <points>`: Anyone. Moves points from the command user to the selected user.
- `/grill`, `/sgrill`, `/jail`, `/naughty`: Moderation punishment commands.
- `/ungrill`, `/unsgrill`, `/unjail`, `/unnaughty`: Undo commands that restore saved roles.
- `/deepfry`, `/undeepfry`: Ban and unban commands.
- `/marinate`, `/unmarinate`: Timeout and remove timeout.
- `/purge <count> [user]`: Delete recent messages in the current channel.
- `/allpurge <user> <count>`: Delete a user's recent messages across channels.
- `/lockdown [reason]`: Admin-only command that hides channels from non-admin members.
- `/archive <archive>`: Admin-only. Run in a text channel with an archive number (for example, `1`); the bot creates or uses `Archive 1`, renames the channel to start with `arch1-`, moves it there, and removes channel visibility.
- `/announce <message> <format> [channel] [title] [link] [link_text] [attachment] [image] [thumbnail] [footer]`: Admin-only official posting command. Choose a normal message or a branded embed (accent `#dd6b14`), add a destination, links, one upload, images, and a footer. Message text accepts Discord Markdown, Unicode emojis, and server custom emojis.
- `/welcome-setup <channel> <message> [title] [footer] [image] [thumbnail]`: Admin-only. Saves a branded `#dd6b14` welcome embed sent whenever a member joins.
- `/booster-setup <channel> <message> [title] [footer] [image] [thumbnail]`: Admin-only. Saves a matching embed sent when a member begins boosting. Templates can use `{user}`, `{username}`, `{server}`, and `{memberCount}`. `{user}` creates a real mention above the embed only. If no thumbnail URL is set, the member's profile picture is used.
- `/welcome-test` and `/booster-test`: Admin-only. Send the respective configured embed using the command user's profile, so it can be reviewed without a real join or boost.
- `/autoreact setup <emoji> <channel> <filter>`: Admin-only. Reacts automatically to messages in one selected channel. Filters are all messages, any attachment, images only, or videos only. `/autoreact disable` turns it off.
- `/honeypot setup <channel> <log_channel> <duration> <unit>`: Admin-only. Anyone who posts in the honeypot channel is timed out, their messages from the last 24 hours are deleted where the bot has access, and the result is reported to the selected log channel. `/honeypot disable` turns it off.
- `/help`: Show command usage.

Arabic aliases are registered as separate slash commands. Use underscores where Discord does not allow spaces, for example `/شوي_اوي`.

## Bot Setup Notes

- Enable the `Server Members Intent` and `Message Content Intent` for the bot in the Discord Developer Portal. The latter is required for attachment/image/video auto-reactions and honeypot message handling.
- The bot needs channel permissions to View Channel, Read Message History, Manage Messages, Add Reactions, and Moderate Members. Its role must be above members the honeypot should timeout.
- Keep `DISCORD_TOKEN`, `CLIENT_ID`, and `GUILD_ID` in your host environment variables.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in:

   ```bash
   DISCORD_TOKEN=...
   CLIENT_ID=...
   GUILD_ID=...
   ```

3. Register slash commands:

   ```bash
   npm run deploy
   ```

4. Start the bot:

   ```bash
   npm start
   ```

Point data is stored in `data/points.json`.

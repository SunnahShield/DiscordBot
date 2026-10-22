# Sunnah Shield Points Discord Bot

Discord slash-command bot for **Sunnah Shield Points | نقاط درع السنة**.

## Commands

- `/add <user> <points>`: Admins only. Adds points to a user.
- `/remove <user> <points>`: Admins only. Removes points from a user.
- `/leaderboard`: Anyone. Shows the top point holders.
- `/trade <user> <points>`: Anyone. Moves points from the command user to the selected user.
- `/grill`, `/sgrill`, `/jail`, `/naughty`: Moderation punishment commands.
- `/punishments setup <type> [role] [announce_channel] [remove_role_1…4]`: Admin-only, server-specific setup for every punishment. Grill, Super Grill, Jail, and Naughty require a role; Deepfry and Timeout/Marinate only need an optional announcement channel. The optional removed roles are restored on undo. Run `/punishments list` to review the active configuration.
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
- `/autoreact setup <emoji> <channel> <filter>`: Admin-only. Reacts automatically in each configured channel (run setup again to add another, or replace a channel's rule). Setup verifies the bot has View Channel, Read Message History, and Add Reactions in that channel. Filters are all messages, any attachment, images only, or videos only. `/autoreact disable` turns every rule off.
- `/honeypot setup <channel> <log_channel> <duration> <unit>`: Admin-only. Anyone who posts in the honeypot channel is timed out, their messages from the last 24 hours are deleted where the bot has access, and the result is reported to the selected log channel. `/honeypot disable` turns it off.
- `/invites setup <channel>`: Admin-only. The invite tracker reports joins, leaves, kicks, bans, unbans, and invite creation/deletion. It establishes and persists a baseline for existing personal/regular invites, compares each later use count, retries for Discord's short propagation delay, and retains an inviter record for the leave report. It also handles vanity URLs and one-use invites. Use `/invites status` to check readiness and `/invites test` to preview the report formats. Discord does not expose an exact source for Discovery, Server Tag, or Join Server, so those are honestly shown as a non-invite/platform source rather than guessed.
- `/logs setup <channel>`: Admin-only. Sets the **master logs** channel. It receives embeds for every Discord event the bot can receive except ordinary message sends, including message edits/deletions/purges, reactions, joins/leaves/kicks/bans/timeouts, role and nickname changes, channels/categories/threads, permission overwrites, server settings, invite lifecycle, voice activity, AutoMod, scheduled events, emojis/stickers, integrations, webhooks, audit-only actions, and bot command use. `/logs status`, `/logs test`, and `/logs disable` manage it.
- `/genderlogs setup <male|female> <channel>`: Admin-only. Sets the destination channel for **male logs** or **female logs**. `/male add <channel>` and `/female add <channel>` choose the source channels (a category also covers its child channels and threads). The gender logs record messages, edits, deletes, bulk deletes, voice events, threads, and successful moderation actions performed in their configured areas. Use `/male list`, `/female list`, `/genderlogs status`, `/genderlogs test`, and `/genderlogs disable` to manage them.
- `/roletag add <tag> <action> [role]`: Admin-only. Matches text in a member's username or server/global display name on joining or changing their name. The action can give a role, kick, or ban. The role is required only for the give-role action. Use `/roletag check <user>` to confirm rules match without taking action, plus `/roletag list` and `/roletag remove <tag>` to manage rules.
- `/help`: Show command usage.

Arabic aliases are registered as separate slash commands. Use underscores where Discord does not allow spaces, for example `/شوي_اوي`.

## Bot Setup Notes

- Enable the `Server Members Intent` and `Message Content Intent` for the bot in the Discord Developer Portal. The latter is required for attachment/image/video auto-reactions, honeypot handling, and the contents of message edit/delete logs. Invite tracking also uses the Guild Invites gateway intent configured in the bot code.
- The bot needs channel permissions to View Channel, Read Message History, Manage Messages, Add Reactions, and Moderate Members. Its role must be above members the honeypot or role-tag rules should act on. Every log destination needs View Channel, Send Messages, and Embed Links. Give the bot **View Audit Log** so master and invite logs can identify moderators and reasons, plus **Manage Server** so invite tracking can read personal-invite and vanity use counts.
- Log mentions are posted above each embed and have notifications disabled, so moderators can click a member, role, or channel without pinging it. Master logs intentionally include message content: keep that channel private and expect high traffic in an active server. Discord does not provide a guaranteed historical event replay after the bot is offline or disconnected; the logger serializes sends, retries transient failures, caches message data, and reports unknown invite sources rather than producing false attribution.
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

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

## Bot Setup Notes

- Enable the `Server Members Intent` for the bot in the Discord Developer Portal so the join guard can reapply punishments.
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

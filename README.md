# Discord Staff / Mass / Moderation Bot

## What it does
- Bootstrap staff role
- Main staff role
- Register / unregister users
- Mass hosting with approval flow
- Moderator shifts
- Moderation logs with proof attachment
- Clergy and moderation leaderboards
- Two-week pay summary

## Requirements
- Node.js 20+
- A Discord bot application
- A 24/7 host (best: a VPS running Ubuntu)
- A staff role set up in your server

## Files
- `index.js` — main bot
- `commands.js` — slash command definitions
- `deploy-commands.js` — command registration
- `package.json` — dependencies
- `.env.example` — environment template

## Setup
1. Create a Discord application in the Developer Portal.
2. Add a bot user.
3. Copy the bot token.
4. Enable **Server Members Intent**.
5. Put the bot on your server with permissions:
   - View Channels
   - Send Messages
   - Embed Links
   - Read Message History
   - Attach Files
   - Manage Roles
6. Put the bot role **above** the staff role in the role list.
7. Fill in `.env`:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID` for testing
8. Install dependencies:
   - `npm install`
9. Register commands:
   - `npm run deploy`
10. Start the bot:
   - `npm start`

## Important notes
- For true 24/7 uptime, use a VPS or other always-on Linux server.
- Mass times are entered in your server timezone, then displayed to each viewer in their own Discord timezone.
- Proof is handled by slash-command attachment uploads, so users can paste images directly into the upload field.
- Approval buttons are restricted to staff.

## Useful commands
- `/setup bootstrap_staff_role`
- `/setup staff_role`
- `/setup timezone`
- `/setup mass_approval_channel`
- `/setup moderation_activity_channel`
- `/setup moderation_approval_channel`
- `/staff add`
- `/register add`
- `/mass start`
- `/mass proof`
- `/shift start`
- `/shift end`
- `/modlog create`
- `/leaderboard`
- `/payroll summary`

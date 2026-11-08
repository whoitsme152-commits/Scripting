# Roblox Scripting Assistant — 15 Month Program (Hosting Ready)

A Discord bot that teaches Roblox Luau from beginner level through a capstone Roblox RPG prototype.

## Included
- 450 ordered daily lessons (15 months × 30 lessons).
- Daily lesson announcement at **6:00 PM America/Detroit** by default.
- **Start Training** button on each lesson embed.
- Clicking the button creates a **private, temporary voice channel** just for that member.
- The member receives a direct join link to the new voice channel.
- Two-hour active training timer starts when they join that private voice channel.
- Attendance requires both the private training voice channel and text-channel check-ins.
- Timer pauses when the learner leaves their private voice channel.
- Timer also pauses when the periodic text check-in is overdue.
- The temporary voice channel is deleted when the session ends, is skipped, or the quiz is passed.
- Quiz appears when the two hours of active attendance finish. A correct answer records the day and advances the curriculum.
- `/skip` records a skipped day without advancing the lesson. The same lesson is offered the next day.
- SQLite persistence for users, sessions, quiz attempts, daily status, and server configuration.
- Optional OpenAI-powered tutor through `/ask`. Built-in curriculum and commands work without an API key.
- Slash commands and Discord embeds.
- **Hosting ready**: Dockerfile, Procfile, and `.gitignore` included.

## Daily embed channel
Lesson embeds (with the **Start Training** button) are posted to channel ID **`1569107036854161532`**.  
Text check-ins still use the channel configured with `/setup`.

## Important Discord limitation
Discord bots cannot see whether a user's text chat window is open, minimized, or in the foreground. This bot does **not** claim to detect that. It uses voice-channel presence plus explicit text check-ins as an attendance approximation. The learner must remain in their private voice channel and check in on time for the timer to keep running.

## Requirements
- Node.js 20.11+ (or use the included Docker image based on Node 22)
- A Discord application and bot token
- A server where you can invite the bot
- Bot needs: **Manage Channels**, View Channels, Send Messages, Embed Links, Use Application Commands, Connect, Move Members (recommended)
- Optional OpenAI API key for AI tutoring

## Local install
1. Extract the project.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Fill in `DISCORD_TOKEN`, `CLIENT_ID`, and optionally `GUILD_ID`.
5. Enable **Server Members Intent** in the Discord Developer Portal if available.
6. Run `npm run deploy` to register slash commands.
7. Run `npm start`.

For initial testing, set `GUILD_ID` to your server ID. Guild commands usually appear faster. Remove it later to register global commands.

## First-time Discord setup
1. Invite the bot with the `bot` and `applications.commands` scopes.
2. Give it permission to manage channels (so it can create/delete temporary voice channels), view/send messages, and connect to voice.
3. Run `/setup` as a server administrator:
   - `text_channel`: your training text channel (for check-ins)
   - `voice_channel`: optional — used only as a category parent for the temporary VCs
   - `hour`: `18`
   - `minute`: `0`
   - `timezone`: `America/Detroit`
   - `admin_role`: optional role allowed to use `/announce`
4. Learners run `/enroll`.
5. When the daily lesson embed appears (or after `/lesson`), the learner clicks **Start Training**.
6. A private voice channel is created; the learner is given a join link.
7. Joining that voice channel starts the two-hour timer. They must use `/checkin` at least every 15 minutes.

## Commands
| Command | Purpose |
|---|---|
| `/setup` | Configure text channel, optional category voice, timezone, and daily schedule (administrator only) |
| `/enroll` | Join the program |
| `/lesson` | View current lesson (includes Start Training button) |
| `/start` | Start or resume a two-hour session (creates private voice channel) |
| `/pause` | Pause the timer |
| `/resume` | Resume a paused timer |
| `/checkin` | Confirm attendance in text channel |
| `/skip` | Skip today without advancing the curriculum (also deletes temp VC) |
| `/progress` | View lesson, time, streak, and quiz progress |
| `/quiz` | Reopen the quiz after the timer ends |
| `/ask question:` | Ask the built-in/AI tutor |
| `/help` | Show commands and attendance rules |
| `/announce` | Post lesson announcements (configured admin only) |

## How Start Training works
1. Daily lesson embed is posted in the announce channel with a **Start Training** button.
2. Learner clicks the button → bot creates a private voice channel only they (and the bot) can see/join.
3. Bot replies with a direct link: `https://discord.com/channels/<guild>/<channel>`.
4. When the learner joins that channel the timer starts (or resumes).
5. Leaving the channel pauses the timer.
6. When the session finishes (timer reaches zero), is skipped, or the quiz is passed, the temporary voice channel is deleted.

## Hosting

### Docker
```bash
docker build -t roblox-scripting-assistant .
docker run -d --name rsa \
  -e DISCORD_TOKEN=... \
  -e CLIENT_ID=... \
  -e GUILD_ID=... \
  -v rsa-data:/app/data \
  roblox-scripting-assistant
```
The SQLite database is stored at `/app/data/roblox_tutor.sqlite` inside the container. Mount a volume so progress survives restarts.

### Railway / Render / Heroku-style
- Set the same environment variables as `.env`.
- The included `Procfile` runs `npm start`.
- Persist the `data/` directory (or set `DATABASE_PATH` to a durable volume) so progress is not lost.

### Environment variables for production
| Variable | Required | Notes |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Bot token |
| `CLIENT_ID` | Yes | Application client ID |
| `GUILD_ID` | Recommended for testing | Faster slash-command updates |
| `OPENAI_API_KEY` | No | Enables `/ask` AI tutor |
| `DATABASE_PATH` | No | Defaults to `./data/roblox_tutor.sqlite` (Docker sets `/app/data/...`) |
| `TIMEZONE` / `LESSON_HOUR` / `LESSON_MINUTE` | No | Defaults match Detroit 6 PM |

Register slash commands once after deploy: either run `npm run deploy` locally with the same env vars, or temporarily set a one-off job that runs `node src/deploy-commands.js`.

## Daily lesson and missed days
The schedule announces the learner's current lesson at the configured local time. A skipped day does not consume a lesson or advance the curriculum. If a learner misses a day, the same lesson remains their next lesson; the curriculum does not jump ahead or erase progress.

## Quiz behavior
- A quiz is sent after 120 minutes of active attendance.
- The learner selects one of four answers.
- Correct answer completes the day and advances to the next lesson.
- Incorrect answer shows the concept reminder and allows another attempt.
- Quiz attempts and completion state are saved in SQLite.

## Database
The database is stored at `./data/roblox_tutor.sqlite` by default (or `/app/data/...` in Docker). Back up this file regularly. Do not delete it while the bot is running.

## Security and deployment notes
- Keep `.env` private. Never upload your bot token or OpenAI key to GitHub.
- Use a process manager (systemd, PM2, Docker) for 24/7 uptime.
- Back up the SQLite file / volume.
- For a larger public bot, consider moving to PostgreSQL and adding per-guild rate limits and structured logging.
- The AI tutor is optional and is not required for lesson delivery.

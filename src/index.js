require("dotenv").config();
const {
  Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  PermissionFlagsBits
} = require("discord.js");
const cron = require("node-cron");
const OpenAI = require("openai");
const { stmts, ensureUser, saveUser } = require("./db");
const { getLesson, TOTAL_DAYS } = require("./curriculum");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TZ = process.env.TIMEZONE || "America/Detroit";
const SESSION_SECONDS = Math.max(1, Number(process.env.SESSION_MINUTES || 120)) * 60;
const CHECKIN_SECONDS = Math.max(1, Number(process.env.CHECKIN_MINUTES || 15)) * 60;
const ai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Hardcoded announcement channel for daily lesson embeds + Start Training button
const ANNOUNCE_CHANNEL_ID = "1569107036854161532";

if (!TOKEN || !CLIENT_ID) {
  console.error("Missing DISCORD_TOKEN or CLIENT_ID. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

const commands = [
  new SlashCommandBuilder().setName("setup").setDescription("Configure training channels and schedule")
    .addChannelOption(o=>o.setName("text_channel").setDescription("Training text channel (check-ins)").addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addChannelOption(o=>o.setName("voice_channel").setDescription("Optional fallback / parent category voice channel").addChannelTypes(ChannelType.GuildVoice).setRequired(false))
    .addRoleOption(o=>o.setName("admin_role").setDescription("Optional role allowed to manage the program"))
    .addIntegerOption(o=>o.setName("hour").setDescription("Daily lesson hour, 24-hour clock").setMinValue(0).setMaxValue(23))
    .addIntegerOption(o=>o.setName("minute").setDescription("Daily lesson minute").setMinValue(0).setMaxValue(59))
    .addStringOption(o=>o.setName("timezone").setDescription("IANA timezone, e.g. America/Detroit")),
  new SlashCommandBuilder().setName("enroll").setDescription("Join the 15-month Luau program"),
  new SlashCommandBuilder().setName("lesson").setDescription("Show today's current lesson"),
  new SlashCommandBuilder().setName("start").setDescription("Start or resume your 2-hour training session (creates a private voice channel)"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause your training timer"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume a saved training timer"),
  new SlashCommandBuilder().setName("checkin").setDescription("Confirm you are active in the training text channel"),
  new SlashCommandBuilder().setName("skip").setDescription("Skip today's lesson without losing your place"),
  new SlashCommandBuilder().setName("progress").setDescription("View your program progress"),
  new SlashCommandBuilder().setName("quiz").setDescription("Open the quiz for your finished lesson"),
  new SlashCommandBuilder().setName("ask").setDescription("Ask the built-in or AI Luau tutor")
    .addStringOption(o=>o.setName("question").setDescription("Your Luau or Roblox Studio question").setRequired(true).setMaxLength(1500)),
  new SlashCommandBuilder().setName("help").setDescription("Show bot commands and attendance rules"),
  new SlashCommandBuilder().setName("announce").setDescription("Post today's lesson (admin only)")
].map(c=>c.toJSON());

async function registerCommands() {
  const rest = new REST({ version:"10" }).setToken(TOKEN);
  if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID,GUILD_ID),{body:commands});
  else await rest.put(Routes.applicationCommands(CLIENT_ID),{body:commands});
  console.log("Slash commands registered.");
}

function config(guildId){ return stmts.getConfig.get(guildId); }
function isAdmin(member,cfg){
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return !!(cfg?.admin_role_id && member.roles.cache.has(cfg.admin_role_id));
}
function dayDateKey(timezone=TZ) {
  return new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
}
function timeUntilNextCheckin(session) {
  const last = Number(session.text_checkin_at || 0);
  return Math.max(0, CHECKIN_SECONDS - Math.floor(Date.now()/1000-last));
}
function elapsed(session) {
  if (session.status !== "running" || !session.last_started_at) return session.remaining_seconds;
  return Math.max(0, session.remaining_seconds - Math.floor(Date.now()/1000-session.last_started_at));
}
function sessionButtons(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`checkin:${userId}`).setLabel("I'm here").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`pause:${userId}`).setLabel("Pause").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`lesson:${userId}`).setLabel("View lesson").setStyle(ButtonStyle.Primary)
  );
}
function startTrainingButton(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`starttraining:${userId}`)
      .setLabel("Start Training")
      .setStyle(ButtonStyle.Success)
      .setEmoji("🎙️")
  );
}
function lessonEmbed(lesson) {
  return new EmbedBuilder().setColor(0x5865F2)
    .setTitle(`Day ${lesson.day}/450 · Month ${lesson.month}: ${lesson.monthName}`)
    .setDescription(`**${lesson.topic}**\n${lesson.goal}`)
    .addFields(
      {name:"Lesson",value:lesson.lesson.slice(0,1024)},
      {name:"Practice task",value:lesson.practice.slice(0,1024)},
      {name:"Review",value:lesson.review.slice(0,1024)},
      {name:"Session length",value:"2 hours of active attendance",inline:true},
      {name:"After the timer",value:"Complete the lesson quiz to record the day.",inline:true}
    ).setFooter({text:"Roblox Scripting Assistant · 15-month Luau program · Click Start Training to begin"});
}

/** Resolve the channel that receives daily lesson embeds (hardcoded priority). */
async function announceChannel(guildId) {
  try {
    const ch = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
    if (ch) return ch;
  } catch {}
  const cfg = config(guildId);
  if (cfg?.text_channel_id) {
    return client.channels.fetch(cfg.text_channel_id).catch(() => null);
  }
  return null;
}

/** Text check-in channel (from /setup). Falls back to announce channel. */
async function trainingTextChannel(guildId) {
  const cfg = config(guildId);
  if (cfg?.text_channel_id) {
    return client.channels.fetch(cfg.text_channel_id).catch(() => null);
  }
  return announceChannel(guildId);
}

/** Voice channel the member must be in for attendance. Prefers their private temp VC. */
function requiredVoiceChannelId(session, cfg) {
  return session?.temp_voice_channel_id || cfg?.voice_channel_id || null;
}

async function deleteTempVoice(session) {
  if (!session?.temp_voice_channel_id) return;
  try {
    const ch = await client.channels.fetch(session.temp_voice_channel_id).catch(() => null);
    if (ch) await ch.delete("Training session ended or abandoned").catch(() => {});
  } catch {}
  try {
    stmts.setTempVoice.run(null, session.id);
  } catch {}
}

/**
 * Create a private temporary voice channel for the learner.
 * Only that member + the bot can connect/view.
 * Returns the created channel or throws.
 */
async function createPrivateVoiceChannel(guild, member) {
  const name = `training-${member.user.username}`.slice(0, 90).replace(/[^a-zA-Z0-9-_ ]/g, "") || `training-${member.id}`;
  const overwrites = [
    {
      id: guild.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
    },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Stream,
        PermissionFlagsBits.UseVAD
      ]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.MoveMembers
      ]
    }
  ];

  // Prefer placing the temp VC under the same category as the configured voice channel
  let parent = null;
  const cfg = config(guild.id);
  if (cfg?.voice_channel_id) {
    try {
      const base = await guild.channels.fetch(cfg.voice_channel_id);
      if (base?.parentId) parent = base.parentId;
    } catch {}
  }

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: parent || undefined,
    permissionOverwrites: overwrites,
    reason: `Private training voice for ${member.user.tag}`
  });
  return channel;
}

async function postLesson(guildId, userId = null) {
  const channel = await announceChannel(guildId);
  if (!channel) {
    console.warn("No announce channel available for guild", guildId);
    return;
  }
  if (userId) {
    const u = ensureUser(guildId, userId);
    await channel.send({
      content: `<@${userId}> today's lesson is ready.`,
      embeds: [lessonEmbed(getLesson(u.current_day))],
      components: [startTrainingButton(userId)]
    });
  } else {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const members = await guild.members.fetch().catch(() => null);
    if (!members) return;
    const enrolled = members.filter(m => stmts.getUser.get(guildId, m.id));
    if (!enrolled.size) {
      await channel.send({
        embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle("Today's Luau training is ready")
          .setDescription("Run **/enroll** to join the 15-month Roblox scripting program. Then click **Start Training** on your lesson embed when you are ready.")]
      });
      return;
    }
    const cfg = config(guildId);
    for (const [id] of enrolled) {
      const u = ensureUser(guildId, id);
      const prior = stmts.active.get(guildId, id);
      if (prior && prior.status === "running") continue;
      const followup = prior && prior.status === "paused"
        ? `You missed or paused your previous training session. Your timer and lesson were saved; continue the same lesson when you're ready.\n`
        : "";
      if (u.current_day > TOTAL_DAYS) {
        await channel.send({
          content: `<@${id}>`,
          embeds: [new EmbedBuilder().setColor(0x57F287).setTitle("15-month program completed")
            .setDescription("You've completed all 450 lessons. Congratulations on finishing the Roblox scripting program!")]
        });
        continue;
      }
      await channel.send({
        content: `<@${id}>\n${followup}`,
        embeds: [lessonEmbed(getLesson(u.current_day))],
        components: [startTrainingButton(id)]
      });
    }
  }
}

function createQuizRow(userId, day) {
  const lesson = getLesson(day);
  return new ActionRowBuilder().addComponents(...lesson.quiz.choices.map((choice, i) =>
    new ButtonBuilder().setCustomId(`quiz:${userId}:${day}:${i}`).setLabel(`${i + 1}. ${choice}`).setStyle(ButtonStyle.Primary)
  ));
}

async function sendQuiz(guildId, userId, day) {
  const channel = await trainingTextChannel(guildId) || await announceChannel(guildId);
  if (!channel) return;
  const l = getLesson(day);
  await channel.send({
    content: `<@${userId}> **Two-hour session complete. Take your Day ${day} quiz:**\n${l.quiz.question}`,
    components: [createQuizRow(userId, day)]
  });
}

async function pauseSession(session, reason = "paused") {
  const remain = elapsed(session);
  stmts.updateSession.run(remain, "paused", null, Math.floor(Date.now() / 1000), session.id);
  return remain;
}

async function resumeSession(session) {
  stmts.updateSession.run(
    session.remaining_seconds,
    "running",
    Math.floor(Date.now() / 1000),
    session.text_checkin_at || Math.floor(Date.now() / 1000),
    session.id
  );
}

async function finishSession(session) {
  stmts.finishSession.run(session.id);
  await deleteTempVoice(session);
  const channel = await trainingTextChannel(session.guild_id) || await announceChannel(session.guild_id);
  if (channel) {
    await channel.send({
      content: `<@${session.user_id}> your two-hour session is complete. Your quiz is ready.`,
      embeds: [new EmbedBuilder().setColor(0x57F287).setTitle("Training timer complete")
        .setDescription("Complete the quiz below to mark this lesson finished. Your private voice channel has been removed.")]
    });
  }
  await sendQuiz(session.guild_id, session.user_id, session.day_number);
}

/**
 * Core start/resume logic.
 * When createTempVoice is true (button or /start), a private VC is created (or reused)
 * and the member is told how to join. Timer starts only after they are in that VC,
 * or starts immediately if they are already in it.
 */
async function startSession(guildId, userId, member, { createTempVoice = true } = {}) {
  const cfg = config(guildId);
  if (!cfg?.text_channel_id) {
    throw new Error("An administrator must run /setup first (at least the training text channel).");
  }

  const user = ensureUser(guildId, userId);
  if (user.current_day > TOTAL_DAYS) {
    throw new Error("You've completed all 450 lessons in the 15-month program.");
  }

  let s = stmts.active.get(guildId, userId);
  if (s && s.status === "running") {
    return { session: s, resumed: false, alreadyRunning: true };
  }

  if (!s || ["completed", "quiz", "skipped"].includes(s.status)) {
    const dateKey = dayDateKey(cfg.timezone);
    const already = stmts.db.prepare(
      "SELECT status FROM daily_status WHERE guild_id=? AND user_id=? AND date_key=?"
    ).get(guildId, userId, dateKey);
    if (already?.status === "skipped") {
      throw new Error("You skipped today's lesson. Your next lesson will be available tomorrow.");
    }
    stmts.createSession.run(guildId, userId, user.current_day, Math.floor(Date.now() / 1000), null);
    s = stmts.active.get(guildId, userId);
  }

  let tempChannel = null;
  if (createTempVoice) {
    // Reuse existing temp VC if it still exists
    if (s.temp_voice_channel_id) {
      tempChannel = await client.channels.fetch(s.temp_voice_channel_id).catch(() => null);
    }
    if (!tempChannel) {
      tempChannel = await createPrivateVoiceChannel(member.guild, member);
      stmts.setTempVoice.run(tempChannel.id, s.id);
      s = stmts.active.get(guildId, userId);
    }
  }

  const requiredVc = requiredVoiceChannelId(s, cfg);
  const inVoice = member.voice.channelId && requiredVc && member.voice.channelId === requiredVc;

  if (inVoice) {
    await resumeSession(s);
    s = stmts.active.get(guildId, userId);
    return { session: s, resumed: true, tempChannel, joined: true };
  }

  // Timer stays paused until they join the private VC
  return { session: s, resumed: false, tempChannel, joined: false };
}

async function askTutor(question) {
  if (!ai) return "AI tutoring is not configured yet. Ask an administrator to add OPENAI_API_KEY. You can still use /lesson and the built-in curriculum.";
  const response = await ai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "You are a patient Roblox Luau scripting tutor for a beginner-to-advanced 15-month course. Explain accurately, use Roblox Studio context, give safe server/client guidance, short code examples, and ask the learner to test the code. Never claim code was executed. Do not provide exploit or cheating scripts."
      },
      { role: "user", content: question }
    ],
    temperature: 0.4
  });
  return response.choices[0]?.message?.content || "I couldn't generate an answer. Try again.";
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();

  // Tick every 10 seconds
  setInterval(async () => {
    const running = stmts.db.prepare("SELECT * FROM sessions WHERE status='running'").all();
    for (const s of running) {
      const remain = elapsed(s);
      if (remain <= 0) {
        await finishSession(s).catch(console.error);
        continue;
      }
      const guild = client.guilds.cache.get(s.guild_id);
      const member = guild ? await guild.members.fetch(s.user_id).catch(() => null) : null;
      const cfg = config(s.guild_id);
      const requiredVc = requiredVoiceChannelId(s, cfg);

      if (!member || !requiredVc || member.voice.channelId !== requiredVc) {
        await pauseSession(s, "voice left").catch(console.error);
        const ch = await trainingTextChannel(s.guild_id);
        if (ch) {
          await ch.send({
            content: `<@${s.user_id}> your training timer is paused because you left the private training voice channel. Rejoin it and use **/resume** (or the Start Training button) to continue.`
          }).catch(() => {});
        }
      } else if (timeUntilNextCheckin(s) <= 0) {
        await pauseSession(s, "text check-in overdue").catch(console.error);
        const ch = await trainingTextChannel(s.guild_id);
        if (ch) {
          await ch.send({
            content: `<@${s.user_id}> your timer paused because your text check-in is overdue. Use **/checkin** or the I'm here button, then **/resume**.`
          }).catch(() => {});
        }
      } else {
        stmts.updateSession.run(remain, "running", Math.floor(Date.now() / 1000), s.text_checkin_at, s.id);
      }
    }

    // Clean up abandoned paused sessions whose temp VC is empty for a long time is optional;
    // we still keep the channel until finish/skip/explicit end so the learner can return.
  }, 10000);

  // Daily lesson announcement
  cron.schedule("* * * * *", async () => {
    for (const [guildId] of client.guilds.cache) {
      const cfg = config(guildId);
      if (!cfg) continue;
      const now = new Date();
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: cfg.timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).format(now).split(":").map(Number);
      if (parts[0] === cfg.lesson_hour && parts[1] === cfg.lesson_minute) {
        const dateKey = dayDateKey(cfg.timezone);
        const marker = `daily-post:${guildId}:${dateKey}`;
        if (!global.dailyPosted) global.dailyPosted = new Set();
        if (!global.dailyPosted.has(marker)) {
          global.dailyPosted.add(marker);
          await postLesson(guildId).catch(console.error);
        }
      }
    }
  }, { timezone: "UTC" });

  // Recover after restart
  const active = stmts.db.prepare("SELECT * FROM sessions WHERE status='running'").all();
  for (const s of active) {
    const guild = client.guilds.cache.get(s.guild_id);
    const member = guild ? await guild.members.fetch(s.user_id).catch(() => null) : null;
    const cfg = config(s.guild_id);
    const requiredVc = requiredVoiceChannelId(s, cfg);
    if (!member || !requiredVc || member.voice.channelId !== requiredVc || timeUntilNextCheckin(s) <= 0) {
      await pauseSession(s, "restart recovery");
    }
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  const guildId = newState.guild.id;
  const userId = newState.id;
  const cfg = config(guildId);
  if (!cfg) return;
  const s = stmts.active.get(guildId, userId);
  if (!s || !["running", "paused"].includes(s.status)) return;

  const requiredVc = requiredVoiceChannelId(s, cfg);
  if (!requiredVc) return;

  const was = oldState.channelId === requiredVc;
  const is = newState.channelId === requiredVc;

  if (was && !is && s.status === "running") {
    await pauseSession(s, "left voice channel");
    const ch = await trainingTextChannel(guildId);
    if (ch) {
      await ch.send({
        content: `<@${userId}> your training timer is paused. Rejoin your private training voice channel and use **/resume** to continue.`
      }).catch(() => {});
    }
  }

  // Auto-resume when they join their private VC (if check-in is still valid)
  if (!was && is && s.status === "paused") {
    if (timeUntilNextCheckin(s) > 0) {
      await resumeSession(s);
      const ch = await trainingTextChannel(guildId);
      if (ch) {
        await ch.send({
          content: `<@${userId}> you're back in your private training voice channel. Timer resumed. Keep checking in every ${CHECKIN_SECONDS / 60} minutes.`
        }).catch(() => {});
      }
    } else {
      const ch = await trainingTextChannel(guildId);
      if (ch) {
        await ch.send({
          content: `<@${userId}> you're back in the training voice channel. Use **/checkin**, then **/resume** to continue.`
        }).catch(() => {});
      }
    }
  }
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isButton()) {
      const parts = interaction.customId.split(":");
      const kind = parts[0];
      const userId = parts[1];

      if (userId !== interaction.user.id) {
        return interaction.reply({ content: "This control belongs to another learner.", ephemeral: true });
      }

      // Start Training button on the daily lesson embed
      if (kind === "starttraining") {
        await interaction.deferReply({ ephemeral: true });
        const member = interaction.member;
        const result = await startSession(interaction.guildId, userId, member, { createTempVoice: true });

        if (result.alreadyRunning) {
          return interaction.editReply({
            content: `You already have a running training session. Remaining: **${Math.ceil(elapsed(result.session) / 60)} minutes**.`
          });
        }

        const temp = result.tempChannel;
        const joinLink = temp ? `https://discord.com/channels/${interaction.guildId}/${temp.id}` : null;

        if (result.joined) {
          return interaction.editReply({
            content:
              `Training started. You have **${Math.ceil(elapsed(result.session) / 60)} minutes** remaining.\n` +
              (joinLink ? `Private voice channel: ${joinLink}\n` : "") +
              `Check in every ${CHECKIN_SECONDS / 60} minutes in the training text channel.`,
            components: [sessionButtons(userId)]
          });
        }

        // Not yet in the VC — instruct them to join; timer will start / resume when they do
        return interaction.editReply({
          content:
            `Your private training voice channel is ready.\n` +
            (joinLink ? `**Join here:** ${joinLink}\n\n` : "") +
            `Once you join that voice channel the two-hour timer will start automatically (and will keep running only while you stay in it and check in every ${CHECKIN_SECONDS / 60} minutes).\n` +
            `After joining you can also use **/resume** or the controls below.`,
          components: [sessionButtons(userId)]
        });
      }

      if (kind === "checkin") {
        const s = stmts.active.get(interaction.guildId, userId);
        if (!s) return interaction.reply({ content: "No active training session. Use /start or the Start Training button.", ephemeral: true });
        stmts.updateSession.run(s.remaining_seconds, s.status, s.last_started_at, Math.floor(Date.now() / 1000), s.id);
        return interaction.reply({ content: "Check-in recorded. Your text attendance is confirmed.", ephemeral: true });
      }

      if (kind === "pause") {
        const s = stmts.active.get(interaction.guildId, userId);
        if (!s || s.status !== "running") return interaction.reply({ content: "You do not have a running timer.", ephemeral: true });
        const r = await pauseSession(s);
        return interaction.reply({ content: `Timer paused with ${Math.ceil(r / 60)} minutes remaining.`, ephemeral: true });
      }

      if (kind === "lesson") {
        const u = ensureUser(interaction.guildId, userId);
        return interaction.reply({ embeds: [lessonEmbed(getLesson(u.current_day))], ephemeral: true });
      }

      if (kind === "quiz") {
        const day = Number(parts[2]);
        const selected = Number(parts[3]);
        const l = getLesson(day);
        const latest = stmts.db.prepare(
          "SELECT * FROM sessions WHERE guild_id=? AND user_id=? AND day_number=? ORDER BY id DESC LIMIT 1"
        ).get(interaction.guildId, userId, day);
        if (!latest || latest.status !== "quiz") {
          return interaction.reply({ content: "Finish the two-hour session before taking this quiz.", ephemeral: true });
        }
        const correct = selected === l.quiz.answer;
        stmts.addAttempt.run(interaction.guildId, userId, day, selected, correct ? 1 : 0);
        if (correct) {
          stmts.setQuizPassed.run(latest.id);
          await deleteTempVoice(latest);
          const u = ensureUser(interaction.guildId, userId);
          u.completed_days += 1;
          u.total_minutes += 120;
          u.current_day = Math.min(TOTAL_DAYS + 1, u.current_day + 1);
          u.streak += 1;
          u.last_lesson_date = dayDateKey(config(interaction.guildId)?.timezone || TZ);
          saveUser(u);
          stmts.markDaily.run(
            interaction.guildId,
            userId,
            day,
            dayDateKey(config(interaction.guildId)?.timezone || TZ),
            "completed"
          );
          return interaction.reply({
            content: `Correct. ${l.quiz.explanation}\n\nDay ${day} is complete. Your next lesson is Day ${u.current_day}.`,
            ephemeral: true
          });
        }
        return interaction.reply({
          content: `Not quite. ${l.quiz.explanation}\n\nReview the lesson and try again with **/quiz**.`,
          ephemeral: true
        });
      }
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, member, guildId, user } = interaction;

    if (commandName === "setup") {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: "Only a server administrator can configure the bot.", ephemeral: true });
      }
      const text = interaction.options.getChannel("text_channel");
      const voice = interaction.options.getChannel("voice_channel"); // optional now
      const role = interaction.options.getRole("admin_role");
      const hour = interaction.options.getInteger("hour") ?? 18;
      const minute = interaction.options.getInteger("minute") ?? 0;
      const timezone = interaction.options.getString("timezone") || TZ;
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      } catch {
        return interaction.reply({
          content: "That timezone is not valid. Use an IANA timezone such as America/Detroit.",
          ephemeral: true
        });
      }
      stmts.setConfig.run({
        guild_id: guildId,
        text_channel_id: text.id,
        voice_channel_id: voice?.id || null,
        admin_role_id: role?.id || null,
        timezone,
        lesson_hour: hour,
        lesson_minute: minute
      });
      return interaction.reply({
        content:
          `Setup saved. Lessons post daily at **${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${timezone}** in <#${ANNOUNCE_CHANNEL_ID}>.\n` +
          `Text (check-ins): ${text}\n` +
          (voice ? `Fallback / category voice: ${voice}\n` : "") +
          `Clicking **Start Training** on a lesson embed creates a private temporary voice channel for that member.`,
        ephemeral: true
      });
    }

    if (commandName === "enroll") {
      const u = ensureUser(guildId, user.id);
      return interaction.reply({
        content: `You're enrolled in the 15-month program. Your current lesson is Day ${u.current_day}/450. Use /lesson to view it, or wait for the daily embed and click **Start Training**.`,
        ephemeral: true
      });
    }

    if (commandName === "lesson") {
      const u = ensureUser(guildId, user.id);
      if (u.current_day > TOTAL_DAYS) {
        return interaction.reply({
          content: "You've completed all 450 lessons in the 15-month program. Check /progress for your final results.",
          ephemeral: true
        });
      }
      return interaction.reply({
        embeds: [lessonEmbed(getLesson(u.current_day))],
        components: [startTrainingButton(user.id)],
        ephemeral: true
      });
    }

    if (commandName === "start" || commandName === "resume") {
      const result = await startSession(guildId, user.id, member, { createTempVoice: true });
      const temp = result.tempChannel;
      const joinLink = temp ? `https://discord.com/channels/${guildId}/${temp.id}` : null;

      if (result.alreadyRunning) {
        return interaction.reply({
          content: `Training already running. **${Math.ceil(elapsed(result.session) / 60)} minutes** remaining.`,
          components: [sessionButtons(user.id)],
          ephemeral: true
        });
      }

      if (result.joined) {
        return interaction.reply({
          content:
            `${result.resumed ? "Training resumed." : "Training started."} You have **${Math.ceil(elapsed(result.session) / 60)} minutes** remaining.\n` +
            (joinLink ? `Private voice: ${joinLink}\n` : "") +
            `Check in every ${CHECKIN_SECONDS / 60} minutes.`,
          components: [sessionButtons(user.id)],
          ephemeral: true
        });
      }

      return interaction.reply({
        content:
          `Your private training voice channel is ready.\n` +
          (joinLink ? `**Join here:** ${joinLink}\n\n` : "") +
          `Join that channel to start/resume the two-hour timer. Stay in it and check in every ${CHECKIN_SECONDS / 60} minutes.`,
        components: [sessionButtons(user.id)],
        ephemeral: true
      });
    }

    if (commandName === "pause") {
      const s = stmts.active.get(guildId, user.id);
      if (!s || s.status !== "running") {
        return interaction.reply({ content: "You do not have a running timer.", ephemeral: true });
      }
      const r = await pauseSession(s);
      return interaction.reply({ content: `Timer paused. **${Math.ceil(r / 60)} minutes** remain.`, ephemeral: true });
    }

    if (commandName === "checkin") {
      const cfg = config(guildId);
      const s = stmts.active.get(guildId, user.id);
      if (!s) return interaction.reply({ content: "No active session. Use /start or Start Training first.", ephemeral: true });
      const requiredVc = requiredVoiceChannelId(s, cfg);
      if (!requiredVc || member.voice.channelId !== requiredVc) {
        return interaction.reply({
          content: "Join your private training voice channel before checking in.",
          ephemeral: true
        });
      }
      stmts.updateSession.run(s.remaining_seconds, s.status, s.last_started_at, Math.floor(Date.now() / 1000), s.id);
      return interaction.reply({ content: "Check-in recorded. If your timer is paused, use /resume.", ephemeral: true });
    }

    if (commandName === "skip") {
      const u = ensureUser(guildId, user.id);
      const cfg = config(guildId);
      const key = dayDateKey(cfg?.timezone || TZ);
      const s = stmts.active.get(guildId, user.id);
      if (s && s.status === "running") await pauseSession(s);
      if (s) await deleteTempVoice(s);
      stmts.markDaily.run(guildId, user.id, u.current_day, key, "skipped");
      if (s && ["paused", "running"].includes(s.status)) {
        stmts.db.prepare("UPDATE sessions SET status='skipped' WHERE id=?").run(s.id);
      }
      u.skipped_days += 1;
      saveUser(u);
      return interaction.reply({
        content: `Day ${u.current_day} skipped. Your progress has not been advanced or reset. The bot will post the same next lesson tomorrow at the scheduled time.`,
        ephemeral: true
      });
    }

    if (commandName === "progress") {
      const u = ensureUser(guildId, user.id);
      const pct = Math.round((u.completed_days / TOTAL_DAYS) * 100);
      const stats = stmts.getStats.get(guildId, user.id);
      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle("Your Luau program progress")
        .setDescription(`**Day ${u.current_day} of ${TOTAL_DAYS}** · ${pct}% complete`)
        .addFields(
          { name: "Completed lessons", value: String(u.completed_days), inline: true },
          { name: "Skipped days", value: String(u.skipped_days), inline: true },
          { name: "Training hours", value: String(Math.floor(u.total_minutes / 60)), inline: true },
          {
            name: "Quiz accuracy",
            value: stats.attempts ? `${Math.round(((stats.correct || 0) / stats.attempts) * 100)}%` : "No attempts yet",
            inline: true
          },
          { name: "Current streak", value: String(u.streak), inline: true },
          { name: "Program length", value: "15 months · 450 lessons", inline: true }
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === "quiz") {
      const u = ensureUser(guildId, user.id);
      const s = stmts.db
        .prepare("SELECT * FROM sessions WHERE guild_id=? AND user_id=? AND status='quiz' ORDER BY id DESC LIMIT 1")
        .get(guildId, user.id);
      if (!s) {
        return interaction.reply({
          content: "Your quiz appears after your two-hour active session ends.",
          ephemeral: true
        });
      }
      const l = getLesson(s.day_number);
      return interaction.reply({
        content: l.quiz.question,
        components: [createQuizRow(user.id, s.day_number)],
        ephemeral: true
      });
    }

    if (commandName === "ask") {
      await interaction.deferReply({ ephemeral: true });
      const answer = await askTutor(interaction.options.getString("question"));
      return interaction.editReply(answer.slice(0, 1900));
    }

    if (commandName === "help") {
      const e = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("Roblox Scripting Assistant · Commands")
        .setDescription("A 15-month, 450-lesson path from beginner Luau to a complete Roblox RPG prototype.")
        .addFields(
          {
            name: "Learning",
            value: "`/enroll` join · `/lesson` today's lesson · `/progress` your stats · `/ask` ask the tutor"
          },
          {
            name: "Attendance",
            value:
              "Click **Start Training** on the daily embed (or `/start`) → a private voice channel is created for you → join it to start the 2-hour timer · `/pause` · `/resume` · `/checkin` · `/skip`"
          },
          {
            name: "Quiz",
            value: "A quiz appears when the full two hours of active attendance are complete. Pass it to complete the day."
          },
          {
            name: "Admin",
            value: "`/setup` configure text channel + schedule · `/announce` post lessons"
          }
        )
        .setFooter({
          text: "Private temporary voice channel + text check-ins are required. The voice channel is deleted when the session ends."
        });
      return interaction.reply({ embeds: [e], ephemeral: true });
    }

    if (commandName === "announce") {
      const cfg = config(guildId);
      if (!isAdmin(member, cfg)) {
        return interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
      }
      await postLesson(guildId);
      return interaction.reply({ content: "Today's lesson announcement was posted.", ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    const message = err.message || "Something went wrong.";
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

client.login(TOKEN);

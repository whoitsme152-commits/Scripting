require("dotenv").config();
const { REST, Routes, SlashCommandBuilder, ChannelType } = require("discord.js");
const commands = [
  new SlashCommandBuilder().setName("setup").setDescription("Configure training channels and schedule")
    .addChannelOption(o=>o.setName("text_channel").setDescription("Training text channel").addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addChannelOption(o=>o.setName("voice_channel").setDescription("Training voice channel").addChannelTypes(ChannelType.GuildVoice).setRequired(true))
    .addRoleOption(o=>o.setName("admin_role").setDescription("Optional admin role"))
    .addIntegerOption(o=>o.setName("hour").setDescription("Hour, 24-hour clock").setMinValue(0).setMaxValue(23))
    .addIntegerOption(o=>o.setName("minute").setDescription("Minute").setMinValue(0).setMaxValue(59))
    .addStringOption(o=>o.setName("timezone").setDescription("IANA timezone")),
  new SlashCommandBuilder().setName("enroll").setDescription("Join the 15-month Luau program"),
  new SlashCommandBuilder().setName("lesson").setDescription("Show today's lesson"),
  new SlashCommandBuilder().setName("start").setDescription("Start or resume your session"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause your timer"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume your timer"),
  new SlashCommandBuilder().setName("checkin").setDescription("Confirm text attendance"),
  new SlashCommandBuilder().setName("skip").setDescription("Skip today's lesson"),
  new SlashCommandBuilder().setName("progress").setDescription("View your progress"),
  new SlashCommandBuilder().setName("quiz").setDescription("Open your finished lesson quiz"),
  new SlashCommandBuilder().setName("ask").setDescription("Ask the scripting tutor").addStringOption(o=>o.setName("question").setDescription("Your question").setRequired(true).setMaxLength(1500)),
  new SlashCommandBuilder().setName("help").setDescription("Show help"),
  new SlashCommandBuilder().setName("announce").setDescription("Post today's lesson")
].map(x=>x.toJSON());
(async()=>{
  if(!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) throw new Error("Set DISCORD_TOKEN and CLIENT_ID in .env");
  const rest=new REST({version:"10"}).setToken(process.env.DISCORD_TOKEN);
  const route=process.env.GUILD_ID ? Routes.applicationGuildCommands(process.env.CLIENT_ID,process.env.GUILD_ID) : Routes.applicationCommands(process.env.CLIENT_ID);
  await rest.put(route,{body:commands});
  console.log("Registered",commands.length,"slash commands.");
})().catch(e=>{console.error(e);process.exit(1);});

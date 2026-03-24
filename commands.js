const { SlashCommandBuilder, ChannelType } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure the bot for this server')
    .addSubcommand(sub =>
      sub
        .setName('bootstrap_staff_role')
        .setDescription('Set the bootstrap staff role')
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Bootstrap staff role').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('staff_role')
        .setDescription('Set the main staff role')
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Main staff role').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('timezone')
        .setDescription('Set the server timezone (IANA name, e.g. Pacific/Auckland)')
        .addStringOption(opt =>
          opt.setName('zone').setDescription('Timezone').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('mass_approval_channel')
        .setDescription('Set the staff approval channel for mass logs')
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('Approval channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('moderation_activity_channel')
        .setDescription('Set the log-here channel for moderation activity')
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('Activity log channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('moderation_approval_channel')
        .setDescription('Set the staff approval channel for moderation logs')
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('Approval channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName('staff')
    .setDescription('Manage staff members')
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Make someone staff and register them')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User to promote').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Remove someone from staff')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User to demote').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('Show current staff settings')
    ),

  new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register or unregister people for the bot')
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Register a user')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User to register').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Unregister a user')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User to unregister').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('Show registered users')
    ),

  new SlashCommandBuilder()
    .setName('mass')
    .setDescription('Mass hosting tools')
    .addSubcommand(sub =>
      sub
        .setName('start')
        .setDescription('Start a mass session')
        .addStringOption(opt =>
          opt.setName('mass_type').setDescription('Type of mass').setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('date')
            .setDescription('Date in server timezone (YYYY-MM-DD)')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('time')
            .setDescription('Time in server timezone (HH:MM, 24h)')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('link').setDescription('Join link').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('proof')
        .setDescription('Submit image proof for your ended mass')
        .addAttachmentOption(opt =>
          opt.setName('proof').setDescription('Image proof').setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('session_id')
            .setDescription('Optional mass session ID')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('status')
        .setDescription('Show your mass sessions')
    ),

  new SlashCommandBuilder()
    .setName('shift')
    .setDescription('Moderator shift tools')
    .addSubcommand(sub =>
      sub.setName('start').setDescription('Start your shift')
    )
    .addSubcommand(sub =>
      sub.setName('end').setDescription('End your active shift')
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Show your shift status')
    ),

  new SlashCommandBuilder()
    .setName('modlog')
    .setDescription('Log moderation activity')
    .addSubcommand(sub =>
      sub
        .setName('create')
        .setDescription('Create a moderation log entry')
        .addStringOption(opt =>
          opt.setName('username').setDescription('Username involved').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('nature').setDescription('Nature of the activity').setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('action_taken')
            .setDescription('Action taken')
            .setRequired(true)
            .addChoices(
              { name: 'Server kick', value: 'kick' },
              { name: 'Server ban', value: 'ban' },
              { name: 'Permanent ban', value: 'permban' },
              { name: 'Other / no pay', value: 'other' },
            )
        )
        .addAttachmentOption(opt =>
          opt.setName('proof').setDescription('Image proof').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Show pending moderation logs')
    ),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show clergy or moderation leaderboards')
    .addStringOption(opt =>
      opt
        .setName('category')
        .setDescription('Which leaderboard to show')
        .setRequired(true)
        .addChoices(
          { name: 'Clergy', value: 'clergy' },
          { name: 'Moderation', value: 'moderation' },
        )
    ),

  new SlashCommandBuilder()
    .setName('payroll')
    .setDescription('Show current two-week pay summary')
    .addSubcommand(sub =>
      sub.setName('summary').setDescription('Show pay totals for the current pay period')
    ),
].map(cmd => cmd.toJSON());

module.exports = commands;

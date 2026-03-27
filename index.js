require('dotenv').config();
require('./deploy-commands');

const Database = require('better-sqlite3');
const { DateTime } = require('luxon');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

const db = new Database('./bot.sqlite');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  bootstrap_staff_role_id TEXT,
  staff_role_id TEXT,
  timezone TEXT NOT NULL DEFAULT 'Pacific/Auckland',
  mass_channel_id TEXT,
  mass_approval_channel_id TEXT,
  moderation_activity_channel_id TEXT,
  moderation_approval_channel_id TEXT,
  pay_period_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS registered_users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  registered_by TEXT,
  registered_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS mass_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  mass_type TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  link TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  proof_url TEXT,
  mass_channel_id TEXT,
  mass_message_id TEXT,
  approval_channel_id TEXT,
  approval_message_id TEXT,
  approved_by TEXT,
  approved_at INTEGER,
  denied_by TEXT,
  denied_at INTEGER,
  denial_reason TEXT,
  pay_amount INTEGER NOT NULL DEFAULT 10
);

CREATE TABLE IF NOT EXISTS mod_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS mod_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  username TEXT NOT NULL,
  nature TEXT NOT NULL,
  action_taken TEXT NOT NULL,
  proof_url TEXT NOT NULL,
  approval_channel_id TEXT,
  approval_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  denied_by TEXT,
  denied_at INTEGER,
  denial_reason TEXT,
  pay_amount INTEGER NOT NULL DEFAULT 0
);
`);

const now = Date.now();
const insertGuild = db.prepare(`
  INSERT INTO guild_settings (guild_id, timezone, pay_period_start)
  VALUES (?, 'Pacific/Auckland', ?)
  ON CONFLICT(guild_id) DO NOTHING
`);

const getGuild = db.prepare(`SELECT * FROM guild_settings WHERE guild_id = ?`);
const setField = (field) => db.prepare(`UPDATE guild_settings SET ${field} = ? WHERE guild_id = ?`);

function ensureGuild(guildId) {
  insertGuild.run(guildId, now);
  return getGuild.get(guildId);
}

function getGuildSettings(guildId) {
  ensureGuild(guildId);
  return getGuild.get(guildId);
}

function updateGuildField(guildId, field, value) {
  setField(field).run(value, guildId);
}

function ensureRegistered(guildId, userId, registeredBy = null) {
  db.prepare(`
    INSERT INTO registered_users (guild_id, user_id, registered_by, registered_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET registered_by = COALESCE(excluded.registered_by, registered_users.registered_by)
  `).run(guildId, userId, registeredBy, Date.now());
}

function removeRegistered(guildId, userId) {
  db.prepare(`DELETE FROM registered_users WHERE guild_id = ? AND user_id = ?`).run(guildId, userId);
}

function isRegistered(guildId, userId) {
  return !!db.prepare(`SELECT 1 FROM registered_users WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
}

function isStaff(member, settings) {
  if (!member || !settings) return false;
  if (member.id === member.guild.ownerId) return true;
  if (settings.bootstrap_staff_role_id && member.roles.cache.has(settings.bootstrap_staff_role_id)) return true;
  if (settings.staff_role_id && member.roles.cache.has(settings.staff_role_id)) return true;
  return false;
}

function requireRegisteredOrStaff(interaction, settings) {
  if (!interaction.guild || !interaction.member) return false;
  return isRegistered(interaction.guild.id, interaction.user.id) || isStaff(interaction.member, settings);
}

function formatUnix(ms) {
  return `<t:${Math.floor(ms / 1000)}:F> (<t:${Math.floor(ms / 1000)}:R>)`;
}

function getZone(settings) {
  return settings?.timezone || 'Pacific/Auckland';
}

function parseGuildDateTime(dateStr, timeStr, zone) {
  const dt = DateTime.fromISO(`${dateStr}T${timeStr}`, { zone });
  if (!dt.isValid) {
    throw new Error(`Invalid date/time for zone ${zone}: ${dt.invalidExplanation || 'unknown error'}`);
  }
  return dt.toUTC().toMillis();
}

function getPayWindow(settings) {
  const periodMs = 14 * 24 * 60 * 60 * 1000;
  let start = settings.pay_period_start;
  const now = Date.now();
  let changed = false;
  while (now >= start + periodMs) {
    start += periodMs;
    changed = true;
  }
  if (changed) {
    updateGuildField(settings.guild_id, 'pay_period_start', start);
    settings.pay_period_start = start;
  }
  return {
    start,
    end: start + periodMs,
    periodMs,
  };
}

function payForAction(actionTaken) {
  if (actionTaken === 'kick') return 10;
  if (actionTaken === 'ban') return 50;
  if (actionTaken === 'permban') return 100;
  return 0;
}

function actionLabel(actionTaken) {
  if (actionTaken === 'kick') return 'Server kick';
  if (actionTaken === 'ban') return 'Server ban';
  if (actionTaken === 'permban') return 'Permanent ban';
  return 'Other / no pay';
}

async function memberDisplay(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    return member.displayName || member.user.globalName || member.user.username;
  } catch {
    return `<@${userId}>`;
  }
}

function buildButtonRow(type, id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${type}_approve:${id}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${type}_deny:${id}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

async function editApprovalMessage(guild, channelId, messageId, embed, components) {
  if (!channelId || !messageId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (message) {
    await message.edit({ embeds: [embed], components }).catch(() => null);
  }
}

function isImageAttachment(att) {
  if (!att) return false;
  if (att.contentType && att.contentType.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp)$/i.test(att.name || '');
}

function buildMassEmbed(row, settings, statusText = null) {
  const scheduled = formatUnix(row.scheduled_at);
  const e = new EmbedBuilder()
    .setTitle(`Mass #${row.id}`)
    .setColor(0xf5c542)
    .addFields(
      { name: 'Host', value: `<@${row.host_id}>`, inline: true },
      { name: 'Type', value: row.mass_type, inline: true },
      { name: 'Scheduled', value: scheduled, inline: false },
      { name: 'Link', value: row.link, inline: false },
      { name: 'Status', value: statusText || row.status, inline: true },
    )
    .setFooter({ text: `Server timezone: ${getZone(settings)}` });

  if (row.proof_url) {
    e.setImage(row.proof_url);
  }
  return e;
}

function buildModLogEmbed(row, statusText = null) {
  const e = new EmbedBuilder()
    .setTitle(`Moderation Log #${row.id}`)
    .setColor(0x9b59b6)
    .addFields(
      { name: 'Moderator', value: `<@${row.moderator_id}>`, inline: true },
      { name: 'Username', value: row.username, inline: true },
      { name: 'Nature', value: row.nature, inline: false },
      { name: 'Action taken', value: actionLabel(row.action_taken), inline: true },
      { name: 'Pay', value: `${row.pay_amount} Robux`, inline: true },
      { name: 'Status', value: statusText || row.status, inline: true },
    );

  if (row.proof_url) {
    e.setImage(row.proof_url);
  }
  return e;
}

function buildShiftEmbed(row, statusText = null) {
  return new EmbedBuilder()
    .setTitle(`Shift #${row.id}`)
    .setColor(0x3498db)
    .addFields(
      { name: 'Moderator', value: `<@${row.moderator_id}>`, inline: true },
      { name: 'Started', value: formatUnix(row.started_at), inline: false },
      { name: 'Status', value: statusText || row.status, inline: true },
    );
}

async function getApprovalChannel(guild, channelId) {
  if (!channelId) return null;
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return null;
  return ch;
}

function loadMassById(guildId, id) {
  return db.prepare(`SELECT * FROM mass_sessions WHERE guild_id = ? AND id = ?`).get(guildId, Number(id));
}

function loadLatestPendingMass(guildId, hostId) {
  return db.prepare(`
    SELECT * FROM mass_sessions
    WHERE guild_id = ? AND host_id = ? AND status = 'awaiting_proof'
    ORDER BY id DESC
    LIMIT 1
  `).get(guildId, hostId);
}

function loadLatestActiveMass(guildId, hostId) {
  return db.prepare(`
    SELECT * FROM mass_sessions
    WHERE guild_id = ? AND host_id = ? AND status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).get(guildId, hostId);
}

function loadActiveShift(guildId, moderatorId) {
  return db.prepare(`
    SELECT * FROM mod_shifts
    WHERE guild_id = ? AND moderator_id = ? AND status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).get(guildId, moderatorId);
}

function topRowsFromMap(map, key) {
  return [...map.entries()]
    .sort((a, b) => (b[1][key] || 0) - (a[1][key] || 0))
    .slice(0, 10);
}

async function sendDeniedModal(interaction, type, id) {
  const modal = new ModalBuilder()
    .setCustomId(`${type}_deny_reason:${id}`)
    .setTitle('Denial reason');

  const input = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('Reason for denial')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleSetup(interaction) {
  const settings = getGuildSettings(interaction.guildId);
  const sub = interaction.options.getSubcommand();
  const isOwner = interaction.user.id === interaction.guild.ownerId;
  const member = interaction.member;

  if (!isOwner && !isStaff(member, settings) && sub !== 'bootstrap_staff_role') {
    return interaction.reply({ content: 'Only the server owner or staff can use setup commands.', ephemeral: true });
  }

  if (sub === 'bootstrap_staff_role') {
    if (!isOwner) {
      return interaction.reply({ content: 'Only the server owner can set the bootstrap staff role.', ephemeral: true });
    }
    const role = interaction.options.getRole('role', true);
    updateGuildField(interaction.guildId, 'bootstrap_staff_role_id', role.id);
    ensureRegistered(interaction.guildId, interaction.user.id, interaction.user.id);
    return interaction.reply({ content: `Bootstrap staff role set to **${role.name}**. You were also registered.`, ephemeral: true });
  }

  if (sub === 'staff_role') {
    const role = interaction.options.getRole('role', true);
    updateGuildField(interaction.guildId, 'staff_role_id', role.id);
    return interaction.reply({ content: `Main staff role set to **${role.name}**.`, ephemeral: true });
  }

  if (sub === 'timezone') {
    const zone = interaction.options.getString('zone', true).trim();
    const test = DateTime.local().setZone(zone);
    if (!test.isValid) {
      return interaction.reply({ content: `That timezone is not valid. Use an IANA zone like \`Pacific/Auckland\` or \`Europe/London\`.`, ephemeral: true });
    }
    updateGuildField(interaction.guildId, 'timezone', zone);
    return interaction.reply({ content: `Timezone set to **${zone}**.`, ephemeral: true });
  }
  
  if (sub === 'mass_channel') {
  const channel = interaction.options.getChannel('channel', true);
  updateGuildField(interaction.guildId, 'mass_channel_id', channel.id);

  return interaction.reply({
    content: `Mass channel set to ${channel}.`,
    ephemeral: true
  });
}
  
  if (sub === 'mass_approval_channel') {
  const channel = interaction.options.getChannel('channel', true);
  updateGuildField(interaction.guildId, 'mass_approval_channel_id', channel.id);

  return interaction.reply({
    content: `Mass approval channel set to ${channel}.`,
    ephemeral: true
  });
}
  
  if (sub === 'moderation_activity_channel') {
    const channel = interaction.options.getChannel('channel', true);
    updateGuildField(interaction.guildId, 'moderation_activity_channel_id', channel.id);
    return interaction.reply({ content: `Moderation activity channel set to ${channel}.`, ephemeral: true });
  }

  if (sub === 'moderation_approval_channel') {
    const channel = interaction.options.getChannel('channel', true);
    updateGuildField(interaction.guildId, 'moderation_approval_channel_id', channel.id);
    return interaction.reply({ content: `Moderation approval channel set to ${channel}.`, ephemeral: true });
  }
}

async function handleRegister(interaction, add) {
  const settings = getGuildSettings(interaction.guildId);
  if (!isStaff(interaction.member, settings) && interaction.user.id !== interaction.guild.ownerId) {
    return interaction.reply({ content: 'Only staff can register or unregister users.', ephemeral: true });
  }

  const user = interaction.options.getUser('user', true);
  if (add) {
    ensureRegistered(interaction.guildId, user.id, interaction.user.id);
    return interaction.reply({ content: `Registered ${user}.`, ephemeral: true });
  }
  removeRegistered(interaction.guildId, user.id);
  return interaction.reply({ content: `Unregistered ${user}.`, ephemeral: true });
}

async function handleRegisterList(interaction) {
  const rows = db.prepare(`SELECT user_id, registered_at, registered_by FROM registered_users WHERE guild_id = ? ORDER BY registered_at DESC`).all(interaction.guildId);
  if (!rows.length) return interaction.reply({ content: 'No registered users yet.', ephemeral: true });

  const lines = [];
  for (const row of rows.slice(0, 20)) {
    lines.push(`• <@${row.user_id}> — ${formatUnix(row.registered_at)}`);
  }
  return interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

async function handleStaff(interaction, add) {
  const settings = getGuildSettings(interaction.guildId);
  const member = interaction.member;
  const isOwner = interaction.user.id === interaction.guild.ownerId;
  const bootstrapOk = settings.bootstrap_staff_role_id && member.roles.cache.has(settings.bootstrap_staff_role_id);
  const staffOk = settings.staff_role_id && member.roles.cache.has(settings.staff_role_id);

  if (!isOwner && !bootstrapOk && !staffOk) {
    return interaction.reply({ content: 'You need staff access to manage staff members.', ephemeral: true });
  }

  const user = interaction.options.getUser('user', true);
  const guildMember = await interaction.guild.members.fetch(user.id).catch(() => null);

  if (add) {
    ensureRegistered(interaction.guildId, user.id, interaction.user.id);
    if (settings.staff_role_id && guildMember) {
      await guildMember.roles.add(settings.staff_role_id).catch(() => null);
    }
    return interaction.reply({ content: `Promoted ${user} to staff and registered them.`, ephemeral: true });
  }

  if (settings.staff_role_id && guildMember) {
    await guildMember.roles.remove(settings.staff_role_id).catch(() => null);
  }
  return interaction.reply({ content: `Removed staff access from ${user}.`, ephemeral: true });
}

async function handleStaffList(interaction) {
  const settings = getGuildSettings(interaction.guildId);
  const embed = new EmbedBuilder()
    .setTitle('Current staff configuration')
    .setColor(0x2ecc71)
    .addFields(
      { name: 'Bootstrap staff role', value: settings.bootstrap_staff_role_id ? `<@&${settings.bootstrap_staff_role_id}>` : 'Not set', inline: false },
      { name: 'Main staff role', value: settings.staff_role_id ? `<@&${settings.staff_role_id}>` : 'Not set', inline: false },
      { name: 'Timezone', value: settings.timezone, inline: false },
      { name: 'Mass channel', value: settings.mass_channel_id ? `<#${settings.mass_channel_id}>` : 'Not set', inline: false },
      { name: 'Mass approval channel', value: settings.mass_approval_channel_id ? `<#${settings.mass_approval_channel_id}>` : 'Not set', inline: false },
      { name: 'Moderation activity channel', value: settings.moderation_activity_channel_id ? `<#${settings.moderation_activity_channel_id}>` : 'Not set', inline: false },
      { name: 'Moderation approval channel', value: settings.moderation_approval_channel_id ? `<#${settings.moderation_approval_channel_id}>` : 'Not set', inline: false },
      { name: 'Pay period start', value: formatUnix(settings.pay_period_start), inline: false },
    );
  return interaction.reply({ embeds: [embed] });
}

async function handleMass(interaction, sub) {
  const settings = getGuildSettings(interaction.guildId);
if (sub === 'start') {
  await interaction.deferReply({ ephemeral: true });

  if (!requireRegisteredOrStaff(interaction, settings)) {
    return interaction.editReply({ content: 'Only registered users can use the bot.' });
  }

  const existing = loadLatestActiveMass(interaction.guildId, interaction.user.id);
  if (existing) {
    return interaction.editReply({
      content: `You already have an active mass (#${existing.id}). End it before starting another.`
    });
  }

  const massChannel = await getApprovalChannel(interaction.guild, settings.mass_channel_id);
  if (!massChannel) {
    return interaction.editReply({
      content: 'Mass channel is not set yet. Ask staff to use `/setup mass_channel` first.'
    });
  }

  const massType = interaction.options.getString('mass_type', true);
  const date = interaction.options.getString('date', true);
  const time = interaction.options.getString('time', true);
  const link = interaction.options.getString('link', true);

  let scheduledAt;
  try {
    scheduledAt = parseGuildDateTime(date.trim(), time.trim(), getZone(settings));
  } catch (err) {
    return interaction.editReply({ content: err.message });
  }

  const insert = db.prepare(`
    INSERT INTO mass_sessions (
      guild_id, host_id, mass_type, scheduled_at, link, status, started_at
    )
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `);

  const info = insert.run(
    interaction.guildId,
    interaction.user.id,
    massType.trim(),
    scheduledAt,
    link.trim(),
    Date.now()
  );

  const row = db.prepare(`SELECT * FROM mass_sessions WHERE id = ?`).get(info.lastInsertRowid);
  const embed = buildMassEmbed(row, settings, 'Active');
  embed.setDescription('Press **End Mass** when the session is finished. After that, submit proof with `/mass proof`.');

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mass_end:${row.id}`)
      .setLabel('End Mass')
      .setStyle(ButtonStyle.Danger),
  );

  const sent = await massChannel.send({
    content: '@here',
    allowedMentions: { parse: ['everyone'] },
    embeds: [embed],
    components: [buttons],
  });

  db.prepare(`
    UPDATE mass_sessions
    SET mass_channel_id = ?, mass_message_id = ?
    WHERE id = ?
  `).run(massChannel.id, sent.id, row.id);

  return interaction.editReply({
    content: `Mass posted in ${massChannel}. Session ID: **${row.id}**`
  });
}

  if (sub === 'proof') {
    if (!requireRegisteredOrStaff(interaction, settings)) {
      return interaction.reply({ content: 'Only registered users can use the bot.', ephemeral: true });
    }

    const proof = interaction.options.getAttachment('proof', true);
    if (!isImageAttachment(proof)) {
      return interaction.reply({ content: 'Proof must be an image attachment.', ephemeral: true });
    }

    const sessionId = interaction.options.getString('session_id', false);
    let session = null;
    if (sessionId) {
      session = loadMassById(interaction.guildId, sessionId);
      if (!session || session.host_id !== interaction.user.id) {
        return interaction.reply({ content: 'That session was not found or does not belong to you.', ephemeral: true });
      }
    } else {
      session = loadLatestPendingMass(interaction.guildId, interaction.user.id);
    }

    if (!session) {
      return interaction.reply({ content: 'No ended mass waiting for proof was found. End a mass first, then submit proof.', ephemeral: true });
    }

    if (session.status !== 'awaiting_proof') {
      return interaction.reply({ content: `That mass is currently **${session.status}** and cannot accept proof.`, ephemeral: true });
    }

    db.prepare(`
      UPDATE mass_sessions
      SET status = 'pending_approval',
          proof_url = ?
      WHERE id = ?
    `).run(proof.url, session.id);

    const updated = loadMassById(interaction.guildId, session.id);
    const approvalChannel = await getApprovalChannel(interaction.guild, settings.mass_approval_channel_id);

    if (!approvalChannel) {
      return interaction.reply({ content: 'Mass approval channel is not set yet.', ephemeral: true });
    }

    const embed = buildMassEmbed(updated, settings, 'Pending staff approval');
    const components = [buildButtonRow('mass', updated.id)];
    const sent = await approvalChannel.send({ embeds: [embed], components });
    db.prepare(`
      UPDATE mass_sessions
      SET approval_channel_id = ?, approval_message_id = ?
      WHERE id = ?
    `).run(approvalChannel.id, sent.id, updated.id);
    return interaction.reply({ content: `Proof submitted for mass #${updated.id}.`, ephemeral: true });
  }

  if (sub === 'status') {
    const masses = db.prepare(`
      SELECT * FROM mass_sessions
      WHERE guild_id = ? AND host_id = ?
      ORDER BY id DESC
      LIMIT 10
    `).all(interaction.guildId, interaction.user.id);

    if (!masses.length) return interaction.reply({ content: 'You have no mass sessions yet.', ephemeral: true });

    const lines = masses.map(m => `• **#${m.id}** — ${m.mass_type} — ${m.status} — ${formatUnix(m.scheduled_at)}`);
    return interaction.reply({ content: lines.join('\n'), ephemeral: true });
  }
}

async function handleShift(interaction, sub) {
  const settings = getGuildSettings(interaction.guildId);
  if (!requireRegisteredOrStaff(interaction, settings) || !isStaff(interaction.member, settings)) {
    return interaction.reply({ content: 'Only staff members can use shift commands.', ephemeral: true });
  }

  if (sub === 'start') {
    const active = loadActiveShift(interaction.guildId, interaction.user.id);
    if (active) {
      return interaction.reply({ content: `You already have an active shift (#${active.id}).`, ephemeral: true });
    }
    const info = db.prepare(`
      INSERT INTO mod_shifts (guild_id, moderator_id, started_at, status)
      VALUES (?, ?, ?, 'active')
    `).run(interaction.guildId, interaction.user.id, Date.now());
    return interaction.reply({ content: `Shift started. Shift ID: **${info.lastInsertRowid}**`, ephemeral: true });
  }

  if (sub === 'end') {
    const active = loadActiveShift(interaction.guildId, interaction.user.id);
    if (!active) {
      return interaction.reply({ content: 'You do not have an active shift.', ephemeral: true });
    }
    db.prepare(`
      UPDATE mod_shifts
      SET ended_at = ?, status = 'ended'
      WHERE id = ?
    `).run(Date.now(), active.id);

    const updated = db.prepare(`SELECT * FROM mod_shifts WHERE id = ?`).get(active.id);
    return interaction.reply({ content: `Shift ended (#${updated.id}).`, ephemeral: true });
  }

  if (sub === 'status') {
    const active = loadActiveShift(interaction.guildId, interaction.user.id);
    if (!active) return interaction.reply({ content: 'You do not have an active shift right now.', ephemeral: true });
    return interaction.reply({ content: `You are on shift **#${active.id}** since ${formatUnix(active.started_at)}.`, ephemeral: true });
  }
}

async function handleModLog(interaction, sub) {
  const settings = getGuildSettings(interaction.guildId);
  if (!requireRegisteredOrStaff(interaction, settings) || !isStaff(interaction.member, settings)) {
    return interaction.reply({ content: 'Only staff members can log moderation activity.', ephemeral: true });
  }

  if (sub === 'create') {
    const username = interaction.options.getString('username', true);
    const nature = interaction.options.getString('nature', true);
    const actionTaken = interaction.options.getString('action_taken', true);
    const proof = interaction.options.getAttachment('proof', true);

    if (!isImageAttachment(proof)) {
      return interaction.reply({ content: 'Proof must be an image attachment.', ephemeral: true });
    }

    const payAmount = payForAction(actionTaken);
    const info = db.prepare(`
      INSERT INTO mod_logs (
        guild_id, moderator_id, username, nature, action_taken, proof_url,
        status, created_at, pay_amount
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(interaction.guildId, interaction.user.id, username.trim(), nature.trim(), actionTaken, proof.url, Date.now(), payAmount);

    const row = db.prepare(`SELECT * FROM mod_logs WHERE id = ?`).get(info.lastInsertRowid);
    const activityChannel = await getApprovalChannel(interaction.guild, settings.moderation_activity_channel_id);
    const approvalChannel = await getApprovalChannel(interaction.guild, settings.moderation_approval_channel_id);

    const embed = buildModLogEmbed(row, 'Pending staff approval');
    const components = [buildButtonRow('mod', row.id)];

    if (activityChannel) {
      await activityChannel.send({ embeds: [embed] });
    }

    if (!approvalChannel) {
      return interaction.reply({ content: 'Moderation approval channel is not set yet.', ephemeral: true });
    }

    const sent = await approvalChannel.send({ embeds: [embed], components });
    db.prepare(`
      UPDATE mod_logs
      SET approval_channel_id = ?, approval_message_id = ?
      WHERE id = ?
    `).run(approvalChannel.id, sent.id, row.id);
    return interaction.reply({ content: `Moderation log #${row.id} submitted.`, ephemeral: true });
  }

  if (sub === 'status') {
    const rows = db.prepare(`
      SELECT * FROM mod_logs
      WHERE guild_id = ? AND moderator_id = ?
      ORDER BY id DESC
      LIMIT 10
    `).all(interaction.guildId, interaction.user.id);

    if (!rows.length) return interaction.reply({ content: 'You have no moderation logs yet.', ephemeral: true });

    const lines = rows.map(r => `• **#${r.id}** — ${actionLabel(r.action_taken)} — ${r.status}`);
    return interaction.reply({ content: lines.join('\n'), ephemeral: true });
  }
}

async function handleLeaderboard(interaction) {
  const settings = getGuildSettings(interaction.guildId);
  const category = interaction.options.getString('category', true);
  const window = getPayWindow(settings);
  const guild = interaction.guild;

  const people = new Map();

  function add(userId) {
    if (!people.has(userId)) {
      people.set(userId, {
        userId,
        masses: 0,
        clergyPay: 0,
        shifts: 0,
        modPay: 0,
        totalPay: 0,
      });
    }
    return people.get(userId);
  }

  if (category === 'clergy') {
    const massRows = db.prepare(`
      SELECT host_id AS user_id, COUNT(*) AS masses, COALESCE(SUM(pay_amount), 0) AS pay
      FROM mass_sessions
      WHERE guild_id = ? AND status = 'approved' AND approved_at BETWEEN ? AND ?
      GROUP BY host_id
    `).all(interaction.guildId, window.start, window.end);

    for (const row of massRows) {
      const p = add(row.user_id);
      p.masses = Number(row.masses);
      p.clergyPay = Number(row.pay);
      p.totalPay = p.clergyPay;
    }

    const sortedMasses = [...people.values()].sort((a, b) => b.masses - a.masses).slice(0, 10);
    const sortedPay = [...people.values()].sort((a, b) => b.clergyPay - a.clergyPay).slice(0, 10);

    const massLines = sortedMasses.length
      ? await Promise.all(sortedMasses.map(async (p, i) => `**${i + 1}.** ${await memberDisplay(guild, p.userId)} — ${p.masses} masses`))
      : ['No approved masses in the current pay period.'];

    const payLines = sortedPay.length
      ? await Promise.all(sortedPay.map(async (p, i) => `**${i + 1}.** ${await memberDisplay(guild, p.userId)} — ${p.clergyPay} Robux`))
      : ['No clergy pay yet.'];

    const embed = new EmbedBuilder()
      .setTitle('Clergy leaderboard')
      .setColor(0xf5c542)
      .addFields(
        { name: 'Most masses hosted', value: massLines.join('\n'), inline: false },
        { name: 'Most money earned', value: payLines.join('\n'), inline: false },
        { name: 'Current pay window', value: `${formatUnix(window.start)} → ${formatUnix(window.end)}`, inline: false },
      );

    return interaction.reply({ embeds: [embed] });
  }

  const shiftRows = db.prepare(`
    SELECT moderator_id AS user_id, COUNT(*) AS shifts
    FROM mod_shifts
    WHERE guild_id = ? AND status = 'ended' AND ended_at BETWEEN ? AND ?
    GROUP BY moderator_id
  `).all(interaction.guildId, window.start, window.end);

  const payRows = db.prepare(`
    SELECT moderator_id AS user_id, COUNT(*) AS logs, COALESCE(SUM(pay_amount), 0) AS pay
    FROM mod_logs
    WHERE guild_id = ? AND status = 'approved' AND approved_at BETWEEN ? AND ?
    GROUP BY moderator_id
  `).all(interaction.guildId, window.start, window.end);

  for (const row of shiftRows) {
    const p = add(row.user_id);
    p.shifts = Number(row.shifts);
  }

  for (const row of payRows) {
    const p = add(row.user_id);
    p.modPay = Number(row.pay);
    p.totalPay = p.modPay;
  }

  const sortedShifts = [...people.values()].sort((a, b) => b.shifts - a.shifts).slice(0, 10);
  const sortedPay = [...people.values()].sort((a, b) => b.modPay - a.modPay).slice(0, 10);

  const shiftLines = sortedShifts.length
    ? await Promise.all(sortedShifts.map(async (p, i) => `**${i + 1}.** ${await memberDisplay(guild, p.userId)} — ${p.shifts} shifts`))
    : ['No completed shifts in the current pay period.'];

  const payLines = sortedPay.length
    ? await Promise.all(sortedPay.map(async (p, i) => `**${i + 1}.** ${await memberDisplay(guild, p.userId)} — ${p.modPay} Robux`))
    : ['No moderation pay yet.'];

  const embed = new EmbedBuilder()
    .setTitle('Moderation leaderboard')
    .setColor(0x9b59b6)
    .addFields(
      { name: 'Most shifts', value: shiftLines.join('\n'), inline: false },
      { name: 'Most money earned', value: payLines.join('\n'), inline: false },
      { name: 'Current pay window', value: `${formatUnix(window.start)} → ${formatUnix(window.end)}`, inline: false },
    );

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handlePayroll(interaction) {
  const settings = getGuildSettings(interaction.guildId);
  if (!isStaff(interaction.member, settings) && interaction.user.id !== interaction.guild.ownerId) {
    return interaction.reply({ content: 'Only staff can view payroll summaries.', ephemeral: true });
  }

  const window = getPayWindow(settings);
  const guild = interaction.guild;

  const people = new Map();

  function add(userId) {
    if (!people.has(userId)) {
      people.set(userId, {
        userId,
        clergyMasses: 0,
        clergyPay: 0,
        shifts: 0,
        modPay: 0,
        totalPay: 0,
      });
    }
    return people.get(userId);
  }

  const massRows = db.prepare(`
    SELECT host_id AS user_id, COUNT(*) AS masses, COALESCE(SUM(pay_amount), 0) AS pay
    FROM mass_sessions
    WHERE guild_id = ? AND status = 'approved' AND approved_at BETWEEN ? AND ?
    GROUP BY host_id
  `).all(interaction.guildId, window.start, window.end);

  const shiftRows = db.prepare(`
    SELECT moderator_id AS user_id, COUNT(*) AS shifts
    FROM mod_shifts
    WHERE guild_id = ? AND status = 'ended' AND ended_at BETWEEN ? AND ?
    GROUP BY moderator_id
  `).all(interaction.guildId, window.start, window.end);

  const modRows = db.prepare(`
    SELECT moderator_id AS user_id, COUNT(*) AS logs, COALESCE(SUM(pay_amount), 0) AS pay
    FROM mod_logs
    WHERE guild_id = ? AND status = 'approved' AND approved_at BETWEEN ? AND ?
    GROUP BY moderator_id
  `).all(interaction.guildId, window.start, window.end);

  for (const row of massRows) {
    const p = add(row.user_id);
    p.clergyMasses = Number(row.masses);
    p.clergyPay = Number(row.pay);
  }

  for (const row of shiftRows) {
    const p = add(row.user_id);
    p.shifts = Number(row.shifts);
  }

  for (const row of modRows) {
    const p = add(row.user_id);
    p.modPay = Number(row.pay);
  }

  const lines = [...people.values()]
    .map(p => {
      p.totalPay = p.clergyPay + p.modPay;
      return p;
    })
    .filter(p => p.totalPay > 0 || p.clergyMasses > 0 || p.shifts > 0)
    .sort((a, b) => b.totalPay - a.totalPay)
    .slice(0, 20);

  const description = lines.length
    ? await Promise.all(lines.map(async p => {
        const name = await memberDisplay(guild, p.userId);
        return `**${name}**\nClergy: ${p.clergyPay} Robux (${p.clergyMasses} masses) • Mod: ${p.modPay} Robux (${p.shifts} shifts) • **Total: ${p.totalPay} Robux**`;
      }))
    : ['No approved pay in the current pay period.'];

  const embed = new EmbedBuilder()
    .setTitle('Current pay summary')
    .setColor(0x2ecc71)
    .setDescription(description.join('\n\n'))
    .addFields({ name: 'Pay window', value: `${formatUnix(window.start)} → ${formatUnix(window.end)}` });

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleButton(interaction) {
  const settings = getGuildSettings(interaction.guildId);
  const [kind, id] = interaction.customId.split(':');
  const staffOk = isStaff(interaction.member, settings);
  const memberOk = isRegistered(interaction.guildId, interaction.user.id) || staffOk;

 if (kind === 'mass_end') {

  await interaction.deferUpdate();

  const row = loadMassById(interaction.guildId, id);

  if (!row) {
    return interaction.followUp({
      content: 'That mass session could not be found.',
      ephemeral: true
    });
  }

  if (row.host_id !== interaction.user.id && !staffOk) {
    return interaction.reply({
      content: 'Only the host or staff can end this mass.',
      ephemeral: true
    });
  }

  if (row.status !== 'active') {
    return interaction.reply({
      content: `This mass is already **${row.status}**.`,
      ephemeral: true
    });
  }

  db.prepare(`
    UPDATE mass_sessions
    SET ended_at = ?, status = 'awaiting_proof'
    WHERE id = ?
  `).run(Date.now(), row.id);

  const updated = loadMassById(interaction.guildId, row.id);

  const embed = buildMassEmbed(updated, settings, 'Awaiting proof from host');

  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mass_end:${row.id}`)
      .setLabel('End Mass')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true),
  );

  if (updated.mass_channel_id && updated.mass_message_id) {
    const massChannel = await interaction.guild.channels.fetch(updated.mass_channel_id).catch(() => null);
    if (massChannel && massChannel.type === ChannelType.GuildText) {
      const massMessage = await massChannel.messages.fetch(updated.mass_message_id).catch(() => null);
      if (massMessage) {
        await massMessage.edit({
          embeds: [embed],
          components: [disabledRow],
        });
      }
    }
  }

  await interaction.followUp({
    content: 'Mass ended. Please submit proof with `/mass proof`.',
    ephemeral: true
  });

}
  if (kind === 'mass_approve') {
    if (!staffOk) return interaction.reply({ content: 'Only staff can approve mass logs.', ephemeral: true });
    const row = loadMassById(interaction.guildId, id);
    if (!row) return interaction.reply({ content: 'Mass not found.', ephemeral: true });
    if (row.status !== 'pending_approval') return interaction.reply({ content: `That mass is **${row.status}**.`, ephemeral: true });

    db.prepare(`
      UPDATE mass_sessions
      SET status = 'approved', approved_by = ?, approved_at = ?
      WHERE id = ?
    `).run(interaction.user.id, Date.now(), row.id);

    const updated = loadMassById(interaction.guildId, row.id);
    const embed = buildMassEmbed(updated, settings, 'Approved');
    const rowButtons = buildButtonRow('mass', row.id, true);
    await interaction.update({ embeds: [embed], components: [rowButtons] });
    return;
  }

  if (kind === 'mass_deny') {
    if (!staffOk) return interaction.reply({ content: 'Only staff can deny mass logs.', ephemeral: true });
    const row = loadMassById(interaction.guildId, id);
    if (!row) return interaction.reply({ content: 'Mass not found.', ephemeral: true });
    if (row.status !== 'pending_approval') return interaction.reply({ content: `That mass is **${row.status}**.`, ephemeral: true });
    return sendDeniedModal(interaction, 'mass', id);
  }

  if (kind === 'mod_approve') {
    if (!staffOk) return interaction.reply({ content: 'Only staff can approve moderation logs.', ephemeral: true });
    const row = db.prepare(`SELECT * FROM mod_logs WHERE guild_id = ? AND id = ?`).get(interaction.guildId, Number(id));
    if (!row) return interaction.reply({ content: 'Moderation log not found.', ephemeral: true });
    if (row.status !== 'pending') return interaction.reply({ content: `That moderation log is **${row.status}**.`, ephemeral: true });

    db.prepare(`
      UPDATE mod_logs
      SET status = 'approved', approved_by = ?, approved_at = ?
      WHERE id = ?
    `).run(interaction.user.id, Date.now(), row.id);

    const updated = db.prepare(`SELECT * FROM mod_logs WHERE id = ?`).get(row.id);
    const embed = buildModLogEmbed(updated, 'Approved');
    const rowButtons = buildButtonRow('mod', row.id, true);
    await interaction.update({ embeds: [embed], components: [rowButtons] });
    return;
  }

  if (kind === 'mod_deny') {
    if (!staffOk) return interaction.reply({ content: 'Only staff can deny moderation logs.', ephemeral: true });
    const row = db.prepare(`SELECT * FROM mod_logs WHERE guild_id = ? AND id = ?`).get(interaction.guildId, Number(id));
    if (!row) return interaction.reply({ content: 'Moderation log not found.', ephemeral: true });
    if (row.status !== 'pending') return interaction.reply({ content: `That moderation log is **${row.status}**.`, ephemeral: true });
    return sendDeniedModal(interaction, 'mod', id);
  }
}

async function handleModal(interaction) {
  const settings = getGuildSettings(interaction.guildId);
  const [kind, id] = interaction.customId.split(':');
  const reason = interaction.fields.getTextInputValue('reason').trim();
  const staffOk = isStaff(interaction.member, settings);

  if (!staffOk) {
    return interaction.reply({ content: 'Only staff can submit denial reasons.', ephemeral: true });
  }

  if (kind === 'mass_deny_reason') {
    const row = loadMassById(interaction.guildId, id);
    if (!row) return interaction.reply({ content: 'Mass not found.', ephemeral: true });

    db.prepare(`
      UPDATE mass_sessions
      SET status = 'denied', denied_by = ?, denied_at = ?, denial_reason = ?
      WHERE id = ?
    `).run(interaction.user.id, Date.now(), reason, row.id);

    const updated = loadMassById(interaction.guildId, row.id);
    const embed = buildMassEmbed(updated, settings, 'Denied');
    const rowButtons = buildButtonRow('mass', row.id, true);
    await interaction.reply({ content: 'Mass log denied.', ephemeral: true });
    await editApprovalMessage(interaction.guild, updated.approval_channel_id, updated.approval_message_id, embed, [rowButtons]);
    return;
  }

  if (kind === 'mod_deny_reason') {
    const row = db.prepare(`SELECT * FROM mod_logs WHERE guild_id = ? AND id = ?`).get(interaction.guildId, Number(id));
    if (!row) return interaction.reply({ content: 'Moderation log not found.', ephemeral: true });

    db.prepare(`
      UPDATE mod_logs
      SET status = 'denied', denied_by = ?, denied_at = ?, denial_reason = ?
      WHERE id = ?
    `).run(interaction.user.id, Date.now(), reason, row.id);

    const updated = db.prepare(`SELECT * FROM mod_logs WHERE id = ?`).get(row.id);
    const embed = buildModLogEmbed(updated, 'Denied');
    const rowButtons = buildButtonRow('mod', row.id, true);
    await interaction.reply({ content: 'Moderation log denied.', ephemeral: true });
    await editApprovalMessage(interaction.guild, updated.approval_channel_id, updated.approval_message_id, embed, [rowButtons]);
    return;
  }
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{
      name: "Vatican Systems",
      type: 3
    }],
    status: "online"
  });
});
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      if (name === 'setup') {
        return handleSetup(interaction);
      }
      if (name === 'register') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') return handleRegister(interaction, true);
        if (sub === 'remove') return handleRegister(interaction, false);
        if (sub === 'list') return handleRegisterList(interaction);
      }
      if (name === 'staff') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') return handleStaff(interaction, true);
        if (sub === 'remove') return handleStaff(interaction, false);
        if (sub === 'list') return handleStaffList(interaction);
      }
      if (name === 'mass') {
        const sub = interaction.options.getSubcommand();
        return handleMass(interaction, sub);
      }
      if (name === 'shift') {
        const sub = interaction.options.getSubcommand();
        return handleShift(interaction, sub);
      }
      if (name === 'modlog') {
        const sub = interaction.options.getSubcommand();
        return handleModLog(interaction, sub);
      }
      if (name === 'leaderboard') {
        return handleLeaderboard(interaction);
      }
      if (name === 'payroll') {
        return handlePayroll(interaction);
      }
    }

    if (interaction.isButton()) {
      return handleButton(interaction);
    }

    if (interaction.isModalSubmit()) {
      return handleModal(interaction);
    }
  } catch (err) {
    console.error(err);
    const msg = 'Something went wrong while processing that command.';
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, ephemeral: true }).catch(() => null);
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => null);
    }
    }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  throw new Error('Missing DISCORD_TOKEN in .env');
}

client.login(token);

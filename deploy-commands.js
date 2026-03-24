require('dotenv').config();
const { REST, Routes } = require('discord.js');
const commands = require('./commands');

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID; // Optional, but strongly recommended while testing

  if (!token || !clientId) {
    throw new Error('Missing DISCORD_TOKEN or CLIENT_ID in .env');
  }

  const rest = new REST({ version: '10' }).setToken(token);

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`Deployed ${commands.length} guild commands to ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`Deployed ${commands.length} global commands`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

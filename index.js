require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus,
  StreamType
} = require('@discordjs/voice');

const path = require('path');
const http = require('http');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');

// 🛠️ FIXED: Tell prism-media (used internally by @discordjs/voice) where to find ffmpeg
// Without this, StreamType.Arbitrary conversion may fail silently on Render
if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

const MAX_JOIN_RETRIES = parseInt(process.env.MAX_JOIN_RETRIES, 10) || 3;
const JOIN_STAGGER_MS = parseInt(process.env.JOIN_STAGGER_MS, 10) || 300;
const JOIN_CONCURRENCY = parseInt(process.env.JOIN_CONCURRENCY, 10) || 3;
const joinQueue = [];
const activeJoinTasks = new Set();
let joinQueueProcessing = false;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const processJoinQueue = async () => {
  if (joinQueueProcessing) return;
  joinQueueProcessing = true;
  while (joinQueue.length > 0 || activeJoinTasks.size > 0) {
    while (joinQueue.length > 0 && activeJoinTasks.size < JOIN_CONCURRENCY) {
      const task = joinQueue.shift();
      const promise = task().catch(err => console.error('[JoinQueue] task failed:', err?.message || err)).finally(() => {
        activeJoinTasks.delete(promise);
      });
      activeJoinTasks.add(promise);
      if (JOIN_STAGGER_MS > 0) await sleep(JOIN_STAGGER_MS);
    }
    if (activeJoinTasks.size > 0) {
      await Promise.race(activeJoinTasks);
    }
  }
  joinQueueProcessing = false;
};

const enqueueJoinTask = (task) => {
  joinQueue.push(task);
  if (!joinQueueProcessing) {
    void processJoinQueue();
  }
};

require('opusscript');
require('libsodium-wrappers');

// Health check
const PORT = process.env.PORT || 8080;
const healthServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('10 Bots - Nuclear Stacked');
});

healthServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[Health] Port ${PORT} in use; skipping health server.`);
  } else {
    console.error('[Health] Server error:', err);
  }
});

healthServer.listen(PORT, () => {
  console.log(`[Health] Listening on port ${PORT}`);
});

const tokens = Object.entries(process.env)
  .filter(([key, value]) => /^TOKEN\d+$/i.test(key) && value)
  .sort((a, b) => {
    const aIndex = parseInt(a[0].match(/\d+/)[0], 10);
    const bIndex = parseInt(b[0].match(/\d+/)[0], 10);
    return aIndex - bIndex;
  })
  .map(([, value]) => value);

if (!tokens.length) {
  throw new Error('No TOKEN environment variables found. Please set TOKEN1, TOKEN2, ...');
}

console.log(`Starting ${tokens.length} bots in NUCLEAR STACKED mode...`);

let sharedChstStartTime = 0;
const getSharedChstStartTime = () => {
  if (sharedChstStartTime <= Date.now()) {
    sharedChstStartTime = Date.now() + 1500;
  }
  return sharedChstStartTime;
};

tokens.forEach((token, index) => {
  const botNum = index + 1;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates
    ]
  });

  const slashCommands = [
    { name: 'bkva', description: 'Make the bot join your voice channel' },
    { name: 'bkst', description: 'Start audio playback (10x repeat)' },
    { name: 'bksp', description: 'Stop audio playback' },
    { name: 'bklv', description: 'Leave the voice channel' }
  ];

  let connection;
  let player;
  let stopRequested = false;
  let isJoining = false;
  let audioPlayCount = 0;
  let maxAudioPlays = 10;
  let playbackTimeout = null;

  // FIXED: Use PCM format for reliable playback - discord.js handles raw PCM natively
  const audioPath = path.join(__dirname, `BOOGEYMAN.KX4.DARK.AUDIO.${botNum}.pcm`);

  // 🛠️ FIXED: Setup player once with event listeners
  // subscribe() is called BEFORE play() — correct order
  // Error retries after 1 second, Idle creates fresh resource and loops
  const setupPlayer = () => {
    if (player) {
      try { player.stop(true); } catch (e) {}
      player.removeAllListeners();
    }
    player = createAudioPlayer();
    player.on('error', err => {
      console.error(`[Bot ${botNum}] AUDIO PLAYER ERROR:`, err.message);
      if (!stopRequested) {
        setTimeout(() => playTrack(), 1000);
      }
    });
    player.on('stateChange', (o, n) => {
      console.log(`[Bot ${botNum}] PLAYER STATE: ${o.status} -> ${n.status}`);
      if (n.status === AudioPlayerStatus.Idle && !stopRequested) {
        // 🛠️ FIXED: Always create fresh resource on Idle and replay
        setTimeout(() => playTrack(), 100);
      }
    });
    // Subscribe BEFORE playing — critical for audio to reach Discord
    connection.subscribe(player);
  };

  // 🛠️ FIXED: Creates a fresh resource each time, then plays it on the existing player
  const playTrack = () => {
    if (stopRequested) return;
    if (audioPlayCount >= maxAudioPlays) {
      console.log(`[Bot ${botNum}] 🔥 BOOGEYMAN COMPLETE - ${maxAudioPlays} plays finished`);
      return;
    }
    audioPlayCount++;
    console.log(`[Bot ${botNum}] 🔊 BOOGEYMAN PLAYING (${audioPlayCount}/${maxAudioPlays})`);

    try {
      // Verify file exists before creating stream
      if (!fs.existsSync(audioPath)) {
        console.error(`[Bot ${botNum}] Audio file not found: ${audioPath}`);
        return;
      }
      
      // Create a FRESH resource every time — old resource becomes unreadable after one play
      const stream = fs.createReadStream(audioPath);
      // FIXED: Let discord.js auto-detect the format - works for MP3 and other formats
      const resource = createAudioResource(stream);
      player.play(resource);
    } catch (err) {
      console.error(`[Bot ${botNum}] playTrack error:`, err?.message || err);
      if (!stopRequested) {
        setTimeout(() => playTrack(), 1000);
      }
    }
  };

  const startPlayback = () => {
    if (!connection) {
      console.error(`[Bot ${botNum}] startPlayback called without a voice connection`);
      return;
    }
    stopRequested = false;
    audioPlayCount = 0;
    setupPlayer();
    playTrack();
  };

  const safeDestroy = (conn) => {
    try {
      if (!conn) return;
      const status = conn.state && conn.state.status;
      if (status && status !== VoiceConnectionStatus.Destroyed) {
        conn.destroy();
      }
    } catch (e) {
      // ignore double-destroy or other race errors
    }
  };

  const attemptJoinVoiceChannel = async (vc, guild, reply, attempt = 1) => {
    try {
      if (connection) {
        safeDestroy(connection);
        connection = null;
      }

      connection = joinVoiceChannel({
        channelId: vc.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        group: client.user.id
      });

      connection.on('error', err => {
        console.error(`[Bot ${botNum}] VOICE CONNECTION ERROR:`, err?.message || err);
        try { safeDestroy(connection); } catch (e) {}
      });
      connection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`[Bot ${botNum}] VOICE READY`);
      });
      connection.on(VoiceConnectionStatus.Disconnected, (oldState, newState) => {
        console.log(`[Bot ${botNum}] VOICE DISCONNECTED ${oldState.status} -> ${newState.status}`);
        stopRequested = true;
        if (player) {
          try { player.stop(true); } catch (e) {}
          player.removeAllListeners();
          player = null;
        }
      });
      connection.on(VoiceConnectionStatus.Destroyed, () => {
        console.log(`[Bot ${botNum}] VOICE DESTROYED`);
        stopRequested = true;
        if (player) {
          try { player.stop(true); } catch (e) {}
          player.removeAllListeners();
          player = null;
        }
      });
      connection.on('stateChange', (oldState, newState) => {
        console.log(`[Bot ${botNum}] VOICE STATE: ${oldState.status} -> ${newState.status}`);
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 25000);
      console.log(`[Bot ${botNum}] JOINED ✅`);
      await reply('✅ Joined your voice channel.');
    } catch (err) {
      console.error(`[Bot ${botNum}] JOIN ERROR attempt ${attempt}:`, err?.message || err);
      safeDestroy(connection);
      connection = null;
      if (attempt < MAX_JOIN_RETRIES) {
        const retryDelay = 1500 * attempt;
        console.log(`[Bot ${botNum}] Retrying join in ${retryDelay}ms (attempt ${attempt + 1}/${MAX_JOIN_RETRIES})`);
        await sleep(retryDelay);
        return attemptJoinVoiceChannel(vc, guild, reply, attempt + 1);
      }
      await reply('❌ Failed to join voice channel after multiple attempts.');
    } finally {
      if (attempt === 1) {
        isJoining = false;
      }
    }
  };

  // Parse allowed role IDs from env (comma-separated)
  const allowedRoleIds = (process.env.ALLOWED_ROLE_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);

  const handleBotCommand = async (commandName, reply, guild, member) => {
    if (!guild || !member) return reply('Command failed: missing guild or member data.');

    // Access check: allow Administrators OR members with at least one allowed role
    const isAdmin = member.permissions.has('Administrator');
    const hasAllowedRole = allowedRoleIds.length > 0 &&
      allowedRoleIds.some(roleId => member.roles.cache.has(roleId));

    if (!isAdmin && !hasAllowedRole) {
      if (allowedRoleIds.length === 0) {
        return reply('❌ You need **Administrator** permissions to use this command.');
      }
      const roleMentions = allowedRoleIds
        .map(id => `<@&${id}>`)
        .join(', ');
      return reply(`❌ You need **Administrator** permissions or one of these roles to use this command: ${roleMentions}`);
    }

    if (commandName === 'bkva') {
      if (isJoining) return reply('Already joining...');

      const vc = member.voice.channel;
      if (!vc) return reply('You need to be in a voice channel first.');

      isJoining = true;
      enqueueJoinTask(async () => {
        await attemptJoinVoiceChannel(vc, guild, reply);
      });

      return;
    }

    if (commandName === 'bkst') {
      if (!connection) return reply('Bot is not in a voice channel.');

      const botAudio = path.join(__dirname, `BOOGEYMAN.KX4.DARK.AUDIO.${botNum}.pcm`);
      if (!fs.existsSync(botAudio)) {
        return reply(`BOOGEYMAN PCM audio file ${botNum} not found.`);
      }

      // Align start time across bots for synchronized playback
      const startAt = getSharedChstStartTime();
      const delay = Math.max(100, startAt - Date.now());
      setTimeout(() => {
        try { startPlayback(); } catch (err) {
          console.error(`[Bot ${botNum}] startPlayback error:`, err?.message || err);
        }
      }, delay);

      return reply('🔥 BOOGEYMAN 10x REPEAT ACTIVATED');
    }

    if (commandName === 'bksp') {
      stopRequested = true;
      audioPlayCount = 0;
      if (player) {
        try { player.stop(true); } catch (e) {}
        player.removeAllListeners();
        player = null;
      }
      return reply('✅ Audio stopped.');
    }

    if (commandName === 'bklv') {
      stopRequested = true;
      if (player) {
        try { player.stop(true); } catch (e) {}
        player.removeAllListeners();
        player = null;
      }
      safeDestroy(connection);
      connection = null;
      return reply('✅ Left voice channel.');
    }

    if (commandName === 'status') {
      try {
        const connState = connection ? (connection.state && connection.state.status) : 'not connected';
        const channelId = connection && connection.joinConfig ? connection.joinConfig.channelId : (connection && connection.joining ? connection.joining.channelId : 'none');
        const playerState = player ? (player.state && player.state.status) : 'no player';
        const msg = `Connection: ${connState}\nChannel: ${channelId}\nPlayer: ${playerState}`;
        await reply(`

${msg}
`);
      } catch (e) {
        console.error(`[Bot ${botNum}] STATUS CMD ERROR:`, e.message);
        await reply('Failed to retrieve status.');
      }
      return;
    }

    return reply('Unknown command.');
  };

  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const content = message.content.trim().toLowerCase();
    if (!['!bkva', '!bkst', '!bksp', '!bklv', '!status'].includes(content)) return;

    const reply = async text => {
      if (botNum !== 1) return;
      try {
        await message.reply(text).catch(() => {});
      } catch (err) {
        // ignore reply error
      }
    };

    await handleBotCommand(content.slice(1), reply, message.guild, message.member);
  });

  client.on('ready', async () => {
    console.log(`[Bot ${botNum}] ONLINE ✅`);

    try {
      if (client.application && client.application.commands && typeof client.application.commands.set === 'function') {
        await client.application.commands.set(slashCommands);
        console.log(`[Bot ${botNum}] Registered global slash commands`);
      } else {
        const guilds = await client.guilds.fetch();
        for (const [guildId, guild] of guilds) {
          if (guild && guild.commands && typeof guild.commands.set === 'function') {
            await guild.commands.set(slashCommands);
          }
        }
        console.log(`[Bot ${botNum}] Registered slash commands in ${guilds.size} guild(s)`);
      }
    } catch (err) {
      console.error(`[Bot ${botNum}] SLASH COMMAND REGISTRATION FAILED: ${err.message}`);
    }

    // Auto-join and auto-start playback when environment variables are set.
    try {
      const envChannel = process.env[`AUTO_JOIN_CHANNEL_ID_${botNum}`] || process.env.AUTO_JOIN_CHANNEL_ID;
      if (envChannel) {
        try {
          const targetChannel = await client.channels.fetch(envChannel).catch(() => null);
          if (!targetChannel || !targetChannel.isVoiceBased && !targetChannel.isStageBased) {
            console.warn(`[Bot ${botNum}] AUTO_JOIN: channel ${envChannel} not found or not a voice channel`);
          } else {
            connection = joinVoiceChannel({
              channelId: targetChannel.id,
              guildId: targetChannel.guild.id,
              adapterCreator: targetChannel.guild.voiceAdapterCreator,
              selfDeaf: true,
              group: client.user.id
            });
            connection.on('error', err => {
              console.error(`[Bot ${botNum}] AUTO VOICE CONNECTION ERROR:`, err?.message || err);
              try { safeDestroy(connection); } catch (e) {}
            });
            console.log(`[Bot ${botNum}] AUTO JOINED channel ${envChannel}`);
            try {
              await entersState(connection, VoiceConnectionStatus.Ready, 15000);
              console.log(`[Bot ${botNum}] AUTO VOICE READY`);
              startPlayback();
            } catch (err) {
              console.error(`[Bot ${botNum}] AUTO startPlayback failed:`, err?.message || err);
            }
          }
        } catch (e) {
          console.error(`[Bot ${botNum}] AUTO_JOIN error:`, e.message);
        }
      }
    } catch (e) {
      // ignore
    }
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.bot) return;

    const reply = async (content) => {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    };

    await handleBotCommand(interaction.commandName, reply, interaction.guild, interaction.member);
  });

  client.login(token).catch(err => {
    console.error(`[Bot ${botNum}] LOGIN FAILED: ${err.message}`);
    if (err.code) console.error(`[Bot ${botNum}] ERROR CODE: ${err.code}`);
  });
});